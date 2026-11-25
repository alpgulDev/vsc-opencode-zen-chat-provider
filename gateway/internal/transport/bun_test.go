package transport

import (
	"net/http"
	"net/url"
	"strings"
	"testing"

	utls "github.com/refraction-networking/utls"
)

func TestBunRequestHeadOrder(t *testing.T) {
	parsed, err := url.Parse("https://opencode.ai/inference/go/openai/v1/chat/completions")
	if err != nil {
		t.Fatal(err)
	}
	request := &http.Request{
		Method: http.MethodPost,
		URL:    parsed,
		Header: http.Header{
			"X-Session-Id":          []string{"ses_0123456789abABCDEFGHIJ"},
			"X-Opencode-Project":    []string{"0123456789abcdef0123456789abcdef01234567"},
			"Content-Type":          []string{"application/json"},
			"X-Opencode-Client":     []string{"cli"},
			"Authorization":         []string{"Bearer access"},
			"Accept":                []string{"text/event-stream"},
			"User-Agent":            []string{"opencode/latest/2.4.1/cli"},
			"X-Opencode-Session-Id": []string{"ses_0123456789abABCDEFGHIJ"},
		},
	}
	body := []byte(`{"model":"m"}`)
	head, decompress, err := bunRequestHead(request, body)
	if err != nil {
		t.Fatal(err)
	}
	if !decompress {
		t.Fatal("expected the transport to add Accept-Encoding")
	}

	expected := "POST /inference/go/openai/v1/chat/completions HTTP/1.1\r\n" +
		"Accept: text/event-stream\r\n" +
		"Authorization: Bearer access\r\n" +
		"Content-Length: 13\r\n" +
		"Content-Type: application/json\r\n" +
		"User-Agent: opencode/latest/2.4.1/cli\r\n" +
		"x-opencode-client: cli\r\n" +
		"x-opencode-project: 0123456789abcdef0123456789abcdef01234567\r\n" +
		"x-opencode-session-id: ses_0123456789abABCDEFGHIJ\r\n" +
		"x-session-id: ses_0123456789abABCDEFGHIJ\r\n" +
		"Connection: keep-alive\r\n" +
		"Host: opencode.ai\r\n" +
		"Accept-Encoding: gzip, deflate, br, zstd\r\n" +
		"\r\n"
	if string(head) != expected {
		t.Fatalf("unexpected request head:\ngot:\n%q\nwant:\n%q", string(head), expected)
	}
}

func TestValidateTargetOnlyAllowsOfficialInferenceRoutes(t *testing.T) {
	valid := []string{
		"https://opencode.ai/inference/openai/v1/chat/completions",
		"https://opencode.ai/inference/go/openai/v1/chat/completions",
		"https://opencode.ai/inference/go/anthropic/v1/messages",
		"https://opencode.ai/zen/v1/chat/completions",
	}
	for _, target := range valid {
		if err := validateTarget(target); err != nil {
			t.Errorf("expected %q to be valid: %v", target, err)
		}
	}
	invalid := []string{
		"http://opencode.ai/inference/openai/v1/chat/completions",
		"https://evil.example/inference/openai/v1/chat/completions",
		"https://opencode.ai.evil.example/inference/openai",
		"https://user:pass@opencode.ai/inference/openai",
		"https://opencode.ai:8443/inference/openai",
		"https://opencode.ai/other",
	}
	for _, target := range invalid {
		if err := validateTarget(target); err == nil {
			t.Errorf("expected %q to be rejected", target)
		}
	}
}

func TestAuthorizedUsesConstantTimeBearerComparison(t *testing.T) {
	key := strings.Repeat("a", 64)
	if !authorized("Bearer "+key, key) {
		t.Fatal("expected matching key to authorize")
	}
	if authorized("Bearer "+key+"x", key) {
		t.Fatal("expected longer key to be rejected")
	}
	if authorized(key, key) {
		t.Fatal("expected missing Bearer prefix to be rejected")
	}
}

func TestBunClientHelloMatchesOfficialFingerprintShape(t *testing.T) {
	spec := bunClientHello()
	if spec.TLSVersMin != utls.VersionTLS12 || spec.TLSVersMax != utls.VersionTLS13 {
		t.Fatal("unexpected TLS version range")
	}
	if len(spec.CipherSuites) != 17 {
		t.Fatalf("unexpected cipher suite count: %d", len(spec.CipherSuites))
	}
	if spec.CipherSuites[0] != utls.TLS_AES_128_GCM_SHA256 {
		t.Fatal("unexpected first cipher suite")
	}
	var alpn *utls.ALPNExtension
	var curves *utls.SupportedCurvesExtension
	var keyshare *utls.KeyShareExtension
	for _, extension := range spec.Extensions {
		switch value := extension.(type) {
		case *utls.ALPNExtension:
			alpn = value
		case *utls.SupportedCurvesExtension:
			curves = value
		case *utls.KeyShareExtension:
			keyshare = value
		}
	}
	if alpn == nil || len(alpn.AlpnProtocols) != 1 || alpn.AlpnProtocols[0] != "http/1.1" {
		t.Fatal("ALPN must offer only http/1.1")
	}
	if curves == nil || len(curves.Curves) == 0 || curves.Curves[0] != utls.X25519MLKEM768 {
		t.Fatal("X25519MLKEM768 must be the first supported curve")
	}
	if keyshare == nil || len(keyshare.KeyShares) == 0 || keyshare.KeyShares[0].Group != utls.X25519MLKEM768 {
		t.Fatal("X25519MLKEM768 must be the first key share")
	}
}
