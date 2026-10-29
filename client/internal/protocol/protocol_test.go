package protocol

import (
	"slices"
	"testing"
)

func TestSupportedNames(t *testing.T) {
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
	}
	if got := SupportedNames(); !slices.Equal(got, want) {
		t.Fatalf("SupportedNames() = %v, want %v", got, want)
	}
	if got := len(SupportedSet()); got != len(want) {
		t.Fatalf("SupportedSet has %d names, want %d", got, len(want))
	}
	for _, reserved := range []string{"trust.query", "revocations.set", "trust.summary"} {
		if SupportedSet().Has(reserved) {
			t.Fatalf("M4-reserved name %q is declared in 1.0", reserved)
		}
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
