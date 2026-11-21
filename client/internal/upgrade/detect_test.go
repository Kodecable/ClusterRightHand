package upgrade

import (
	"os"
	"path/filepath"
	"reflect"
	"testing"

	"github.com/Kodecable/ClusterRightHand/client/internal/config"
	"github.com/Kodecable/ClusterRightHand/client/internal/units"
)

// fakeNode writes a cgroup file and the given units below a temporary root.
func fakeNode(t *testing.T, cgroup string, files map[string]string) Host {
	t.Helper()
	root := t.TempDir()
	write := func(path, content string) {
		full := filepath.Join(root, path)
		if err := os.MkdirAll(filepath.Dir(full), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(full, []byte(content), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	if cgroup != "" {
		write("/proc/self/cgroup", cgroup)
	}
	write("/usr/local/bin/crha", "binary")
	for name, content := range files {
		write(filepath.Join(units.Dir, name), content)
	}
	return Host{Root: root, UID: 998, Executable: "/usr/local/bin/crha"}
}

const inUnit = "0::/system.slice/crha.service\n"

func managed(mode string) map[string]string {
	files := map[string]string{
		units.Server: units.RenderServer("/usr/local/bin/crha", "/etc/crha/crha.toml", mode, "crha", "1.2.0"),
	}
	if mode == config.ModeForward {
		files[units.Privileged] = units.RenderPrivileged("/usr/local/bin/crha", "/etc/crha/privileged.toml", "1.2.0")
	}
	return files
}

func TestStaticReasons(t *testing.T) {
	cases := []struct {
		name    string
		host    Host
		mode    string
		pkg     bool
		reasons []string
	}{
		{"forward with managed units", fakeNode(t, inUnit, managed(config.ModeForward)), config.ModeForward, false, nil},
		{"native with managed units", fakeNode(t, inUnit, managed(config.ModeNative)), config.ModeNative, false, nil},
		{"package managed", fakeNode(t, inUnit, managed(config.ModeNative)), config.ModeNative, true, []string{ReasonPackageManaged}},
		{"reject mode", fakeNode(t, inUnit, managed(config.ModeReject)), config.ModeReject, false, []string{ReasonNoPrivilege}},
		{"ignore as crha", fakeNode(t, inUnit, managed(config.ModeIgnore)), config.ModeIgnore, false, []string{ReasonNoPrivilege}},
		{"not under systemd", fakeNode(t, "0::/user.slice/session-1.scope\n", nil), config.ModeNative, false, []string{ReasonNotSystemd}},
		{"no cgroup file", fakeNode(t, "", nil), config.ModeNative, false, []string{ReasonNotSystemd}},
		{"another unit name", fakeNode(t, "0::/system.slice/my-agent.service\n", managed(config.ModeNative)), config.ModeNative, false, []string{ReasonUnmanagedUnit}},
		{
			"hand-written privileged unit",
			fakeNode(t, inUnit, map[string]string{
				units.Server:     managed(config.ModeForward)[units.Server],
				units.Privileged: "[Service]\nExecStart=/usr/local/bin/crha privileged run\n",
			}),
			config.ModeForward, false, []string{ReasonUnmanagedUnit},
		},
		{"missing privileged unit", fakeNode(t, inUnit, managed(config.ModeNative)), config.ModeForward, false, []string{ReasonUnmanagedUnit}},
		{
			"units start different binaries",
			fakeNode(t, inUnit, map[string]string{
				units.Server:     units.RenderServer("/opt/crha/crha", "/etc/crha/crha.toml", config.ModeForward, "crha", "1.2.0"),
				units.Privileged: managed(config.ModeForward)[units.Privileged],
			}),
			config.ModeForward, false, []string{ReasonUnitMismatch},
		},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			got := StaticReasons(c.host, c.mode, c.pkg)
			if !reflect.DeepEqual(got, c.reasons) {
				t.Fatalf("reasons = %q, want %q", got, c.reasons)
			}
		})
	}
	root := fakeNode(t, inUnit, managed(config.ModeIgnore))
	root.UID = 0
	if got := StaticReasons(root, config.ModeIgnore, false); got != nil {
		t.Fatalf("ignore as root: reasons = %q, want none", got)
	}
}

func TestReasonsAddTheForwardDaemon(t *testing.T) {
	if got := Reasons(nil, config.ModeForward, Forward{Connected: false}); !reflect.DeepEqual(got, []string{ReasonPrivilegedUnavailable}) {
		t.Fatalf("down daemon: %q", got)
	}
	if got := Reasons(nil, config.ModeForward, Forward{Connected: true, PeerUID: 1001}); !reflect.DeepEqual(got, []string{ReasonPrivilegedNotRoot}) {
		t.Fatalf("daemon as deploy: %q", got)
	}
	if got := Reasons(nil, config.ModeForward, Forward{Connected: true, PeerUID: 0}); got != nil {
		t.Fatalf("root daemon: %q", got)
	}
	if got := Reasons([]string{ReasonNotSystemd}, config.ModeNative, Forward{}); !reflect.DeepEqual(got, []string{ReasonNotSystemd}) {
		t.Fatalf("native ignores the daemon: %q", got)
	}
}

func TestServiceUnit(t *testing.T) {
	for cgroup, want := range map[string]string{
		"0::/system.slice/crha.service\n":                                 "crha.service",
		"12:cpu:/x\n1:name=systemd:/system.slice/crha-privileged.service": "crha-privileged.service",
		"0::/user.slice/user-1000.slice/session-2.scope\n":                "",
		"": "",
	} {
		if got := ServiceUnit(cgroup); got != want {
			t.Fatalf("ServiceUnit(%q) = %q, want %q", cgroup, got, want)
		}
	}
}
