package executor

import (
	"bytes"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"sort"
	"sync"
)

// maxMemoryOutput bounds the output kept in memory when it cannot be spilled to a file.
const maxMemoryOutput = 16 << 20

// coalesceBytes bounds one segment: a write that fits is appended to the last segment instead of
// starting a new one. A pipe often writes a few bytes at a time, and one segment per write would
// make the segment index as long as the output is large.
const coalesceBytes = 4 << 10

// Output records a task's single output stream (stdout and stderr are connected to one pipe) for
// streaming to crhs and for resending after a reconnect. Output stays in memory until it exceeds the
// spill thresholds; then all of it, from the start, goes to <dir>/<task id>.log, with the bytes in
// write order (as `2>&1` would show them), and only an index of the segments stays in memory. With
// OutputOptions.AlwaysSpill the file is opened before the first byte, so even empty or small output
// gets one. See doc/execution-plane.md#输出.
type Output struct {
	mu         sync.Mutex
	taskID     string
	dir        string
	spillBytes uint64
	spillLines uint64

	totalBytes uint64
	totalLines uint64
	// lastByte and hasBytes keep the end of the stream, so Lines can count a trailing line that has
	// no newline. The count is updated once per written byte, not per sent chunk.
	lastByte byte
	hasBytes bool
	// end is the byte offset another chunk starts at.
	end      uint64
	segments []segment // in write order
	// memoryBytes is the sum of the inMemory segment lengths.
	memoryBytes uint64
	file        *os.File
	path        string
	fileLen     uint64
	dropped     bool // memory cap reached without a spill file
	closed      bool

	notify chan struct{}
}

type place uint8

const (
	inMemory place = iota
	inFile
	lost
)

type segment struct {
	off     uint64
	length  uint64
	place   place
	data    []byte // inMemory only
	fileOff uint64 // inFile only
}

// OutputOptions configures an Output.
type OutputOptions struct {
	// SpillBytes and SpillLines are the thresholds above which output moves from memory to the
	// output file. 0 disables that threshold.
	SpillBytes uint64
	SpillLines uint64
	// AlwaysSpill writes everything to the output file from the first byte, even when the output
	// is empty or stays below the thresholds, so the file always exists. Batch "text"/"status"
	// tasks use it. If the file cannot be created, output stays in memory like before.
	AlwaysSpill bool
}

func NewOutput(taskID, dir string, opts OutputOptions) *Output {
	o := &Output{taskID: taskID, dir: dir, spillBytes: opts.SpillBytes, spillLines: opts.SpillLines, notify: make(chan struct{}, 1)}
	if opts.AlwaysSpill {
		o.createFile()
	}
	return o
}

// Notify is signalled (without blocking) whenever output is added. The channel is closed by
// Close, so a watcher that ranges over it ends with the output.
func (o *Output) Notify() <-chan struct{} { return o.notify }

// Writer returns the one writer both the process's stdout and stderr connect to, so their bytes
// interleave in write order (doc/execution-plane.md#输出).
func (o *Output) Writer() io.Writer { return outputWriter{o} }

type outputWriter struct{ o *Output }

func (w outputWriter) Write(p []byte) (int, error) {
	w.o.append(p)
	return len(p), nil
}

func (o *Output) append(p []byte) {
	if len(p) == 0 {
		return
	}
	o.mu.Lock()
	defer o.mu.Unlock()
	if o.closed {
		return
	}
	n := uint64(len(p))
	o.end += n
	o.totalBytes += n
	o.totalLines += uint64(bytes.Count(p, []byte{'\n'}))
	o.lastByte, o.hasBytes = p[len(p)-1], true

	if o.file == nil && !o.dropped && o.overThreshold() {
		o.spill()
	}
	if o.file != nil {
		if _, err := o.file.WriteAt(p, int64(o.fileLen)); err == nil {
			if last := o.coalescible(inFile, n); last != nil {
				last.length += n
			} else {
				o.addSegment(segment{off: o.end - n, length: n, place: inFile, fileOff: o.fileLen})
			}
			o.fileLen += n
			o.signal()
			return
		}
		// A broken spill file: keep what is there, continue in memory.
		o.file.Close()
		o.file = nil
		o.dropped = true
	}
	if o.memoryBytes+n > maxMemoryOutput {
		// Over the memory cap: keep offsets consistent but discard the bytes.
		if last := o.coalescible(lost, n); last != nil {
			last.length += n
		} else {
			o.addSegment(segment{off: o.end - n, length: n, place: lost})
		}
	} else if last := o.coalescible(inMemory, n); last != nil {
		last.data = append(last.data, p...)
		last.length += n
		o.memoryBytes += n
	} else {
		o.addSegment(segment{
			off: o.end - n, length: n, place: inMemory,
			data: append([]byte(nil), p...),
		})
		o.memoryBytes += n
	}
	o.signal()
}

// coalescible returns the newest segment if a write of n bytes can be appended to it. Only the last
// segment may grow: extending an earlier one would move bytes written after other output, which
// would change the order of the spill file (doc/execution-plane.md#输出).
func (o *Output) coalescible(place place, n uint64) *segment {
	if len(o.segments) == 0 {
		return nil
	}
	last := &o.segments[len(o.segments)-1]
	if last.place != place || last.length+n > coalesceBytes {
		return nil
	}
	return last
}

// addSegment appends seg to the segment list.
func (o *Output) addSegment(seg segment) {
	o.segments = append(o.segments, seg)
}

func (o *Output) overThreshold() bool {
	return (o.spillBytes > 0 && o.totalBytes > o.spillBytes) || (o.spillLines > 0 && o.totalLines > o.spillLines)
}

// createFile opens <dir>/<task id>.log and makes it the output file. It returns false and leaves the
// Output unchanged when no file can be created, in which case output stays in memory. Callers hold
// o.mu or own o exclusively.
func (o *Output) createFile() bool {
	if o.dir == "" || o.file != nil {
		return false
	}
	path := filepath.Join(o.dir, o.taskID+".log")
	f, err := os.OpenFile(path, os.O_RDWR|os.O_CREATE|os.O_EXCL, 0o600)
	if err != nil {
		return false
	}
	o.file, o.path, o.fileLen = f, path, 0
	return true
}

// spill moves everything recorded so far into the output file. On failure output stays in memory
// (up to maxMemoryOutput).
func (o *Output) spill() {
	if !o.createFile() {
		return
	}
	var off uint64
	for _, s := range o.segments {
		if _, err := o.file.WriteAt(s.data, int64(off)); err != nil {
			o.file.Close()
			os.Remove(o.path)
			o.file, o.path, o.fileLen = nil, "", 0
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
	o.fileLen = off
	o.memoryBytes = 0
}

// signal wakes a watcher without blocking. Callers hold o.mu, which also serializes it with
// Close's close of the channel, and closed keeps it from sending after that close.
func (o *Output) signal() {
	if o.closed {
		return
	}
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
	// Closing the channel ends every forward range: the last buffered signal may already
	// have been consumed, so a final send would leave the watcher blocked forever.
	close(o.notify)
}

// Release frees memory and file handles after crhs acknowledged the exit. The spill file stays on disk.
func (o *Output) Release() {
	o.mu.Lock()
	defer o.mu.Unlock()
	o.segments = nil
	o.memoryBytes = 0
	if o.file != nil {
		o.file.Close()
		o.file = nil
	}
}

// End returns the current end offset of the output stream.
func (o *Output) End() uint64 {
	o.mu.Lock()
	defer o.mu.Unlock()
	return o.end
}

// Lines returns the number of lines of the output, the same bytes the spill file holds: the
// newline count, plus one when the output does not end with a newline, and 0 when nothing was
// written (doc/protocol.md TaskExit).
func (o *Output) Lines() uint64 {
	o.mu.Lock()
	defer o.mu.Unlock()
	if !o.hasBytes {
		return 0
	}
	if o.lastByte == '\n' {
		return o.totalLines
	}
	return o.totalLines + 1
}

// Path returns the spill file, or "" if output stayed in memory.
func (o *Output) Path() string {
	o.mu.Lock()
	defer o.mu.Unlock()
	return o.path
}

var ErrOutputLost = errors.New("output no longer available")

// ReadAt returns up to max bytes of the output starting at off. It returns no data at the end of the
// output. Bytes discarded under memory pressure come back as ErrOutputLost.
func (o *Output) ReadAt(off uint64, max int) ([]byte, error) {
	o.mu.Lock()
	defer o.mu.Unlock()
	first := sort.Search(len(o.segments), func(k int) bool {
		s := o.segments[k]
		return s.off+s.length > off
	})
	var out []byte
	for _, s := range o.segments[first:] {
		if len(out) >= max {
			break
		}
		start := off + uint64(len(out)) - s.off
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
			return nil, fmt.Errorf("%w: offset %d", ErrOutputLost, off)
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
