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

func TestInitSystem(t *testing.T) {
	tests := []struct {
		name  string
		files map[string]string
		want  string
	}{
		{"systemd", map[string]string{"run/systemd/system/x": "", "proc/1/comm": "init\n"}, "systemd"},
		{"openrc-run", map[string]string{"sbin/openrc-run": ""}, "openrc"},
		{"openrc-dir", map[string]string{"run/openrc/x": ""}, "openrc"},
		{"comm", map[string]string{"proc/1/comm": "runit\n"}, "runit"},
		{"none", nil, ""},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			root := t.TempDir()
			for p, c := range tc.files {
				write(t, root, p, c)
			}
			if got := initSystem(root); got != tc.want {
				t.Fatalf("got %q want %q", got, tc.want)
			}
		})
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
	f := collect(root, look)
	if f.OSID != "fedora" || f.OSVersionID != "40" || f.OSPrettyName != "Fedora Linux 40" || f.InitSystem != "systemd" {
		t.Fatalf("unexpected facts: %v", f)
	}
	if !reflect.DeepEqual(f.PackageManagers, []string{"dnf", "nix"}) || !reflect.DeepEqual(f.PrivilegeTools, []string{"doas"}) {
		t.Fatalf("tools: %v %v", f.PackageManagers, f.PrivilegeTools)
	}
	if f.Kernel == "" || f.Arch == "" {
		t.Fatalf("kernel/arch empty: %v", f)
	}
}

func TestClean(t *testing.T) {
	f := Clean(protocol.Facts{
		Hostname:        "bad\xffhost",
		OSID:            "os\xff",
		OSVersionID:     "1",
		OSPrettyName:    "pretty\xff",
		Kernel:          "6.0\xff",
		Arch:            "amd64",
		InitSystem:      "systemd\xff",
		PackageManagers: []string{"apt", "dnf\xff"},
		PrivilegeTools:  []string{"sudo\xff"},
		NotesPath:       "/etc/notes\xff",
		Groups:          []string{"users", "grp\xff"},
	})
	for _, s := range []string{f.Hostname, f.OSID, f.OSPrettyName, f.Kernel, f.InitSystem, f.NotesPath} {
		if strings.ContainsRune(s, '\xff') {
			t.Fatalf("uncleaned text %q", s)
		}
	}
	for _, s := range append(append([]string{}, f.PackageManagers...), append(f.PrivilegeTools, f.Groups...)...) {
		if strings.ContainsRune(s, '\xff') {
			t.Fatalf("uncleaned list entry %q", s)
		}
	}
}
