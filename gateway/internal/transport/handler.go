package transport

import (
	"bytes"
	"crypto/subtle"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
)

const maxRequestBody = 32 << 20

var upstreamForbiddenHeaders = map[string]bool{
	"connection":          true,
	"content-length":      true,
	"host":                true,
	"keep-alive":          true,
	"proxy-authorization": true,
	"proxy-connection":    true,
	"te":                  true,
	"trailer":             true,
	"transfer-encoding":   true,
	"upgrade":             true,
}

// NewHandler returns the loopback HTTP handler. key is the shared secret the
// extension uses on every local request; the upstream Authorization header is
// carried per request and never written to the config file.
func NewHandler(key string) (http.Handler, error) {
	if len(key) < 32 {
		return nil, errors.New("transport key is too short")
	}
	return &handler{key: key, upstream: newBunTransport()}, nil
}

type handler struct {
	key      string
	upstream *bunTransport
}

func (h *handler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	switch r.URL.Path {
	case "/healthz":
		if r.Method != http.MethodGet {
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}
		w.WriteHeader(http.StatusOK)
		_, _ = io.WriteString(w, "ok")
	case "/forward":
		h.forward(w, r)
	default:
		http.NotFound(w, r)
	}
}

func (h *handler) forward(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	if !authorized(r.Header.Get("authorization"), h.key) {
		http.Error(w, "unauthorized", http.StatusUnauthorized)
		return
	}

	target := r.Header.Get("x-zen-target")
	if err := validateTarget(target); err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	upstreamAuthorization := r.Header.Get("x-zen-upstream-authorization")
	if upstreamAuthorization == "" {
		http.Error(w, "missing upstream credential", http.StatusBadRequest)
		return
	}

	upstreamHeaders := map[string]string{}
	if raw := r.Header.Get("x-zen-upstream-headers"); raw != "" {
		if err := json.Unmarshal([]byte(raw), &upstreamHeaders); err != nil {
			http.Error(w, "invalid upstream headers", http.StatusBadRequest)
			return
		}
	}

	body, err := io.ReadAll(io.LimitReader(r.Body, maxRequestBody+1))
	if err != nil {
		http.Error(w, "unreadable request body", http.StatusBadRequest)
		return
	}
	if len(body) > maxRequestBody {
		http.Error(w, "request body is too large", http.StatusRequestEntityTooLarge)
		return
	}

	upstreamRequest, err := http.NewRequestWithContext(r.Context(), http.MethodPost, target, bytes.NewReader(body))
	if err != nil {
		http.Error(w, "invalid upstream request", http.StatusBadRequest)
		return
	}
	for name, value := range upstreamHeaders {
		lower := strings.ToLower(name)
		if upstreamForbiddenHeaders[lower] || !validHeaderField(name, value) {
			continue
		}
		upstreamRequest.Header.Set(name, value)
	}
	upstreamRequest.Header.Set("authorization", upstreamAuthorization)

	response, err := h.upstream.RoundTrip(upstreamRequest)
	if err != nil {
		http.Error(w, fmt.Sprintf("upstream request failed: %v", err), http.StatusBadGateway)
		return
	}
	defer response.Body.Close()

	for name, values := range response.Header {
		for _, value := range values {
			w.Header().Add(name, value)
		}
	}
	w.WriteHeader(response.StatusCode)
	_, _ = io.Copy(w, response.Body)
}

func authorized(header, key string) bool {
	const prefix = "Bearer "
	if !strings.HasPrefix(header, prefix) {
		return false
	}
	return subtle.ConstantTimeCompare([]byte(strings.TrimPrefix(header, prefix)), []byte(key)) == 1
}

func validateTarget(raw string) error {
	parsed, err := url.Parse(raw)
	if err != nil {
		return errors.New("invalid upstream target")
	}
	if parsed.Scheme != "https" || !strings.EqualFold(parsed.Hostname(), "opencode.ai") {
		return errors.New("upstream target must use https://opencode.ai")
	}
	if parsed.User != nil || parsed.Fragment != "" {
		return errors.New("upstream target contains unsupported components")
	}
	if port := parsed.Port(); port != "" && port != "443" {
		return errors.New("upstream target port must be 443")
	}
	path := parsed.Path
	if path != "/inference" && !strings.HasPrefix(path, "/inference/") && !strings.HasPrefix(path, "/zen") {
		return errors.New("upstream target path is not an OpenCode inference route")
	}
	return nil
}
