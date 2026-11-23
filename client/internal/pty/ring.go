package pty

import (
	"sync"
)

// The ring buffer's capacity is crhs's requested scrollback size clamped to this range: small
// enough to stay a screen's worth of history, large enough that a short reconnect can still
// continue from crhs's offset, and bounded so a node cannot be asked to hold unbounded output per
// terminal (doc/design/pty.md "crha").
const (
	MinScrollbackBytes = 64 << 10
	MaxScrollbackBytes = 16 << 20
)

// clampScrollback returns the effective ring capacity for a pty.open's scrollback_bytes.
func clampScrollback(n uint64) int {
	if n < MinScrollbackBytes {
		return MinScrollbackBytes
	}
	if n > MaxScrollbackBytes {
		return MaxScrollbackBytes
	}
	return int(n)
}

// Ring is a fixed-capacity byte ring holding the latest raw output of one terminal. It is safe
// for concurrent use: the terminal's reader writes, and data connections read snapshots and
// ranges at byte offsets. Offsets count every byte ever written, so a reader that fell behind
// the retained window can be told that its next byte is already gone.
type Ring struct {
	mu    sync.Mutex
	buf   []byte
	start int    // index of the oldest byte in buf
	n     int    // number of valid bytes
	total uint64 // bytes ever written

	wake chan struct{}
}

// NewRing returns an empty ring holding at most capacity bytes.
func NewRing(capacity int) *Ring {
	if capacity <= 0 {
		capacity = 1
	}
	return &Ring{buf: make([]byte, capacity), wake: make(chan struct{}, 1)}
}

// Capacity returns the ring's capacity in bytes.
func (r *Ring) Capacity() int { return len(r.buf) }

// Write appends p, discarding the oldest bytes when the capacity is exceeded.
func (r *Ring) Write(p []byte) {
	if len(p) == 0 {
		return
	}
	r.mu.Lock()
	if len(p) >= len(r.buf) {
		// The new bytes alone fill or overflow the ring: only the tail is kept.
		copy(r.buf, p[len(p)-len(r.buf):])
		r.start, r.n = 0, len(r.buf)
	} else {
		if drop := r.n + len(p) - len(r.buf); drop > 0 {
			r.start = (r.start + drop) % len(r.buf)
			r.n -= drop
		}
		end := (r.start + r.n) % len(r.buf)
		first := copy(r.buf[end:], p)
		copy(r.buf[:], p[first:])
		r.n += len(p)
	}
	r.total += uint64(len(p))
	r.mu.Unlock()
	r.signal()
}

// Len returns the number of retained bytes.
func (r *Ring) Len() int {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.n
}

// Total returns the offset just past the last byte ever written.
func (r *Ring) Total() uint64 {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.total
}

// Snapshot returns a copy of every retained byte, oldest first, and the offset just past the
// last one.
func (r *Ring) Snapshot() ([]byte, uint64) {
	r.mu.Lock()
	defer r.mu.Unlock()
	out := make([]byte, r.n)
	if r.n > 0 {
		first := copy(out, r.buf[r.start:])
		copy(out[first:], r.buf[:r.n-first])
	}
	return out, r.total
}

// Range returns the offsets of the retained window: the oldest byte still held and the offset just
// past the newest one. A reader whose offset lies outside [start, end) can no longer continue the
// stream (doc/design/pty.md "crha").
func (r *Ring) Range() (start, end uint64) {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.total - uint64(r.n), r.total
}

// ReadFrom returns every retained byte from offset off. ok is false when off is older than the
// oldest retained byte: those bytes are gone, so the reader would have to skip output and the
// terminal's stream is lost.
func (r *Ring) ReadFrom(off uint64) (data []byte, ok bool) {
	return r.ReadAt(off, r.Capacity())
}

// ReadAt is ReadFrom with at most max bytes, so a data connection copies and sends the ring in
// protocol-sized chunks instead of allocating the whole retained window at once.
func (r *Ring) ReadAt(off uint64, max int) (data []byte, ok bool) {
	r.mu.Lock()
	defer r.mu.Unlock()
	start := r.total - uint64(r.n)
	if off < start {
		return nil, false
	}
	if off >= r.total || max <= 0 {
		return nil, true
	}
	skip := int(off - start)
	idx := (r.start + skip) % len(r.buf)
	count := min(r.n-skip, max)
	out := make([]byte, count)
	first := copy(out, r.buf[idx:])
	copy(out[first:], r.buf[:count-first])
	return out, true
}

// Wake is signalled after every Write. A data connection waits on it for live output.
func (r *Ring) Wake() <-chan struct{} { return r.wake }

func (r *Ring) signal() {
	select {
	case r.wake <- struct{}{}:
	default:
	}
}
