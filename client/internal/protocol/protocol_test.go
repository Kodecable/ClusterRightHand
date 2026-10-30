package protocol

import (
	"slices"
	"testing"
)

func TestSupportedNames(t *testing.T) {
	required := []string{
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
	}
	// The protocol 1.1 names are optional for the peer but advertised by crha in every
	// privileged mode: non-forward modes answer the commands with privileged_unsupported.
	optional := []string{"local.decision", "local.request", "local.withdraw", "revocations.add", "trust.summary"}
	want := slices.Concat(required, optional)
	slices.Sort(want)
	if got := SupportedNames(); !slices.Equal(got, want) {
		t.Fatalf("SupportedNames() = %v, want %v", got, want)
	}
	if got := len(SupportedSet()); got != len(want) {
		t.Fatalf("SupportedSet has %d names, want %d", got, len(want))
	}
	if got := RequiredNames(); !slices.Equal(got, required) {
		t.Fatalf("RequiredNames() = %v, want %v", got, required)
	}
	if got := OptionalNames(); !slices.Equal(got, optional) {
		t.Fatalf("OptionalNames() = %v, want %v", got, optional)
	}
	for _, name := range optional {
		if !SupportedSet().Has(name) {
			t.Fatalf("protocol 1.1 name %q is not advertised", name)
		}
		if slices.Contains(RequiredNames(), name) {
			t.Fatalf("protocol 1.1 name %q is required", name)
		}
	}
	// trust.query is crh-priv's own command; it is not part of the crhs <-> crha
	// protocol at all.
	if SupportedSet().Has("trust.query") {
		t.Fatal("crh-priv name trust.query is declared in the crhs <-> crha handshake")
	}
	if Minor := ProtocolMinor; Minor != 1 {
		t.Fatalf("ProtocolMinor = %d, want 1", Minor)
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
