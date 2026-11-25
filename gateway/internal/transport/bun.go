package transport

import (
	"bufio"
	"compress/flate"
	"compress/gzip"
	"context"
	"errors"
	"io"
	"net"
	"net/http"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/andybalholm/brotli"
	"github.com/klauspost/compress/zstd"
	utls "github.com/refraction-networking/utls"
)

const (
	bunVersion           = "1.4.3"
	bunHandshakeTimeout  = 10 * time.Second
	bunHeaderReadTimeout = 300 * time.Second
)

// bunCommonHeaders are the headers WebKit knows by name, in the spelling and
// order Bun's fetch writes them. Header order is visible to the upstream TLS
// fingerprint, so this list is part of the transport contract.
var bunCommonHeaders = []string{
	"Accept", "Accept-Charset", "Accept-Encoding", "Accept-Language", "Authorization", "Cache-Control",
	"Connection", "Content-Encoding", "Content-Language", "Content-Length", "Content-Type", "Cookie", "DNT",
	"Expect", "Host", "If-None-Match", "Keep-Alive", "Last-Event-Id", "Origin", "Pragma",
	"Proxy-Authorization", "Range", "Referer", "Sec-Fetch-Mode", "TE", "Upgrade-Insecure-Requests",
	"User-Agent",
}

type bunTransport struct {
	dialContext        func(context.Context, string, string) (net.Conn, error)
	dialer             *net.Dialer
	insecureSkipVerify bool
	mu                 sync.Mutex
	idle               map[string][]*bunConn
}

type bunConn struct {
	net.Conn
	br     *bufio.Reader
	bw     *bufio.Writer
	key    string
	idleAt time.Time
}

func newBunTransport() *bunTransport {
	return &bunTransport{
		dialer: &net.Dialer{Timeout: 5 * time.Second, KeepAlive: 30 * time.Second},
		idle:   map[string][]*bunConn{},
	}
}

func (t *bunTransport) RoundTrip(req *http.Request) (*http.Response, error) {
	body, err := readBody(req)
	if err != nil {
		return nil, err
	}
	head, decompress, err := bunRequestHead(req, body)
	if err != nil {
		return nil, err
	}
	u := req.URL
	if u == nil || u.Host == "" || u.Scheme != "https" {
		return nil, errors.New("bun transport requires an https URL")
	}
	port := u.Port()
	if port == "" {
		port = "443"
	}
	addr := net.JoinHostPort(u.Hostname(), port)
	key := u.Scheme + "://" + addr

	conn, _, err := t.getConn(req.Context(), key, addr, u.Hostname())
	if err != nil {
		return nil, err
	}
	response, _, err := t.exchange(req.Context(), conn, req, head, body, decompress)
	if err != nil {
		return nil, err
	}
	return response, nil
}

func (t *bunTransport) getConn(ctx context.Context, key, addr, serverName string) (*bunConn, bool, error) {
	for {
		t.mu.Lock()
		idle := t.idle[key]
		if len(idle) == 0 {
			t.mu.Unlock()
			break
		}
		conn := idle[len(idle)-1]
		t.idle[key] = idle[:len(idle)-1]
		t.mu.Unlock()
		if conn.reclaim() {
			return conn, true, nil
		}
		_ = conn.Close()
	}
	var raw net.Conn
	var err error
	if t.dialContext != nil {
		raw, err = t.dialContext(ctx, "tcp", addr)
	} else {
		raw, err = t.dialer.DialContext(ctx, "tcp", addr)
	}
	if err != nil {
		return nil, false, err
	}
	tlsConn := utls.UClient(raw, &utls.Config{
		ServerName:         serverName,
		InsecureSkipVerify: t.insecureSkipVerify,
	}, utls.HelloCustom)
	if err := tlsConn.ApplyPreset(bunClientHello()); err != nil {
		_ = raw.Close()
		return nil, false, err
	}
	handshakeCtx, cancel := context.WithTimeout(ctx, bunHandshakeTimeout)
	defer cancel()
	if err := tlsConn.HandshakeContext(handshakeCtx); err != nil {
		_ = raw.Close()
		return nil, false, err
	}
	return &bunConn{
		Conn: tlsConn,
		br:   bufio.NewReader(tlsConn),
		bw:   bufio.NewWriter(tlsConn),
		key:  key,
	}, false, nil
}

func (t *bunTransport) putIdle(conn *bunConn) {
	conn.idleAt = time.Now()
	t.mu.Lock()
	t.idle[conn.key] = append(t.idle[conn.key], conn)
	t.mu.Unlock()
}

func (conn *bunConn) reclaim() bool {
	_ = conn.SetReadDeadline(time.Now().Add(time.Millisecond))
	_, err := conn.br.Peek(1)
	_ = conn.SetReadDeadline(time.Time{})
	if err == nil {
		return false
	}
	var netErr net.Error
	return errors.As(err, &netErr) && netErr.Timeout()
}

func (t *bunTransport) exchange(
	ctx context.Context,
	conn *bunConn,
	req *http.Request,
	head, body []byte,
	decompress bool,
) (*http.Response, bool, error) {
	stop := context.AfterFunc(ctx, func() { _ = conn.Close() })
	fail := func(err error, dropped bool) (*http.Response, bool, error) {
		stop()
		_ = conn.Close()
		return nil, dropped, err
	}

	if _, err := conn.bw.Write(head); err != nil {
		return fail(err, false)
	}
	if len(body) > 0 {
		if _, err := conn.bw.Write(body); err != nil {
			return fail(err, false)
		}
	}
	if err := conn.bw.Flush(); err != nil {
		return fail(err, false)
	}

	_ = conn.SetReadDeadline(time.Now().Add(bunHeaderReadTimeout))
	if _, err := conn.br.Peek(1); err != nil {
		return fail(err, isConnDropped(err))
	}
	response, err := http.ReadResponse(conn.br, req)
	for err == nil && response.StatusCode >= 100 && response.StatusCode < 200 && response.StatusCode != http.StatusSwitchingProtocols {
		response, err = http.ReadResponse(conn.br, req)
	}
	if err != nil {
		return fail(err, false)
	}
	_ = conn.SetReadDeadline(time.Time{})

	response.Body, err = decodeResponse(response, decompress)
	if err != nil {
		return fail(err, false)
	}
	stream := &bunBody{
		source:    response.Body,
		conn:      conn,
		transport: t,
		stop:      stop,
		reusable:  !req.Close && !response.Close && !strings.EqualFold(response.Header.Get("connection"), "close"),
	}
	response.Body = stream
	return response, false, nil
}

func readBody(req *http.Request) ([]byte, error) {
	if req.Body == nil || req.Body == http.NoBody {
		return nil, nil
	}
	defer req.Body.Close()
	return io.ReadAll(req.Body)
}

func isConnDropped(err error) bool {
	var opError *net.OpError
	if errors.As(err, &opError) {
		return errors.Is(opError.Err, io.EOF) || strings.Contains(opError.Err.Error(), "reset by peer")
	}
	return errors.Is(err, io.EOF)
}

func bunRequestHead(req *http.Request, body []byte) ([]byte, bool, error) {
	values := map[string]string{}
	for name, list := range req.Header {
		if len(list) == 0 {
			continue
		}
		for _, value := range list {
			if !validHeaderField(name, value) {
				return nil, false, errors.New("bun transport: invalid header field")
			}
		}
		lower := strings.ToLower(name)
		if _, forbidden := upstreamForbiddenHeaders[lower]; forbidden {
			continue
		}
		value := strings.Join(list, ", ")
		if previous, ok := values[lower]; ok {
			value = previous + ", " + value
		}
		values[lower] = value
	}
	if values["accept"] == "*/*" {
		delete(values, "accept")
	}

	_, hasUserAgent := values["user-agent"]
	_, hasAccept := values["accept"]
	_, hasEncoding := values["accept-encoding"]
	method := req.Method
	if method == "" {
		method = http.MethodGet
	}
	if !validHeaderField(method, "") {
		return nil, false, errors.New("bun transport: invalid request method")
	}
	requestURI := req.URL.RequestURI()
	for i := 0; i < len(requestURI); i++ {
		if requestURI[i] <= ' ' || requestURI[i] == 0x7f {
			return nil, false, errors.New("bun transport: invalid request URI")
		}
	}
	host := req.Host
	if host == "" {
		host = req.URL.Host
	}
	if host == "" || !validHeaderField("Host", host) || strings.ContainsAny(host, " \t/\\#?@") {
		return nil, false, errors.New("bun transport: invalid request host")
	}

	var head strings.Builder
	head.WriteString(method + " " + requestURI + " HTTP/1.1\r\n")
	wroteLength := false
	for _, name := range bunCommonHeaders {
		lower := strings.ToLower(name)
		if lower == "content-length" && body != nil {
			head.WriteString(name + ": " + strconv.Itoa(len(body)) + "\r\n")
			delete(values, lower)
			wroteLength = true
			continue
		}
		if value, ok := values[lower]; ok {
			head.WriteString(name + ": " + value + "\r\n")
			delete(values, lower)
		}
	}
	remaining := make([]string, 0, len(values))
	for name := range values {
		remaining = append(remaining, name)
	}
	sort.Strings(remaining)
	for _, name := range remaining {
		head.WriteString(name + ": " + values[name] + "\r\n")
	}
	head.WriteString("Connection: keep-alive\r\n")
	if !hasUserAgent {
		head.WriteString("User-Agent: Bun/" + bunVersion + "\r\n")
	}
	if !hasAccept {
		head.WriteString("Accept: */*\r\n")
	}
	host = strings.TrimSuffix(host, ":443")
	head.WriteString("Host: " + host + "\r\n")
	if !hasEncoding {
		head.WriteString("Accept-Encoding: gzip, deflate, br, zstd\r\n")
	}
	if len(body) > 0 && !wroteLength {
		head.WriteString("Content-Length: " + strconv.Itoa(len(body)) + "\r\n")
	}
	head.WriteString("\r\n")
	return []byte(head.String()), !hasEncoding, nil
}

func validHeaderField(name, value string) bool {
	if name == "" {
		return false
	}
	for i := 0; i < len(name); i++ {
		b := name[i]
		if b <= ' ' || b >= 0x7f || strings.ContainsRune(`"(),/:;<=>?@[\]{}`, rune(b)) {
			return false
		}
	}
	for i := 0; i < len(value); i++ {
		b := value[i]
		if (b < ' ' && b != '\t') || b == 0x7f {
			return false
		}
	}
	return true
}

func decodeResponse(response *http.Response, decompress bool) (io.ReadCloser, error) {
	if !decompress {
		return response.Body, nil
	}
	encoding := strings.ToLower(response.Header.Get("content-encoding"))
	var reader io.Reader
	switch encoding {
	case "", "identity":
		return response.Body, nil
	case "gzip":
		decoder, err := gzip.NewReader(response.Body)
		if err != nil {
			return nil, err
		}
		reader = decoder
	case "deflate":
		reader = flate.NewReader(response.Body)
	case "br":
		reader = brotli.NewReader(response.Body)
	case "zstd":
		decoder, err := zstd.NewReader(response.Body, zstd.WithDecoderConcurrency(1), zstd.WithDecoderMaxWindow(8<<20))
		if err != nil {
			return nil, err
		}
		reader = decoder
	default:
		return response.Body, nil
	}
	response.Header.Del("content-encoding")
	response.Header.Del("content-length")
	response.Uncompressed = true
	return io.NopCloser(reader), nil
}

type bunBody struct {
	source    io.ReadCloser
	conn      *bunConn
	transport *bunTransport
	stop      func() bool
	once      sync.Once
	reusable  bool
}

func (body *bunBody) Read(p []byte) (int, error) {
	n, err := body.source.Read(p)
	if err == io.EOF {
		body.finish(true)
	}
	return n, err
}

func (body *bunBody) Close() error {
	err := body.source.Close()
	body.finish(false)
	return err
}

func (body *bunBody) finish(eof bool) {
	body.once.Do(func() {
		body.stop()
		if body.reusable && eof {
			body.transport.putIdle(body.conn)
			return
		}
		_ = body.conn.Close()
	})
}

// bunClientHello mirrors the ClientHello of Bun 1.4.3 fetch: TLS 1.3 with the
// BoringSSL suite order, no GREASE, only http/1.1 in ALPN, and X25519MLKEM768
// as the first key share. Every connection needs a fresh spec because uTLS
// keeps handshake state inside it.
func bunClientHello() *utls.ClientHelloSpec {
	return &utls.ClientHelloSpec{
		TLSVersMin: utls.VersionTLS12,
		TLSVersMax: utls.VersionTLS13,
		CipherSuites: []uint16{
			utls.TLS_AES_128_GCM_SHA256,
			utls.TLS_AES_256_GCM_SHA384,
			utls.TLS_CHACHA20_POLY1305_SHA256,
			utls.TLS_ECDHE_ECDSA_WITH_AES_128_GCM_SHA256,
			utls.TLS_ECDHE_RSA_WITH_AES_128_GCM_SHA256,
			utls.TLS_ECDHE_ECDSA_WITH_AES_256_GCM_SHA384,
			utls.TLS_ECDHE_RSA_WITH_AES_256_GCM_SHA384,
			utls.TLS_ECDHE_ECDSA_WITH_CHACHA20_POLY1305_SHA256,
			utls.TLS_ECDHE_RSA_WITH_CHACHA20_POLY1305_SHA256,
			utls.TLS_ECDHE_ECDSA_WITH_AES_128_CBC_SHA,
			utls.TLS_ECDHE_RSA_WITH_AES_128_CBC_SHA,
			utls.TLS_ECDHE_ECDSA_WITH_AES_256_CBC_SHA,
			utls.TLS_ECDHE_RSA_WITH_AES_256_CBC_SHA,
			utls.TLS_RSA_WITH_AES_128_GCM_SHA256,
			utls.TLS_RSA_WITH_AES_256_GCM_SHA384,
			utls.TLS_RSA_WITH_AES_128_CBC_SHA,
			utls.TLS_RSA_WITH_AES_256_CBC_SHA,
		},
		CompressionMethods: []uint8{0},
		Extensions: []utls.TLSExtension{
			&utls.SNIExtension{},
			&utls.ExtendedMasterSecretExtension{},
			&utls.RenegotiationInfoExtension{Renegotiation: utls.RenegotiateOnceAsClient},
			&utls.SupportedCurvesExtension{Curves: []utls.CurveID{utls.X25519MLKEM768, utls.X25519, utls.CurveP256, utls.CurveP384}},
			&utls.SupportedPointsExtension{SupportedPoints: []uint8{0}},
			&utls.SessionTicketExtension{},
			&utls.ALPNExtension{AlpnProtocols: []string{"http/1.1"}},
			&utls.StatusRequestExtension{},
			&utls.SignatureAlgorithmsExtension{SupportedSignatureAlgorithms: []utls.SignatureScheme{
				utls.ECDSAWithP256AndSHA256,
				utls.PSSWithSHA256,
				utls.PKCS1WithSHA256,
				utls.ECDSAWithP384AndSHA384,
				utls.PSSWithSHA384,
				utls.PKCS1WithSHA384,
				utls.PSSWithSHA512,
				utls.PKCS1WithSHA512,
				utls.PKCS1WithSHA1,
			}},
			&utls.SCTExtension{},
			&utls.KeyShareExtension{KeyShares: []utls.KeyShare{{Group: utls.X25519MLKEM768}, {Group: utls.X25519}}},
			&utls.PSKKeyExchangeModesExtension{Modes: []uint8{utls.PskModeDHE}},
			&utls.SupportedVersionsExtension{Versions: []uint16{utls.VersionTLS13, utls.VersionTLS12}},
		},
	}
}
