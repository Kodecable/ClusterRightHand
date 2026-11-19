package executor

import (
	"context"
	"io"
	"sync"
)

// MaxBufferedBytes is how much input a data-connection push buffers ahead of its reader. A push reads
// its data connection as fast as the network allows; without this bound, a slow disk would make it
// buffer the whole file in memory.
const MaxBufferedBytes = 8 << 20

// Input is one task's input stream: exec stdin or file.write content. The receiver pushes chunks as
// they arrive and the executor reads them through io.Reader. It replaces an io.Pipe whose writer
// blocked the receive loop: Push never blocks, and the buffered data is bounded by the declared
// input size, which crhs bounds. A data-connection push uses PushWait, which does block once
// MaxBufferedBytes wait for the reader.
type Input struct {
	mu     sync.Mutex
	cond   *sync.Cond
	chunks [][]byte
	closed bool
	err    error
}

// NewInput returns an empty, open input stream.
func NewInput() *Input {
	in := &Input{}
	in.cond = sync.NewCond(&in.mu)
	return in
}

// Push appends a chunk. It never blocks. Chunks pushed after Close or Fail are dropped.
func (in *Input) Push(chunk []byte) {
	in.mu.Lock()
	defer in.mu.Unlock()
	if in.closed || in.err != nil {
		return
	}
	in.chunks = append(in.chunks, chunk)
	in.cond.Signal()
}

// PushWait appends a chunk, waiting while MaxBufferedBytes are already buffered: the reader releases
// it, and Close, Fail, Discard or the end of ctx release it too. Only the data-connection push path
// uses it, so its socket read follows the consumer instead of buffering the whole file; a chunk that
// arrives after the stream closed or failed is dropped, as Push drops it. It returns ctx.Err() when
// ctx ended while waiting.
func (in *Input) PushWait(ctx context.Context, chunk []byte) error {
	in.mu.Lock()
	defer in.mu.Unlock()
	stop := context.AfterFunc(ctx, func() {
		in.mu.Lock()
		in.cond.Broadcast()
		in.mu.Unlock()
	})
	defer stop()
	for in.buffered() >= MaxBufferedBytes && !in.closed && in.err == nil && ctx.Err() == nil {
		in.cond.Wait()
	}
	if err := ctx.Err(); err != nil {
		return err
	}
	if in.closed || in.err != nil {
		return nil
	}
	in.chunks = append(in.chunks, chunk)
	in.cond.Signal()
	return nil
}

// buffered is how many bytes wait for the reader. in.mu must be held.
func (in *Input) buffered() int {
	total := 0
	for _, chunk := range in.chunks {
		total += len(chunk)
	}
	return total
}

// Close marks the input complete: Read returns io.EOF once the buffered chunks are drained.
func (in *Input) Close() {
	in.mu.Lock()
	defer in.mu.Unlock()
	if in.closed || in.err != nil {
		return
	}
	in.closed = true
	in.cond.Broadcast()
}

// Fail aborts the input with err: buffered chunks are dropped and Read returns err. The first error
// wins, and a stream that already completed is left alone.
func (in *Input) Fail(err error) {
	in.mu.Lock()
	defer in.mu.Unlock()
	if in.closed || in.err != nil {
		return
	}
	in.err, in.chunks = err, nil
	in.cond.Broadcast()
}

// Discard drops the buffered input once the task finished. Read returns io.EOF afterwards; it only
// matters for a reader the executor left behind, which must not stay blocked.
func (in *Input) Discard() {
	in.mu.Lock()
	defer in.mu.Unlock()
	in.closed, in.chunks = true, nil
	in.cond.Broadcast()
}

// Complete reports whether the input was closed or failed, i.e. no more chunks will be read.
func (in *Input) Complete() bool {
	in.mu.Lock()
	defer in.mu.Unlock()
	return in.closed || in.err != nil
}

// Read implements io.Reader: it blocks until a chunk is pushed, the input is closed (io.EOF after
// the buffered chunks) or failed (the recorded error).
func (in *Input) Read(p []byte) (int, error) {
	in.mu.Lock()
	defer in.mu.Unlock()
	for len(in.chunks) == 0 && !in.closed && in.err == nil {
		in.cond.Wait()
	}
	if in.err != nil {
		return 0, in.err
	}
	if len(in.chunks) == 0 {
		return 0, io.EOF
	}
	n := copy(p, in.chunks[0])
	if n == len(in.chunks[0]) {
		in.chunks = in.chunks[1:]
	} else {
		in.chunks[0] = in.chunks[0][n:]
	}
	// A data-connection push waits for room and is released by this read.
	in.cond.Broadcast()
	return n, nil
}
