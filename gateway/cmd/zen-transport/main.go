// Command zen-transport is the extension-owned, Bun-compatible HTTP transport.
// It accepts already-shaped chat requests on loopback and sends them upstream
// with the TLS and HTTP/1.1 layout of the official OpenCode CLI.
package main

import (
	"context"
	"encoding/json"
	"errors"
	"flag"
	"log"
	"net/http"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"

	"opencode-zen-transport/internal/transport"
)

type config struct {
	Listen string `json:"listen"`
	Key    string `json:"key"`
}

func main() {
	configPath := flag.String("config", "", "path to the extension-generated config.json")
	flag.Parse()
	if *configPath == "" {
		log.Fatal("-config is required")
	}

	cfg, err := loadConfig(*configPath)
	if err != nil {
		log.Fatal(err)
	}
	handler, err := transport.NewHandler(cfg.Key)
	if err != nil {
		log.Fatal(err)
	}

	server := &http.Server{
		Addr:              cfg.Listen,
		Handler:           handler,
		ReadHeaderTimeout: 10 * time.Second,
	}
	shutdown := make(chan os.Signal, 1)
	signal.Notify(shutdown, syscall.SIGINT, syscall.SIGTERM)
	go func() {
		<-shutdown
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		_ = server.Shutdown(ctx)
	}()

	log.Printf("zen transport listening on %s", cfg.Listen)
	if err := server.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
		log.Fatal(err)
	}
}

func loadConfig(path string) (config, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return config{}, err
	}
	var cfg config
	if err := json.Unmarshal(data, &cfg); err != nil {
		return config{}, err
	}
	if !strings.HasPrefix(cfg.Listen, "127.0.0.1:") {
		return config{}, errors.New("listen must be a 127.0.0.1 address")
	}
	if len(cfg.Key) < 32 {
		return config{}, errors.New("local API key is too short")
	}
	return cfg, nil
}
