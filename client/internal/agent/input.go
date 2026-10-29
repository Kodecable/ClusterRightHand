package agent

import (
	"io"
	"sync"
)

// inputQueue is one task's input stream (exec stdin or file.write content). The receive loop pushes
// task.input chunks into it and the executor reads them through io.Reader. It replaces an io.Pipe
// whose writer blocked the receive loop: push never blocks, and the buffered data is bounded by the
// declared input size, which crhs bounds.
type inputQueue struct {
	mu     sync.Mutex
	cond   *sync.Cond
	chunks [][]byte
	closed bool
	err    error
}

func newInputQueue() *inputQueue {
	q := &inputQueue{}
	q.cond = sync.NewCond(&q.mu)
	return q
}

// push appends a chunk. It never blocks. Chunks pushed after close or fail are dropped.
func (q *inputQueue) push(chunk []byte) {
	q.mu.Lock()
	defer q.mu.Unlock()
	if q.closed || q.err != nil {
		return
	}
	q.chunks = append(q.chunks, chunk)
	q.cond.Signal()
}

// close marks the input complete: Read returns io.EOF once the buffered chunks are drained.
func (q *inputQueue) close() {
	q.mu.Lock()
	defer q.mu.Unlock()
	if q.closed || q.err != nil {
		return
	}
	q.closed = true
	q.cond.Broadcast()
}

// fail aborts the input with err: buffered chunks are dropped and Read returns err. The first error
// wins, and a queue that already completed is left alone.
func (q *inputQueue) fail(err error) {
	q.mu.Lock()
	defer q.mu.Unlock()
	if q.closed || q.err != nil {
		return
	}
	q.err, q.chunks = err, nil
	q.cond.Broadcast()
}

// discard drops the buffered input once the task finished. Read returns io.EOF afterwards; it only
// matters for a reader the executor left behind, which must not stay blocked.
func (q *inputQueue) discard() {
	q.mu.Lock()
	defer q.mu.Unlock()
	q.closed, q.chunks = true, nil
	q.cond.Broadcast()
}

// complete reports whether the input was closed or failed, i.e. no more chunks will be read.
func (q *inputQueue) complete() bool {
	q.mu.Lock()
	defer q.mu.Unlock()
	return q.closed || q.err != nil
}

// Read implements io.Reader: it blocks until a chunk is pushed, the input is closed (io.EOF after the
// buffered chunks) or failed (the recorded error).
func (q *inputQueue) Read(p []byte) (int, error) {
	q.mu.Lock()
	defer q.mu.Unlock()
	for len(q.chunks) == 0 && !q.closed && q.err == nil {
		q.cond.Wait()
	}
	if q.err != nil {
		return 0, q.err
	}
	if len(q.chunks) == 0 {
		return 0, io.EOF
	}
	n := copy(p, q.chunks[0])
	if n == len(q.chunks[0]) {
		q.chunks = q.chunks[1:]
	} else {
		q.chunks[0] = q.chunks[0][n:]
	}
	return n, nil
}
