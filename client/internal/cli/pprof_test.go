//go:build pprof

package cli

import (
	"bytes"
	"context"
	"io"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestParsePprofListen(t *testing.T) {
	valid := []struct {
		value   string
		network string
		address string
	}{
		{"unix:/tmp/crha-pprof.sock", "unix", "/tmp/crha-pprof.sock"},
		{"unix:/run/crha/pprof.sock", "unix", "/run/crha/pprof.sock"},
		{"127.0.0.1:6060", "tcp", "127.0.0.1:6060"},
		{"[::1]:6060", "tcp", "[::1]:6060"},
		{"127.0.0.2:6060", "tcp", "127.0.0.2:6060"},
	}
	for _, test := range valid {
		target, err := parsePprofListen(test.value)
		if err != nil {
			t.Errorf("parsePprofListen(%q) = error %v, want success", test.value, err)
			continue
		}
		if target.network != test.network || target.address != test.address {
			t.Errorf("parsePprofListen(%q) = %s %s, want %s %s", test.value, target.network, target.address, test.network, test.address)
		}
	}

	invalid := []string{
		"",
		"unix:",
		"unix:relative.sock",
		"/tmp/crha.sock",
		"127.0.0.1",
		"127.0.0.1:0",
		"127.0.0.1:65536",
		"127.0.0.1:http",
		"0.0.0.0:6060",
		"192.0.2.1:6060",
		"localhost:6060",
		":6060",
	}
	for _, value := range invalid {
		if target, err := parsePprofListen(value); err == nil {
			t.Errorf("parsePprofListen(%q) = %+v, want an error", value, target)
		}
	}
}

// TestPprofFlagsRegistered covers that the tagged build adds the flag to both long-running
// commands, with no default listener.
func TestPprofFlagsRegistered(t *testing.T) {
	root := NewRootCmd()
	for _, args := range [][]string{{"run"}, {"privileged", "run"}} {
		cmd, _, err := root.Find(args)
		if err != nil {
			t.Fatalf("find %v: %v", args, err)
		}
		flag := cmd.Flags().Lookup("pprof-listen")
		if flag == nil {
			t.Fatalf("%v has no --pprof-listen flag in a pprof build", args)
		}
		if flag.DefValue != "" {
			t.Fatalf("%v --pprof-listen default = %q, want empty", args, flag.DefValue)
		}
		if !strings.Contains(flag.Usage, "debug build only") {
			t.Fatalf("%v --pprof-listen help = %q, want it to say it is debug-only", args, flag.Usage)
		}
	}
}

// TestPprofUnixSocket covers the unix form end to end: a stale socket is replaced, the socket is
// 0600, and /debug/pprof/heap answers with both the binary profile and the debug=1 text.
func TestPprofUnixSocket(t *testing.T) {
	path := filepath.Join(t.TempDir(), "pprof.sock")
	stale, err := net.ListenUnix("unix", &net.UnixAddr{Name: path, Net: "unix"})
	if err != nil {
		t.Fatalf("listen stale socket: %v", err)
	}
	// Keep the file behind, like a process that was killed without closing its listener.
	stale.SetUnlinkOnClose(false)
	if err := stale.Close(); err != nil {
		t.Fatalf("close stale socket: %v", err)
	}
	if _, err := os.Lstat(path); err != nil {
		t.Fatalf("the stale socket file is not there: %v", err)
	}

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	if err := startPprof(ctx, "unix:"+path); err != nil {
		t.Fatalf("startPprof: %v", err)
	}

	info, err := os.Stat(path)
	if err != nil {
		t.Fatalf("stat socket: %v", err)
	}
	if info.Mode()&os.ModeSocket == 0 {
		t.Fatalf("%s is not a socket (mode %v)", path, info.Mode())
	}
	if perm := info.Mode().Perm(); perm != 0o600 {
		t.Fatalf("socket mode = %04o, want 0600", perm)
	}

	client := pprofUnixClient(path)

	text := pprofGet(t, client, "http://pprof/debug/pprof/heap?debug=1")
	if !bytes.Contains(text, []byte("# runtime.MemStats")) {
		t.Fatalf("heap?debug=1 body has no runtime.MemStats section:\n%s", pprofTail(text, 500))
	}
	for _, field := range []string{"HeapAlloc", "HeapInuse", "HeapReleased", "Sys"} {
		if !bytes.Contains(text, []byte("# "+field+" = ")) {
			t.Fatalf("heap?debug=1 body has no %s line:\n%s", field, pprofTail(text, 800))
		}
	}

	profile := pprofGet(t, client, "http://pprof/debug/pprof/heap")
	if len(profile) < 2 || profile[0] != 0x1f || profile[1] != 0x8b {
		t.Fatalf("heap profile is not gzip-compressed (first bytes %x)", profile[:min(len(profile), 4)])
	}

	// gc=1 makes the handler run a collection; the request must be accepted.
	if status := pprofStatus(t, client, "http://pprof/debug/pprof/heap?gc=1"); status != http.StatusOK {
		t.Fatalf("heap?gc=1 status = %d, want 200", status)
	}

	cancel()
	// The shutdown goroutine removes the socket; give it a moment, then the temp dir cleanup is quiet.
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		if _, err := os.Lstat(path); os.IsNotExist(err) {
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Logf("%s still exists after shutdown (the process is exiting anyway)", path)
}

func pprofUnixClient(path string) *http.Client {
	return &http.Client{
		Transport: &http.Transport{
			DialContext: func(ctx context.Context, _, _ string) (net.Conn, error) {
				return (&net.Dialer{}).DialContext(ctx, "unix", path)
			},
		},
		Timeout: 30 * time.Second,
	}
}

func pprofGet(t *testing.T, client *http.Client, url string) []byte {
	t.Helper()
	response, err := client.Get(url)
	if err != nil {
		t.Fatalf("GET %s: %v", url, err)
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		t.Fatalf("GET %s: status %s", url, response.Status)
	}
	body, err := io.ReadAll(response.Body)
	if err != nil {
		t.Fatalf("read %s: %v", url, err)
	}
	return body
}

func pprofStatus(t *testing.T, client *http.Client, url string) int {
	t.Helper()
	response, err := client.Get(url)
	if err != nil {
		t.Fatalf("GET %s: %v", url, err)
	}
	defer response.Body.Close()
	_, _ = io.Copy(io.Discard, response.Body)
	return response.StatusCode
}

func pprofTail(body []byte, n int) string {
	if len(body) <= n {
		return string(body)
	}
	return "..." + string(body[len(body)-n:])
}
