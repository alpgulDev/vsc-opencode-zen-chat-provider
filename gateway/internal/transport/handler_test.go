package transport

import (
	"context"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestForwardPreservesUpstreamAuthorization(t *testing.T) {
	authorizations := make(chan string, 1)
	upstream := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		authorizations <- r.Header.Get("authorization")
		w.Header().Set("content-type", "text/plain")
		_, _ = w.Write([]byte("ok"))
	}))
	defer upstream.Close()

	key := strings.Repeat("k", 64)
	handler := &handler{
		key: key,
		upstream: &bunTransport{
			dialer:             &net.Dialer{},
			insecureSkipVerify: true,
			dialContext: func(context.Context, string, string) (net.Conn, error) {
				return net.Dial("tcp", upstream.Listener.Addr().String())
			},
			idle: map[string][]*bunConn{},
		},
	}

	request := httptest.NewRequest(http.MethodPost, "http://127.0.0.1/forward", strings.NewReader(`{"model":"m"}`))
	request.Header.Set("authorization", "Bearer "+key)
	request.Header.Set("x-zen-target", "https://opencode.ai/inference/openai/v1/chat/completions")
	request.Header.Set("x-zen-upstream-authorization", "Bearer access-token")
	request.Header.Set("x-zen-upstream-headers", `{"content-type":"application/json","user-agent":"opencode/latest/2.4.1/cli"}`)

	response := httptest.NewRecorder()
	handler.forward(response, request)
	if response.Code != http.StatusOK {
		t.Fatalf("expected a successful forward, got %d: %s", response.Code, response.Body.String())
	}

	select {
	case got := <-authorizations:
		if got != "Bearer access-token" {
			t.Fatalf("upstream authorization was rewritten: got %q", got)
		}
	default:
		t.Fatal("upstream request was not received")
	}
}
