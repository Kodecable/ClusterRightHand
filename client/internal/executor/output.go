package executor

import (
	"bytes"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"sync"

	"github.com/Kodecable/ClusterRightHand/client/internal/protocol"
)

// maxMemoryOutput bounds the output kept in memory when it cannot be spilled to a file.
const maxMemoryOutput = 16 << 20

// StreamSlots is the number of output streams the protocol carries: stdout and stderr.
const StreamSlots = 2

// StreamIndex maps a protocol stream to its offset slot: 0 for stdout, 1 for stderr. The
// protocol enum has exactly those two values (the decoder rejects anything else), so an
// unknown value can only come from Go code and is treated as stdout.
func StreamIndex(stream protocol.Stream) int {
	if stream == protocol.StreamStderr {
		return 1
	}
	return 0
}

// Output records a task's stdout and stderr for streaming to crhs and for resending after a reconnect.
// Output stays in memory until it exceeds the spill thresholds; then all of it, from the start, goes to
// <dir>/<task id>.log, with both streams interleaved in arrival order (as `2>&1` would show them), and
// only an index of the segments stays in memory. See doc/execution-plane.md#输出.
type Output struct {
	mu         sync.Mutex
	taskID     string
	dir        string
	spillBytes uint64
	spillLines uint64

	totalBytes uint64
	totalLines uint64
	ends       [StreamSlots]uint64 // indexed by StreamIndex
	segments   []segment           // in arrival order
	file       *os.File
	path       string
	fileLen    uint64
	dropped    bool // memory cap reached without a spill file
	closed     bool

	notify chan struct{}
}

type place uint8

const (
	inMemory place = iota
	inFile
	lost
)

type segment struct {
	stream    protocol.Stream
	streamOff uint64
	length    uint64
	place     place
	data      []byte // inMemory only
	fileOff   uint64 // inFile only
}

func NewOutput(taskID, dir string, spillBytes, spillLines uint64) *Output {
	return &Output{taskID: taskID, dir: dir, spillBytes: spillBytes, spillLines: spillLines, notify: make(chan struct{}, 1)}
}

// Notify is signalled (without blocking) whenever output is added or the output is closed.
func (o *Output) Notify() <-chan struct{} { return o.notify }

func (o *Output) Writer(stream protocol.Stream) io.Writer { return streamWriter{o, stream} }

type streamWriter struct {
	o      *Output
	stream protocol.Stream
}

func (w streamWriter) Write(p []byte) (int, error) {
	w.o.append(w.stream, p)
	return len(p), nil
}

func (o *Output) append(stream protocol.Stream, p []byte) {
	if len(p) == 0 {
		return
	}
	o.mu.Lock()
	defer o.mu.Unlock()
	if o.closed {
		return
	}
	idx := StreamIndex(stream)
	seg := segment{stream: stream, streamOff: o.ends[idx], length: uint64(len(p))}
	o.ends[idx] += seg.length
	o.totalBytes += seg.length
	o.totalLines += uint64(bytes.Count(p, []byte{'\n'}))

	if o.file == nil && !o.dropped && o.overThreshold() {
		o.spill()
	}
	if o.file != nil {
		if _, err := o.file.WriteAt(p, int64(o.fileLen)); err == nil {
			seg.place, seg.fileOff = inFile, o.fileLen
			o.fileLen += seg.length
		} else {
			// A broken spill file: keep what is there, continue in memory.
			o.file.Close()
			o.file = nil
			o.dropped = true
		}
	}
	if seg.place != inFile {
		if o.memoryBytes()+seg.length > maxMemoryOutput {
			// Over the memory cap: keep offsets consistent but discard the bytes.
			seg.place = lost
		} else {
			seg.data = append([]byte(nil), p...)
		}
	}
	o.segments = append(o.segments, seg)
	o.signal()
}

func (o *Output) overThreshold() bool {
	return (o.spillBytes > 0 && o.totalBytes > o.spillBytes) || (o.spillLines > 0 && o.totalLines > o.spillLines)
}

func (o *Output) memoryBytes() uint64 {
	var n uint64
	for _, s := range o.segments {
		if s.place == inMemory {
			n += s.length
		}
	}
	return n
}

// spill moves everything recorded so far into the output file. On failure output stays in memory
// (up to maxMemoryOutput).
func (o *Output) spill() {
	if o.dir == "" {
		return
	}
	path := filepath.Join(o.dir, o.taskID+".log")
	f, err := os.OpenFile(path, os.O_RDWR|os.O_CREATE|os.O_EXCL, 0o600)
	if err != nil {
		return
	}
	var off uint64
	for _, s := range o.segments {
		if _, err := f.WriteAt(s.data, int64(off)); err != nil {
			f.Close()
			os.Remove(path)
			return
		}
		off += s.length
	}
	off = 0
	for i := range o.segments {
		s := &o.segments[i]
		s.place, s.fileOff, s.data = inFile, off, nil
		off += s.length
	}
	o.file, o.path, o.fileLen = f, path, off
}

func (o *Output) signal() {
	select {
	case o.notify <- struct{}{}:
	default:
	}
}

// Close marks the end of output; it must be called once the process has exited.
func (o *Output) Close() {
	o.mu.Lock()
	defer o.mu.Unlock()
	if o.closed {
		return
	}
	o.closed = true
	if o.file != nil {
		_ = o.file.Sync()
	}
	o.signal()
}

// Release frees memory and file handles after crhs acknowledged the exit. The spill file stays on disk.
func (o *Output) Release() {
	o.mu.Lock()
	defer o.mu.Unlock()
	o.segments = nil
	if o.file != nil {
		o.file.Close()
		o.file = nil
	}
}

// End returns the current end offset of a stream.
func (o *Output) End(stream protocol.Stream) uint64 {
	o.mu.Lock()
	defer o.mu.Unlock()
	return o.ends[StreamIndex(stream)]
}

// Path returns the spill file, or "" if output stayed in memory.
func (o *Output) Path() string {
	o.mu.Lock()
	defer o.mu.Unlock()
	return o.path
}

var ErrOutputLost = errors.New("output no longer available")

// ReadAt returns up to max bytes of a stream starting at off. It returns no data at the end of the
// stream. Bytes discarded under memory pressure come back as ErrOutputLost.
func (o *Output) ReadAt(stream protocol.Stream, off uint64, max int) ([]byte, error) {
	o.mu.Lock()
	defer o.mu.Unlock()
	var out []byte
	for _, s := range o.segments {
		if s.stream != stream || s.streamOff+s.length <= off {
			continue
		}
		if len(out) >= max {
			break
		}
		start := off + uint64(len(out)) - s.streamOff
		n := min(s.length-start, uint64(max-len(out)))
		switch s.place {
		case inMemory:
			out = append(out, s.data[start:start+n]...)
		case inFile:
			buf := make([]byte, n)
			if err := o.readFile(buf, s.fileOff+start); err != nil {
				return out, err
			}
			out = append(out, buf...)
		default:
			if len(out) > 0 {
				return out, nil
			}
			return nil, fmt.Errorf("%w: %s offset %d", ErrOutputLost, stream, off)
		}
	}
	return out, nil
}

func (o *Output) readFile(buf []byte, off uint64) error {
	f := o.file
	if f == nil {
		var err error
		if f, err = os.Open(o.path); err != nil {
			return err
		}
		defer f.Close()
	}
	_, err := f.ReadAt(buf, int64(off))
	return err
}
