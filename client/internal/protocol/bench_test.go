package protocol

import (
	"testing"

	"github.com/fxamacker/cbor/v2"
)

// benchOutput is the body of one 32 KiB task.output event: the chunk size crha sends
// (doc/execution-plane.md#输出).
func benchOutput() *TaskOutput {
	return &TaskOutput{TaskID: "bench", Stream: StreamStdout, Offset: 0, Data: make([]byte, 32<<10)}
}

// BenchmarkEmitTaskOutput measures encoding one 32 KiB task.output event, including the validation of
// the outgoing body against the event schema.
func BenchmarkEmitTaskOutput(b *testing.B) {
	peer := NewPeer(func([]byte) error { return nil }, SupportedSet())
	out := benchOutput()
	b.SetBytes(32 << 10)
	b.ReportAllocs()
	for i := 0; i < b.N; i++ {
		if err := peer.Emit(EventTaskOutput, out); err != nil {
			b.Fatal(err)
		}
	}
}

// BenchmarkReceiveTaskOutput measures receiving one 32 KiB task.output frame, including the body
// validation the peer does and the decode a handler does.
func BenchmarkReceiveTaskOutput(b *testing.B) {
	frame, err := EncodeEvent(EventTaskOutput, benchOutput())
	if err != nil {
		b.Fatal(err)
	}
	peer := NewPeer(func([]byte) error { return nil }, SupportedSet())
	peer.HandleEvent(EventTaskOutput, func(body cbor.RawMessage) error {
		var out TaskOutput
		return UnmarshalBody(body, &out)
	})
	b.SetBytes(32 << 10)
	b.ReportAllocs()
	for i := 0; i < b.N; i++ {
		if err := peer.Receive(frame); err != nil {
			b.Fatal(err)
		}
	}
}
