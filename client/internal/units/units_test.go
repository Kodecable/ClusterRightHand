package units

import (
	"reflect"
	"testing"

	"github.com/Kodecable/ClusterRightHand/client/internal/config"
)

func TestParseReadsWhatRenderWrites(t *testing.T) {
	server := Parse(RenderServer("/usr/local/bin/crha", "/etc/crha/crha.toml", config.ModeForward, "crha", "1.2.0"))
	want := Parsed{
		Managed:    true,
		Meta:       &Meta{V: MetaVersion, Version: "1.2.0", Mode: config.ModeForward, Config: "/etc/crha/crha.toml"},
		Executable: "/usr/local/bin/crha",
	}
	if !reflect.DeepEqual(server, want) {
		t.Fatalf("server unit: %+v, want %+v", server, want)
	}
	privileged := Parse(RenderPrivileged("/usr/local/bin/crha", "/etc/crha/privileged.toml", "1.2.0"))
	if !privileged.Managed || privileged.Meta.Config != "/etc/crha/privileged.toml" || privileged.Meta.Mode != config.ModeForward {
		t.Fatalf("privileged unit: %+v", privileged)
	}
}

func TestParseIgnoresUnmanagedAndMisplacedKeys(t *testing.T) {
	got := Parse("[Service]\nX-CRH-Managed=1\nExecStart=/opt/crha run\n[Unit]\nX-CRH-Meta=not json\n")
	if got.Managed || got.Meta != nil || got.Executable != "/opt/crha" {
		t.Fatalf("parsed %+v", got)
	}
}

func TestNames(t *testing.T) {
	if got := Names(config.ModeForward); !reflect.DeepEqual(got, []string{Privileged, Server}) {
		t.Fatalf("forward: %q", got)
	}
	if got := Names(config.ModeNative); !reflect.DeepEqual(got, []string{Server}) {
		t.Fatalf("native: %q", got)
	}
}
