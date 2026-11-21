package marker

import "testing"

func TestHandOverMatchesOnlyItsTask(t *testing.T) {
	// slog's text handler quotes the message; the sentence is matched inside it.
	journal := `time=2026-11-21T10:00:00Z level=INFO msg="` + HandOver("0192f000-aaaa") + `"`
	if !IsHandOver(journal, "0192f000-aaaa") {
		t.Fatal("the hand-over line of the task does not match")
	}
	if IsHandOver(journal, "0192f000-aa") {
		t.Fatal("a prefix of the task id matches")
	}
	if IsHandOver(journal, "0192f000-bbbb") {
		t.Fatal("another task's hand-over matches")
	}
	// Frozen: an older crha writes exactly this.
	if HandOver("t") != "crha upgrade handed over: crhs confirmed task t" {
		t.Fatalf("the hand-over line changed: %q", HandOver("t"))
	}
}

func TestReadyNamesTheVersion(t *testing.T) {
	if !IsReady(`msg="`+Ready("1.3.0")+`"`, "1.3.0") {
		t.Fatal("the readiness line does not match")
	}
	if IsReady(Ready("1.2.0"), "1.3.0") {
		t.Fatal("an older version's readiness matches")
	}
}
