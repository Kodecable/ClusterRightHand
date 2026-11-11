package protocol

import (
	"slices"
	"testing"
)

func TestRequiredNames(t *testing.T) {
	want := []string{
		"facts",
		"hello",
		"local.decision",
		"local.request",
		"local.withdraw",
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
	if Major := ProtocolMajor; Major != 0 {
		t.Fatalf("ProtocolMajor = %d, want 0", Major)
	}
	if Minor := ProtocolMinor; Minor != 0 {
		t.Fatalf("ProtocolMinor = %d, want 0", Minor)
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
