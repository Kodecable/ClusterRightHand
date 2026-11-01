package taskinput

import (
	"crypto/sha256"
	"testing"

	"github.com/Kodecable/ClusterRightHand/client/internal/protocol"
)

// refFor is the input declaration of content.
func refFor(content string) *protocol.InputRef {
	sum := sha256.Sum256([]byte(content))
	return &protocol.InputRef{Size: protocol.Uint(len(content)), SHA256: protocol.Hash(sum)}
}

func TestRef(t *testing.T) {
	declared := refFor("x")
	for _, tc := range []struct {
		name string
		spec *protocol.TaskSpec
		want *protocol.InputRef
	}{
		{"exec stdin", &protocol.TaskSpec{Kind: protocol.TaskSpecExec, Exec: &protocol.ExecSpec{Stdin: declared}}, declared},
		{"exec no stdin", &protocol.TaskSpec{Kind: protocol.TaskSpecExec, Exec: &protocol.ExecSpec{}}, nil},
		{"file.write", &protocol.TaskSpec{Kind: protocol.TaskSpecFileWrite, FileWrite: &protocol.FileWriteSpec{Content: *declared}}, declared},
		{"file.read", &protocol.TaskSpec{Kind: protocol.TaskSpecFileRead, FileRead: &protocol.FileReadSpec{}}, nil},
		{"no body", &protocol.TaskSpec{}, nil},
	} {
		t.Run(tc.name, func(t *testing.T) {
			got := Ref(tc.spec)
			switch {
			case tc.want == nil && got != nil:
				t.Fatalf("Ref = %+v, want nil", got)
			case tc.want != nil && (got == nil || *got != *tc.want):
				t.Fatalf("Ref = %+v, want %+v", got, tc.want)
			}
		})
	}
}

func TestValidateRef(t *testing.T) {
	empty := refFor("")
	if err := ValidateRef(empty); err != nil {
		t.Fatalf("empty input with its own hash: %v", err)
	}
	if err := ValidateRef(nil); err != nil {
		t.Fatalf("no input: %v", err)
	}
	wrong := refFor("")
	wrong.SHA256 = protocol.Hash(sha256.Sum256([]byte("x")))
	err := ValidateRef(wrong)
	if err == nil || err.Code != "invalid_spec" {
		t.Fatalf("zero-size input with another hash = %v, want invalid_spec", err)
	}
}

// chunk is one task.input body at offset.
func chunk(offset int, data string) *protocol.TaskInput {
	return &protocol.TaskInput{TaskID: "t", Offset: protocol.Uint(offset), Data: []byte(data)}
}

func TestAccept(t *testing.T) {
	const content = "hello world"
	in := New(refFor(content))
	if !in.Declared() || in.Size() != uint64(len(content)) || in.Offset() != 0 || in.Complete() {
		t.Fatalf("new input: %+v", in)
	}

	res := in.Accept("t", chunk(0, "hello "))
	if res.Failure != nil || res.Refusal != nil || string(res.Data) != "hello " || res.Complete {
		t.Fatalf("first chunk: %+v", res)
	}
	res = in.Accept("t", chunk(6, "world"))
	if res.Failure != nil || res.Refusal != nil || string(res.Data) != "world" || !res.Complete {
		t.Fatalf("second chunk: %+v", res)
	}
	if !in.Complete() || in.Offset() != uint64(len(content)) {
		t.Fatalf("complete input: %+v", in)
	}

	// An empty chunk after completion is harmless, any other data is refused.
	if res := in.Accept("t", chunk(len(content), "")); res.Refusal != nil || res.Failure != nil {
		t.Fatalf("empty chunk after completion: %+v", res)
	}
	if res := in.Accept("t", chunk(len(content), "more")); res.Refusal == nil || res.Refusal.Code != "input_too_large" {
		t.Fatalf("data after completion: %+v", res)
	}
}

func TestAcceptOutOfOrder(t *testing.T) {
	in := New(refFor("abcdef"))
	res := in.Accept("t", chunk(3, "def"))
	if res.Refusal == nil || res.Refusal.Code != "input_out_of_order" {
		t.Fatalf("offset 3 before 0: %+v", res)
	}
	if res.Refusal.Message != "task t input offset 3, want 0" {
		t.Fatalf("message = %q", res.Refusal.Message)
	}
}

func TestAcceptTooLong(t *testing.T) {
	in := New(refFor("abc"))
	res := in.Accept("t", chunk(0, "abcdef"))
	if res.Refusal == nil || res.Refusal.Code != "input_too_large" {
		t.Fatalf("overflowing chunk: %+v", res)
	}
	if res.Failure == nil || res.Failure.Code != "input_mismatch" {
		t.Fatalf("failure of an overflowing chunk: %+v", res)
	}
	if res.Data != nil {
		t.Fatal("an overflowing chunk delivered data")
	}
	// The input ended: the bytes that did arrive are counted, as the crh-priv accounting reports.
	if in.Offset() != 6 {
		t.Fatalf("offset = %d, want 6", in.Offset())
	}
}

func TestAcceptWrongHash(t *testing.T) {
	in := New(refFor("abc"))
	in.want = protocol.Hash(sha256.Sum256([]byte("xyz")))
	res := in.Accept("t", chunk(0, "abc"))
	if res.Failure == nil || res.Failure.Code != "input_mismatch" {
		t.Fatalf("wrong hash: %+v", res)
	}
	if res.Refusal != nil || res.Complete || res.Data != nil {
		t.Fatalf("a mismatching chunk is reported as a failure only: %+v", res)
	}
}

func TestAcceptWithoutDeclaration(t *testing.T) {
	var in Input
	if in.Declared() || in.Size() != 0 || !in.Complete() {
		t.Fatalf("zero input: %+v", in)
	}
	if res := in.Accept("t", chunk(0, "")); res.Refusal != nil || res.Failure != nil {
		t.Fatalf("empty chunk: %+v", res)
	}
	res := in.Accept("t", chunk(0, "x"))
	if res.Refusal == nil || res.Refusal.Code != "input_too_large" || res.Refusal.Message != "task t input exceeds the declared 0 bytes" {
		t.Fatalf("data for a task without input: %+v", res)
	}
}

func TestAdvance(t *testing.T) {
	in := New(refFor("abcdef"))
	in.Advance(4)
	if in.Offset() != 4 || in.Complete() {
		t.Fatalf("after advancing to 4: %+v", in)
	}
	in.Advance(2)
	if in.Offset() != 4 {
		t.Fatalf("advance moved backwards: %+v", in)
	}
	in.Advance(6)
	if !in.Complete() {
		t.Fatalf("not complete after advancing to the declared size: %+v", in)
	}
}
