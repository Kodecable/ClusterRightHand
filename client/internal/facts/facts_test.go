package facts

import (
	"errors"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"

	"github.com/Kodecable/ClusterRightHand/client/internal/protocol"
)

func write(t *testing.T, root, rel, content string) {
	t.Helper()
	p := filepath.Join(root, rel)
	if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(p, []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
}

func TestParseOSRelease(t *testing.T) {
	in := "# c\nID=debian\nVERSION_ID=\"12\"\nPRETTY_NAME=\"Debian GNU/Linux 12 (bookworm)\"\nNAME='Deb ian'\nESC=\"a\\\"b\"\nbad line\n\n"
	got := parseOSRelease([]byte(in))
	want := map[string]string{
		"ID": "debian", "VERSION_ID": "12",
		"PRETTY_NAME": "Debian GNU/Linux 12 (bookworm)", "NAME": "Deb ian", "ESC": `a"b`,
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("got %v want %v", got, want)
	}
}

func TestOSReleaseFallback(t *testing.T) {
	root := t.TempDir()
	if m := osRelease(root); m != nil {
		t.Fatalf("expected nil, got %v", m)
	}
	write(t, root, "usr/lib/os-release", "ID=alpine\n")
	if got := osRelease(root)["ID"]; got != "alpine" {
		t.Fatalf("fallback: got %q", got)
	}
	write(t, root, "etc/os-release", "ID=arch\n")
	if got := osRelease(root)["ID"]; got != "arch" {
		t.Fatalf("primary: got %q", got)
	}
}

func TestPlatform(t *testing.T) {
	tests := []struct {
		name string
		osr  map[string]string
		want string
	}{
		{"pretty name", map[string]string{"PRETTY_NAME": "Ubuntu 24.04.4 LTS", "NAME": "Ubuntu"}, "linux, amd64, Ubuntu 24.04.4 LTS"},
		{"name and version", map[string]string{"NAME": "Alpine Linux", "VERSION_ID": "3.20"}, "linux, amd64, Alpine Linux 3.20"},
		{"id", map[string]string{"ID": "arch"}, "linux, amd64, arch"},
		{"nothing", nil, "linux, amd64"},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			if got := platform("linux", "amd64", tc.osr); got != tc.want {
				t.Fatalf("got %q want %q", got, tc.want)
			}
		})
	}
}

func TestHints(t *testing.T) {
	lookFor := func(names ...string) func(string) (string, error) {
		return func(n string) (string, error) {
			for _, name := range names {
				if n == name {
					return "/usr/bin/" + n, nil
				}
			}
			return "", errors.New("not found")
		}
	}
	tests := []struct {
		name  string
		files map[string]string
		look  func(string) (string, error)
		want  []string
	}{
		{
			"systemd",
			map[string]string{"run/systemd/system/x": "", "proc/1/comm": "systemd\n"},
			lookFor("apt", "sudo"),
			[]string{"Found systemd.", "PID 1 is systemd.", "Found apt.", "Found sudo."},
		},
		{"openrc", map[string]string{"sbin/openrc-run": ""}, lookFor("apk", "doas"), []string{"Found OpenRC.", "Found apk.", "Found doas."}},
		{"container", map[string]string{"proc/1/comm": "sh\n"}, lookFor(), []string{"PID 1 is sh.", "No sudo, doas or run0 found."}},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			root := t.TempDir()
			for p, c := range tc.files {
				write(t, root, p, c)
			}
			got := hints(root, tc.look)
			// The kernel line comes last and depends on the machine running the test.
			if len(got) == 0 || !strings.HasPrefix(got[len(got)-1], "Kernel ") {
				t.Fatalf("no kernel line: %q", got)
			}
			if got = got[:len(got)-1]; !reflect.DeepEqual(got, tc.want) {
				t.Fatalf("got %q want %q", got, tc.want)
			}
		})
	}
}

func TestTruncateHints(t *testing.T) {
	lines := make([]string, 30)
	for i := range lines {
		lines[i] = "Found tool."
	}
	if got := strings.Split(TruncateHints(strings.Join(lines, "\n")), "\n"); len(got) != protocol.MaxHintLines {
		t.Fatalf("lines: got %d", len(got))
	}
	long := strings.Repeat("x", 600)
	got := TruncateHints(long + "\n" + long + "\n" + "short")
	if got != long {
		t.Fatalf("bytes: kept %d bytes, want only the first line", len(got))
	}
}

func TestCollect(t *testing.T) {
	root := t.TempDir()
	write(t, root, "etc/os-release", "ID=fedora\nVERSION_ID=40\nPRETTY_NAME=\"Fedora Linux 40\"\n")
	write(t, root, "run/systemd/system/x", "")
	have := map[string]bool{"dnf": true, "nix": true, "doas": true}
	look := func(n string) (string, error) {
		if have[n] {
			return "/bin/" + n, nil
		}
		return "", errors.New("not found")
	}
	f := collect(root, look, "linux", "arm64")
	if text(f.Platform) != "linux, arm64, Fedora Linux 40" {
		t.Fatalf("platform: %q", text(f.Platform))
	}
	if !strings.HasPrefix(text(f.Hints), "Found systemd.\nFound dnf.\nFound nix.\nFound doas.\nKernel ") {
		t.Fatalf("hints: %q", text(f.Hints))
	}
}

// text dereferences an optional text fact, "" when absent.
func text(p *string) string {
	if p == nil {
		return ""
	}
	return *p
}

func TestClean(t *testing.T) {
	bash := "/bin/bash\xff"
	f := Clean(protocol.Facts{
		Hostname:  "bad\xffhost",
		Platform:  ptr("linux, amd64, pretty\xff"),
		Hints:     ptr("Found apt\xff."),
		NotesPath: ptr("/etc/notes\xff"),
		Shells:    &protocol.Shells{Sh: "/bin/sh\xff", Bash: &bash},
	})
	for _, s := range []string{f.Hostname, text(f.Platform), text(f.Hints), text(f.NotesPath)} {
		if strings.ContainsRune(s, '\xff') {
			t.Fatalf("uncleaned text %q", s)
		}
	}
	if f.Shells == nil || strings.ContainsRune(f.Shells.Sh, '\xff') || f.Shells.Bash == nil ||
		strings.ContainsRune(*f.Shells.Bash, '\xff') {
		t.Fatalf("uncleaned shells %+v", f.Shells)
	}
	// An absent optional fact stays absent.
	if Clean(protocol.Facts{Hostname: "h"}).Platform != nil {
		t.Fatal("Clean invented an absent fact")
	}
}

func ptr[T any](v T) *T { return &v }
