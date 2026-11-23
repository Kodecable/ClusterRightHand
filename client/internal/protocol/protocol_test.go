package protocol

import (
	"slices"
	"testing"
)

func TestRequiredNames(t *testing.T) {
	want := []string{
		"facts",
		"hello",
		"node.status",
		"ping",
		"task.cancel",
		"task.exit",
		"task.exit.ack",
		"task.input",
		"task.output",
		"task.output.ack",
		"task.query",
		"task.start",
		"trust.summary",
	}
	if got := RequiredNames(); !slices.Equal(got, want) {
		t.Fatalf("RequiredNames() = %v, want %v", got, want)
	}
	if got := len(RequiredSet()); got != len(want) {
		t.Fatalf("RequiredSet has %d names, want %d", got, len(want))
	}
	for _, name := range want {
		if !RequiredSet().Has(name) {
			t.Fatalf("required name %q is not in the set", name)
		}
	}
	// trust.query is crh-priv's own command; it is not part of the crhs <-> crha
	// protocol at all.
	if RequiredSet().Has("trust.query") {
		t.Fatal("crh-priv name trust.query is declared in the crhs <-> crha handshake")
	}
	if Major := ProtocolMajor; Major != 1 {
		t.Fatalf("ProtocolMajor = %d, want 1", Major)
	}
	if Minor := ProtocolMinor; Minor != 1 {
		t.Fatalf("ProtocolMinor = %d, want 1", Minor)
	}
	if PTYNoiseProloguePrefix != "crh-pty/1" {
		t.Fatalf("PTYNoiseProloguePrefix = %q, want crh-pty/1", PTYNoiseProloguePrefix)
	}
}

func TestOptionalNames(t *testing.T) {
	want := []string{
		"pty.close",
		"pty.exited",
		"pty.list",
		"pty.meta",
		"pty.open",
		"pty.resize",
	}
	if got := OptionalNames(); !slices.Equal(got, want) {
		t.Fatalf("OptionalNames() = %v, want %v", got, want)
	}
	for _, name := range want {
		if RequiredSet().Has(name) {
			t.Fatalf("optional name %q is in the required set", name)
		}
		if !NewSet(OptionalNames()...).Has(name) {
			t.Fatalf("OptionalNames() misses %q", name)
		}
	}
	// Every optional name has a schema, so a known body is validated even when it was not negotiated.
	for _, name := range []string{CmdPTYOpen, CmdPTYResize, CmdPTYClose, CmdPTYMeta} {
		if _, ok := commandSchemas[name]; !ok {
			t.Fatalf("no command schema for optional command %q", name)
		}
	}
	for _, name := range []string{EventPTYExited, EventPTYList} {
		if _, ok := eventSchemas[name]; !ok {
			t.Fatalf("no event schema for optional event %q", name)
		}
	}
}

func TestOfferedNames(t *testing.T) {
	// crha speaks none of the terminal names yet, so offering them would promise behaviour it lacks.
	if got := ImplementedOptionalNames(); got != nil {
		t.Fatalf("ImplementedOptionalNames() = %v, want nil until terminals land", got)
	}
	if got := OfferedNames(); !slices.Equal(got, RequiredNames()) {
		t.Fatalf("OfferedNames() = %v, want RequiredNames()", got)
	}
	if got := OfferedSet().Has(CmdPTYOpen); got {
		t.Fatal("crha offers pty.open before implementing terminals")
	}
}

func TestSet(t *testing.T) {
	a := NewSet("hello", "ping")
	b := NewSet("ping", "facts")
	if !a.Has("hello") || a.Has("facts") {
		t.Fatalf("unexpected membership: %v", a)
	}
	if got := a.Intersect(b).Names(); !slices.Equal(got, []string{"ping"}) {
		t.Fatalf("Intersect = %v", got)
	}
	if got := a.Names(); !slices.Equal(got, []string{"hello", "ping"}) {
		t.Fatalf("Names = %v", got)
	}
	clone := a.Clone()
	clone.Add("facts")
	if a.Has("facts") {
		t.Fatal("Clone shares its map with the original")
	}
}
