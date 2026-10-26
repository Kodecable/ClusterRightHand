package config

import (
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"
)

const minimal = "server = \"https://crh.example.com\"\n"

func TestParseDefaults(t *testing.T) {
	c, err := Parse([]byte(minimal))
	if err != nil {
		t.Fatal(err)
	}
	want := &Config{
		Server: "https://crh.example.com", TLSVerify: "system", StateDir: "/var/lib/crha",
		Notes:     "/var/lib/crha/NOTES.md",
		Privilege: Privileged{Mode: "reject", Socket: "/run/crha/privileged.sock", Native: "sudo"},
		Output:    Output{Dir: "/var/lib/crha/output", MaxAge: 168 * time.Hour, MaxTotal: 1 << 30},
	}
	if !reflect.DeepEqual(c, want) {
		t.Fatalf("got %+v want %+v", c, want)
	}
	if c.IdentityKeyPath() != "/var/lib/crha/identity.key" || c.ServerKeyPath() != "/var/lib/crha/server.pub" {
		t.Fatal("key paths")
	}
}

func TestParseFull(t *testing.T) {
	c, err := Parse([]byte(minimal + `
tls_verify = "none"
notes = "/n.md"
groups = ["web", "prod", "web"]
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
		c.Output != (Output{"/o", time.Hour, 2 << 20}) {
		t.Fatalf("got %+v", c)
	}
}

func TestParseErrors(t *testing.T) {
	tests := []struct{ name, in, want string }{
		{"no server", "state_dir = \"/x\"\n", "server: required"},
		{"http remote", "server = \"http://example.com\"\nstate_dir=\"/x\"\n", "loopback"},
		{"ftp", "server = \"ftp://example.com\"\nstate_dir=\"/x\"\n", "scheme"},
		{"no host", "server = \"https://\"\nstate_dir=\"/x\"\n", "no host"},
		{"bad tls", minimal + "tls_verify = \"x\"\n", "tls_verify"},
		{"relative state_dir", "server = \"https://a.b\"\nstate_dir = \"x\"\n", "absolute"},
		{"relative notes", minimal + "notes = \"n.md\"\n", "notes"},
		{"bad group", minimal + "groups = [\"Web\"]\n", "invalid group"},
		{"bad mode", minimal + "[privileged]\nmode = \"x\"\n", "privileged.mode"},
		{"bad native", minimal + "[privileged]\nnative = \"su\"\n", "privileged.native"},
		{"relative socket", minimal + "[privileged]\nsocket = \"s\"\n", "privileged.socket"},
		{"relative out dir", minimal + "[output]\ndir = \"o\"\n", "output.dir"},
		{"bad age", minimal + "[output]\nmax_age = \"x\"\n", "max_age"},
		{"zero age", minimal + "[output]\nmax_age = \"0s\"\n", "max_age"},
		{"zero total", minimal + "[output]\nmax_total = \"0\"\n", "max_total"},
		{"bad total", minimal + "[output]\nmax_total = \"1TB\"\n", "max_total"},
		{"unknown top", minimal + "bogus = 1\n", "bogus"},
		{"unknown nested", minimal + "[output]\nnope = 1\n", "output.nope"},
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
	if err := os.WriteFile(p, []byte(minimal), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := Load(p); err != nil {
		t.Fatal(err)
	}
	if _, err := Load(p + ".missing"); err == nil {
		t.Fatal("expected error")
	}
}
