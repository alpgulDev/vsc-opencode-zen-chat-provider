package transport

import (
	"bufio"
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"io"
	"math/big"
	"net"
	"net/http"
	"strconv"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

func TestRoundTripReusesOneBunConnection(t *testing.T) {
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	template := x509.Certificate{
		SerialNumber: big.NewInt(1),
		Subject:      pkix.Name{CommonName: "opencode.ai"},
		DNSNames:     []string{"opencode.ai"},
		NotBefore:    time.Now().Add(-time.Hour),
		NotAfter:     time.Now().Add(time.Hour),
		KeyUsage:     x509.KeyUsageDigitalSignature | x509.KeyUsageKeyEncipherment,
		ExtKeyUsage:  []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth},
	}
	der, err := x509.CreateCertificate(rand.Reader, &template, &template, &key.PublicKey, key)
	if err != nil {
		t.Fatal(err)
	}
	certificate := tls.Certificate{Certificate: [][]byte{der}, PrivateKey: key}

	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer listener.Close()

	var connections atomic.Int64
	go func() {
		for {
			raw, err := listener.Accept()
			if err != nil {
				return
			}
			connections.Add(1)
			go func() {
				conn := tls.Server(raw, &tls.Config{Certificates: []tls.Certificate{certificate}})
				defer conn.Close()
				reader := bufio.NewReader(conn)
				for {
					request, err := http.ReadRequest(reader)
					if err != nil {
						return
					}
					_, _ = io.Copy(io.Discard, request.Body)
					_ = request.Body.Close()
					if _, err := io.WriteString(conn, "HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: keep-alive\r\n\r\nok"); err != nil {
						return
					}
				}
			}()
		}
	}()

	port := listener.Addr().(*net.TCPAddr).Port
	transport := &bunTransport{
		dialer:             &net.Dialer{Timeout: time.Second},
		insecureSkipVerify: true,
		dialContext: func(_ context.Context, _, _ string) (net.Conn, error) {
			return net.Dial("tcp", listener.Addr().String())
		},
		idle: map[string][]*bunConn{},
	}
	target := "https://opencode.ai:" + strconv.Itoa(port) + "/inference/go/openai/v1/chat/completions"
	for i := 0; i < 2; i++ {
		request, err := http.NewRequest(http.MethodPost, target, strings.NewReader(`{"model":"m"}`))
		if err != nil {
			t.Fatal(err)
		}
		request.Header.Set("content-type", "application/json")
		request.Header.Set("user-agent", "opencode/latest/2.4.1/cli")
		response, err := transport.RoundTrip(request)
		if err != nil {
			t.Fatalf("request %d failed: %v", i+1, err)
		}
		body, err := io.ReadAll(response.Body)
		_ = response.Body.Close()
		if err != nil {
			t.Fatal(err)
		}
		if string(body) != "ok" {
			t.Fatalf("unexpected response body %q", string(body))
		}
	}
	if got := connections.Load(); got != 1 {
		t.Fatalf("expected one reused connection, got %d", got)
	}
}
