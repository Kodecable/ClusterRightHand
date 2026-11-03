//go:build pprof

// This file is compiled only with `-tags pprof`. It adds the --pprof-listen flag to the commands
// that host long-running processes (`crha run`, `crha privileged run`) and serves Go's standard
// net/http/pprof handlers on a private mux. The listener lives for the process context; closing the
// process stops it. Normal builds contain none of this, including the net/http/pprof import.
package cli

import (
	"context"
	"errors"
	"fmt"
	"io/fs"
	"log"
	"net"
	"net/http"
	"net/http/pprof"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"github.com/spf13/cobra"
)

func init() {
	debugFlags = addPprofFlags
}

// addPprofFlags registers --pprof-listen on cmd and returns the starter for the value the flag ends
// up with. Both long-running commands call it, so each gets its own flag and its own listener.
func addPprofFlags(cmd *cobra.Command) func(context.Context) error {
	var listen string
	cmd.Flags().StringVar(&listen, "pprof-listen", "",
		"serve Go pprof over unix:/absolute/path.sock or a loopback TCP address "+
			"(127.0.0.1:PORT or [::1]:PORT); debug build only")
	return func(ctx context.Context) error {
		if listen == "" {
			return nil
		}
		return startPprof(ctx, listen)
	}
}

// pprofTarget is a validated --pprof-listen value.
type pprofTarget struct {
	network string // "unix" or "tcp"
	address string // socket path or host:port
}

// parsePprofListen accepts exactly two forms: unix:<absolute path> and a loopback TCP address.
// Anything else is a startup error: a debug listener must not be reachable from outside the host.
func parsePprofListen(value string) (pprofTarget, error) {
	if value == "" {
		return pprofTarget{}, errors.New("pprof: empty listen address")
	}
	if path, ok := strings.CutPrefix(value, "unix:"); ok {
		if !filepath.IsAbs(path) {
			return pprofTarget{}, fmt.Errorf("pprof: unix socket %q is not an absolute path", path)
		}
		if strings.IndexByte(path, 0) >= 0 {
			return pprofTarget{}, fmt.Errorf("pprof: unix socket path %q contains a NUL byte", path)
		}
		return pprofTarget{network: "unix", address: path}, nil
	}
	host, port, err := net.SplitHostPort(value)
	if err != nil {
		return pprofTarget{}, fmt.Errorf("pprof: %q is neither unix:/absolute/path.sock nor a loopback address: %w", value, err)
	}
	ip := net.ParseIP(host)
	if ip == nil || !ip.IsLoopback() {
		return pprofTarget{}, fmt.Errorf("pprof: %q is not a loopback TCP address (use 127.0.0.1:PORT or [::1]:PORT)", value)
	}
	number, err := strconv.Atoi(port)
	if err != nil || number < 1 || number > 65535 {
		return pprofTarget{}, fmt.Errorf("pprof: %q has no valid TCP port", value)
	}
	return pprofTarget{network: "tcp", address: net.JoinHostPort(host, port)}, nil
}

// startPprof validates value, opens the listener and serves pprof until ctx is cancelled. It
// returns once the listener is accepting connections, so a bad address or an occupied path fails
// the process at startup instead of leaving a silently dead debug endpoint.
func startPprof(ctx context.Context, value string) error {
	target, err := parsePprofListen(value)
	if err != nil {
		return err
	}
	if target.network == "unix" {
		if err := removeStaleSocket(target.address); err != nil {
			return err
		}
	}
	listener, err := net.Listen(target.network, target.address)
	if err != nil {
		return fmt.Errorf("pprof: listen on %s: %w", value, err)
	}
	if target.network == "unix" {
		// The directory may be shared (the soak bind-mounts it into a container); the socket itself
		// is private to its owner.
		if err := os.Chmod(target.address, 0o600); err != nil {
			_ = listener.Close()
			return fmt.Errorf("pprof: chmod %s: %w", target.address, err)
		}
	}

	server := &http.Server{Handler: pprofMux(), ReadHeaderTimeout: 5 * time.Second}
	done := make(chan struct{})
	go func() {
		defer close(done)
		if err := server.Serve(listener); err != nil && !errors.Is(err, http.ErrServerClosed) {
			log.Printf("pprof: serving %s: %v", value, err)
		}
	}()
	go func() {
		<-ctx.Done()
		shutdownCtx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
		defer cancel()
		_ = server.Shutdown(shutdownCtx)
		<-done
		if target.network == "unix" {
			_ = os.Remove(target.address)
		}
	}()
	log.Printf("pprof: debug build, listening on %s", value)
	return nil
}

// pprofMux serves the standard handlers from a private mux. http.DefaultServeMux belongs to the
// application and a debug build must not add routes to it.
func pprofMux() *http.ServeMux {
	mux := http.NewServeMux()
	mux.HandleFunc("/debug/pprof/", pprof.Index)
	mux.HandleFunc("/debug/pprof/cmdline", pprof.Cmdline)
	mux.HandleFunc("/debug/pprof/profile", pprof.Profile)
	mux.HandleFunc("/debug/pprof/symbol", pprof.Symbol)
	mux.HandleFunc("/debug/pprof/trace", pprof.Trace)
	for _, name := range []string{"allocs", "block", "goroutine", "heap", "mutex", "threadcreate"} {
		mux.Handle("/debug/pprof/"+name, pprof.Handler(name))
	}
	return mux
}

// removeStaleSocket removes a socket left behind by an earlier debug run. Any other kind of file is
// left alone: deleting a regular file because a path was reused is not this flag's business, and
// net.Listen then reports the conflict.
func removeStaleSocket(path string) error {
	info, err := os.Lstat(path)
	if errors.Is(err, fs.ErrNotExist) {
		return nil
	}
	if err != nil {
		return fmt.Errorf("pprof: stat %s: %w", path, err)
	}
	if info.Mode()&os.ModeSocket == 0 {
		return fmt.Errorf("pprof: %s exists and is not a socket", path)
	}
	if err := os.Remove(path); err != nil && !errors.Is(err, fs.ErrNotExist) {
		return fmt.Errorf("pprof: remove stale socket %s: %w", path, err)
	}
	return nil
}
