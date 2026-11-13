// Package taskinput is the input accounting of one task, shared by the agent (the unprivileged
// mode, which receives task.input from crhs) and by the privileged task runner (which receives it
// over crh-priv). It owns which tasks declare input, the offset, size and SHA-256 checks of every
// chunk, and whether the declared input is complete (doc/design/protocol.md "Commands").
package taskinput

import (
	"bytes"
	"crypto/sha256"
	"fmt"
	"hash"

	"github.com/Kodecable/ClusterRightHand/client/internal/protocol"
)

// emptySHA256 is the SHA-256 of empty input, which an InputRef of size 0 must declare.
var emptySHA256 = protocol.Hash(sha256.Sum256(nil))

// Ref returns the input a task spec declares, or nil: an exec task declares its stdin, a file.write
// task its content, and a file.push task the content that arrives on its data connection.
func Ref(spec *protocol.TaskSpec) *protocol.InputRef {
	switch spec.Kind {
	case protocol.TaskSpecExec:
		if spec.Exec != nil {
			return spec.Exec.Stdin
		}
	case protocol.TaskSpecFileWrite:
		if spec.FileWrite != nil {
			return &spec.FileWrite.Content
		}
	case protocol.TaskSpecFilePush:
		if spec.FilePush != nil {
			return &protocol.InputRef{Size: spec.FilePush.Size, SHA256: spec.FilePush.SHA256}
		}
	}
	return nil
}

// ValidateRef checks the declaration of ref, nil when the task declares no input: a zero-size input
// still commits the sender to the SHA-256 of empty input, and a different hash can never match, so
// the declaration is refused before the task is accepted.
func ValidateRef(ref *protocol.InputRef) *protocol.RemoteError {
	if ref != nil && ref.Size == 0 && ref.SHA256 != emptySHA256 {
		return &protocol.RemoteError{Code: protocol.CodeInvalidSpec, Message: "input size 0 requires the sha256 of empty input"}
	}
	return nil
}

// Input is the input accounting of one task. The zero Input declares no input.
type Input struct {
	declared bool
	size     uint64
	want     protocol.Hash
	hasher   hash.Hash
	offset   uint64
}

// New returns the input state of a task that declared ref.
func New(ref *protocol.InputRef) Input {
	return Input{declared: true, size: uint64(ref.Size), want: ref.SHA256, hasher: sha256.New()}
}

// Declared reports whether the task declared input at all.
func (in *Input) Declared() bool { return in.declared }

// Size is the declared input size in bytes.
func (in *Input) Size() uint64 { return in.size }

// Offset is how many bytes arrived.
func (in *Input) Offset() uint64 { return in.offset }

// Complete reports whether every declared byte arrived, or the task declared none.
func (in *Input) Complete() bool { return !in.declared || in.offset >= in.size }

// Advance records that everything up to end arrived, without checking it against the declaration:
// the privileged mode that received a forwarded chunk does that accounting itself, and only how
// much arrived matters here, so a session that ends mid-input can still end the task.
func (in *Input) Advance(end uint64) {
	if end > in.offset {
		in.offset = end
	}
}

// ChunkResult is what one task.input chunk did to the input.
type ChunkResult struct {
	// Data is the chunk's data when it belongs to the input, for the caller to store in the task's
	// input stream. It is nil for a refused chunk and for one that cannot complete the input.
	Data []byte
	// Complete is true when the declared input is complete after this chunk.
	Complete bool
	// Refusal is the error response of a chunk that is not part of the input.
	Refusal *protocol.RemoteError
	// Failure is why the input can no longer match its declaration. A chunk that carries it ended
	// the task's input: the caller records it as the task's input error, because the input and not
	// the process decides the outcome of the task.
	Failure *protocol.Error
}

// Accept applies the offset, size and SHA-256 accounting of one task.input chunk. The error codes
// are the ones of doc/design/protocol.md "Commands"; taskID appears in their messages.
func (in *Input) Accept(taskID string, chunk *protocol.TaskInput) ChunkResult {
	tooLarge := func() *protocol.RemoteError {
		return &protocol.RemoteError{
			Code:    protocol.CodeInputTooLarge,
			Message: fmt.Sprintf("task %s input exceeds the declared %d bytes", taskID, in.size),
		}
	}
	if uint64(chunk.Offset) != in.offset {
		return ChunkResult{Refusal: &protocol.RemoteError{
			Code:    protocol.CodeInputOutOfOrder,
			Message: fmt.Sprintf("task %s input offset %d, want %d", taskID, chunk.Offset, in.offset),
		}}
	}
	if !in.declared || in.offset >= in.size {
		// The task declared no input, or it is already complete: only an empty chunk is harmless.
		if len(chunk.Data) == 0 {
			return ChunkResult{}
		}
		return ChunkResult{Refusal: tooLarge()}
	}
	if in.offset+uint64(len(chunk.Data)) > in.size {
		in.offset += uint64(len(chunk.Data))
		return ChunkResult{
			Refusal: tooLarge(),
			Failure: &protocol.Error{
				Code:    protocol.CodeInputMismatch,
				Message: fmt.Sprintf("task %s input is longer than the declared %d bytes", taskID, in.size),
			},
		}
	}
	in.offset += uint64(len(chunk.Data))
	_, _ = in.hasher.Write(chunk.Data)
	if in.offset == in.size && !bytes.Equal(in.hasher.Sum(nil), in.want[:]) {
		return ChunkResult{Failure: &protocol.Error{
			Code:    protocol.CodeInputMismatch,
			Message: fmt.Sprintf("task %s input does not match the declared sha256", taskID),
		}}
	}
	return ChunkResult{Data: chunk.Data, Complete: in.offset >= in.size}
}
