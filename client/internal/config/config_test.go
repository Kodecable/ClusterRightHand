package config

import (
	"fmt"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"
)

// minimalConfig returns a valid crha.toml. state_dir is required and must be absolute, so tests
// use a temporary directory.
func minimalConfig(t *testing.T) string {
	t.Helper()
	return fmt.Sprintf("server = \"https://crh.example.com\"\nstate_dir = %q\n", t.TempDir())
}

func TestParseDefaults(t *testing.T) {
	stateDir := t.TempDir()
	c, err := Parse([]byte(fmt.Sprintf("server = \"https://crh.example.com\"\nstate_dir = %q\n", stateDir)))
	if err != nil {
		t.Fatal(err)
	}
	want := &Config{
		Server: "https://crh.example.com", TLSVerify: "system", StateDir: stateDir,
		Notes:     filepath.Join(stateDir, "NOTES.md"),
		Privilege: Privileged{Mode: "reject", Socket: "", Native: "sudo"},
		Output:    Output{Dir: filepath.Join(stateDir, "output"), MaxAge: 168 * time.Hour, MaxTotal: 1 << 30},
		ClockWarn: 60 * time.Second,
	}
	if !reflect.DeepEqual(c, want) {
		t.Fatalf("got %+v want %+v", c, want)
	}
	if c.IdentityKeyPath() != filepath.Join(stateDir, "identity.key") || c.ServerKeyPath() != filepath.Join(stateDir, "server.pub") {
		t.Fatal("key paths")
	}
}

func TestParseFull(t *testing.T) {
	c, err := Parse([]byte(minimalConfig(t) + `
tls_verify = "none"
notes = "/n.md"
groups = ["web", "prod", "web"]
clock_warn = "90s"
[privileged]
mode = "native"
native = "doas"
socket = "/run/s.sock"
[output]
dir = "/o"
max_age = "1h"
max_total = "2MiB"
`))
	if err != nil {
		t.Fatal(err)
	}
	if c.TLSVerify != "none" || c.Notes != "/n.md" || !reflect.DeepEqual(c.Groups, []string{"web", "prod"}) ||
		c.Privilege != (Privileged{"native", "/run/s.sock", "doas"}) ||
		c.Output != (Output{"/o", time.Hour, 2 << 20}) ||
		c.ClockWarn != 90*time.Second {
		t.Fatalf("got %+v", c)
	}
}

func TestParseErrors(t *testing.T) {
	min := minimalConfig(t)
	tests := []struct{ name, in, want string }{
		{"no server", "state_dir = \"/x\"\n", "server: required"},
		{"missing state_dir", "server = \"https://a.b\"\n", "state_dir: required"},
		{"http remote", "server = \"http://example.com\"\nstate_dir=\"/x\"\n", "loopback"},
		{"ftp", "server = \"ftp://example.com\"\nstate_dir=\"/x\"\n", "scheme"},
		{"no host", "server = \"https://\"\nstate_dir=\"/x\"\n", "no host"},
		{"bad tls", min + "tls_verify = \"x\"\n", "tls_verify"},
		{"relative state_dir", "server = \"https://a.b\"\nstate_dir = \"x\"\n", "absolute"},
		{"relative notes", min + "notes = \"n.md\"\n", "notes"},
		{"bad group", min + "groups = [\"Web\"]\n", "invalid group"},
		{"bad clock_warn", min + "clock_warn = \"x\"\n", "clock_warn"},
		{"negative clock_warn", min + "clock_warn = \"-1s\"\n", "clock_warn"},
		{"bad mode", min + "[privileged]\nmode = \"x\"\n", "privileged.mode"},
		{"bad native", min + "[privileged]\nnative = \"su\"\n", "privileged.native"},
		{"relative socket", min + "[privileged]\nsocket = \"s\"\n", "privileged.socket"},
		{"forward without socket", min + "[privileged]\nmode = \"forward\"\n", "privileged.socket: required"},
		{"relative out dir", min + "[output]\ndir = \"o\"\n", "output.dir"},
		{"bad age", min + "[output]\nmax_age = \"x\"\n", "max_age"},
		{"zero age", min + "[output]\nmax_age = \"0s\"\n", "max_age"},
		{"zero total", min + "[output]\nmax_total = \"0\"\n", "max_total"},
		{"bad total", min + "[output]\nmax_total = \"1TB\"\n", "max_total"},
		{"unknown top", min + "bogus = 1\n", "bogus"},
		{"unknown nested", min + "[output]\nnope = 1\n", "output.nope"},
		{"syntax", "server = \n", "parse"},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			_, err := Parse([]byte(tc.in))
			if err == nil || !strings.Contains(err.Error(), tc.want) {
				t.Fatalf("got %v, want error containing %q", err, tc.want)
			}
		})
	}
}

// TestNativeModeWithoutSocket covers that privileged.socket is only required in forward mode.
func TestNativeModeWithoutSocket(t *testing.T) {
	c, err := Parse([]byte(minimalConfig(t) + "[privileged]\nmode = \"native\"\n"))
	if err != nil {
		t.Fatal(err)
	}
	if c.Privilege.Mode != ModeNative || c.Privilege.Socket != "" {
		t.Fatalf("privilege = %+v", c.Privilege)
	}
}

func TestLoopbackHTTP(t *testing.T) {
	for _, h := range []string{"localhost", "127.0.0.1", "127.3.4.5", "[::1]"} {
		in := "server = \"http://" + h + ":8080\"\nstate_dir = \"/x\"\n"
		if _, err := Parse([]byte(in)); err != nil {
			t.Errorf("%s: %v", h, err)
		}
	}
}

func TestAgentURL(t *testing.T) {
	tests := []struct{ server, want string }{
		{"https://x", "wss://x/agent"},
		{"https://x/", "wss://x/agent"},
		{"https://x/crh", "wss://x/crh/agent"},
		{"https://x:8443/crh/", "wss://x:8443/crh/agent"},
		{"http://127.0.0.1:8080", "ws://127.0.0.1:8080/agent"},
	}
	for _, tc := range tests {
		c := &Config{Server: tc.server}
		if got := c.AgentURL(); got != tc.want {
			t.Errorf("%s: got %s want %s", tc.server, got, tc.want)
		}
	}
}

// TestClockWarn covers the clock offset warning threshold: 60 s by default, a duration string
// when set, and "0s" to disable the warning (doc/privilege.md 时钟).
func TestClockWarn(t *testing.T) {
	min := minimalConfig(t)
	for _, tc := range []struct {
		name string
		in   string
		want time.Duration
	}{
		{"default", min, 60 * time.Second},
		{"set", min + "clock_warn = \"5m\"\n", 5 * time.Minute},
		{"zero", min + "clock_warn = \"0s\"\n", 0},
	} {
		t.Run(tc.name, func(t *testing.T) {
			c, err := Parse([]byte(tc.in))
			if err != nil {
				t.Fatal(err)
			}
			if c.ClockWarn != tc.want {
				t.Fatalf("clock_warn = %v, want %v", c.ClockWarn, tc.want)
			}
		})
	}
}

func TestParseSize(t *testing.T) {
	tests := []struct {
		in   string
		want int64
		ok   bool
	}{
		{"100", 100, true}, {"1KiB", 1024, true}, {"2 MiB", 2 << 20, true}, {"1GiB", 1 << 30, true},
		{"-1", 0, false}, {"0GiB", 0, false}, {"abc", 0, false}, {"1.5GiB", 0, false},
		{"9999999999999GiB", 0, false},
	}
	for _, tc := range tests {
		got, err := parseSize(tc.in)
		if (err == nil) != tc.ok || got != tc.want {
			t.Errorf("%q: got %d, %v", tc.in, got, err)
		}
	}
}

func TestLoad(t *testing.T) {
	p := filepath.Join(t.TempDir(), "c.toml")
	if err := os.WriteFile(p, []byte(minimalConfig(t)), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := Load(p); err != nil {
		t.Fatal(err)
	}
	if _, err := Load(p + ".missing"); err == nil {
		t.Fatal("expected error")
	}
}
