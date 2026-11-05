package executor

import (
	"bytes"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/Kodecable/ClusterRightHand/client/internal/protocol"
)

const (
	stdout = protocol.StreamStdout
	stderr = protocol.StreamStderr
)

func readAll(t *testing.T, o *Output, s protocol.Stream, from uint64) string {
	t.Helper()
	var buf bytes.Buffer
	for {
		b, err := o.ReadAt(s, from+uint64(buf.Len()), 7) // small reads cross segment boundaries
		if err != nil {
			t.Fatal(err)
		}
		if len(b) == 0 {
			return buf.String()
		}
		buf.Write(b)
	}
}

func TestOutputInMemory(t *testing.T) {
	o := NewOutput("t1", t.TempDir(), OutputOptions{SpillBytes: 1024, SpillLines: 100})
	o.Writer(stdout).Write([]byte("hello "))
	o.Writer(stderr).Write([]byte("oops\n"))
	o.Writer(stdout).Write([]byte("world\n"))
	if got := readAll(t, o, stdout, 0); got != "hello world\n" {
		t.Fatalf("stdout = %q", got)
	}
	if got := readAll(t, o, stdout, 6); got != "world\n" {
		t.Fatalf("stdout from 6 = %q", got)
	}
	if got := readAll(t, o, stderr, 0); got != "oops\n" {
		t.Fatalf("stderr = %q", got)
	}
	if o.Path() != "" || o.End(stdout) != 12 || o.End(stderr) != 5 {
		t.Fatalf("path %q ends %d %d", o.Path(), o.End(stdout), o.End(stderr))
	}
}

// TestOutputLines covers the line count of the merged output (doc/protocol.md TaskExit): the
// newline count plus a last line without one, and 0 for no output, whether the bytes stayed in
// memory or were spilled.
func TestOutputLines(t *testing.T) {
	type write struct {
		stream protocol.Stream
		text   string
	}
	for _, tc := range []struct {
		name   string
		opts   OutputOptions
		writes []write
		want   uint64
		spill  bool
	}{
		{name: "no output in memory", want: 0},
		{name: "no output always spilled", opts: OutputOptions{AlwaysSpill: true}, want: 0, spill: true},
		{name: "trailing newline", writes: []write{{stdout, "a\nb\n"}}, want: 2},
		{name: "no trailing newline", writes: []write{{stdout, "a\nb"}}, want: 2},
		{name: "single newline", writes: []write{{stderr, "\n"}}, want: 1},
		{
			name: "interleaved streams",
			writes: []write{
				{stdout, "a\n"},
				{stderr, "b"},
				{stdout, "c\n"},
				{stderr, "d"},
			},
			want: 3,
		},
		{
			name:   "spilled with trailing newline",
			opts:   OutputOptions{SpillBytes: 2},
			writes: []write{{stdout, "a\n"}, {stderr, "b"}, {stdout, "c\n"}},
			want:   2,
			spill:  true,
		},
		{
			name:   "spilled without trailing newline",
			opts:   OutputOptions{SpillBytes: 2},
			writes: []write{{stdout, "a\n"}, {stderr, "b"}},
			want:   2,
			spill:  true,
		},
		{
			name:   "small always spilled without newline",
			opts:   OutputOptions{AlwaysSpill: true},
			writes: []write{{stdout, "x"}},
			want:   1,
			spill:  true,
		},
	} {
		t.Run(tc.name, func(t *testing.T) {
			o := NewOutput("lines", t.TempDir(), tc.opts)
			var merged strings.Builder
			for _, w := range tc.writes {
				if _, err := o.Writer(w.stream).Write([]byte(w.text)); err != nil {
					t.Fatal(err)
				}
				merged.WriteString(w.text)
			}
			o.Close()
			if got := o.Path() != ""; got != tc.spill {
				t.Fatalf("spilled = %v, want %v (path %q)", got, tc.spill, o.Path())
			}
			if tc.spill {
				data, err := os.ReadFile(o.Path())
				if err != nil {
					t.Fatal(err)
				}
				if string(data) != merged.String() {
					t.Fatalf("file = %q, want %q", data, merged.String())
				}
			}
			if got := o.Lines(); got != tc.want {
				t.Fatalf("Lines() = %d, want %d", got, tc.want)
			}
		})
	}
}

func TestOutputSpillsByBytes(t *testing.T) {
	dir := t.TempDir()
	o := NewOutput("t2", dir, OutputOptions{SpillBytes: 10})
	o.Writer(stdout).Write([]byte("aaaa"))
	o.Writer(stderr).Write([]byte("EE"))
	if o.Path() != "" {
		t.Fatal("spilled too early")
	}
	o.Writer(stdout).Write([]byte("bbbbbb")) // 12 bytes > 10
	o.Writer(stderr).Write([]byte("FF"))
	o.Close()
	path := o.Path()
	if path != filepath.Join(dir, "t2.log") {
		t.Fatalf("path = %q", path)
	}
	data, _ := os.ReadFile(path)
	if string(data) != "aaaaEEbbbbbbFF" {
		t.Fatalf("file = %q", data)
	}
	if info, _ := os.Stat(path); info.Mode().Perm() != 0o600 {
		t.Fatalf("mode = %v", info.Mode())
	}
	if got := readAll(t, o, stdout, 2); got != "aabbbbbb" {
		t.Fatalf("stdout from 2 = %q", got)
	}
	if got := readAll(t, o, stderr, 0); got != "EEFF" {
		t.Fatalf("stderr = %q", got)
	}
	o.Release()
	if _, err := os.Stat(path); err != nil {
		t.Fatal("spill file removed on release")
	}
}

func TestOutputSpillsByLines(t *testing.T) {
	o := NewOutput("t3", t.TempDir(), OutputOptions{SpillLines: 3})
	o.Writer(stdout).Write([]byte("1\n2\n3\n"))
	if o.Path() != "" {
		t.Fatal("spilled at the limit")
	}
	o.Writer(stdout).Write([]byte("4\n"))
	if o.Path() == "" {
		t.Fatal("did not spill over the limit")
	}
	if got := readAll(t, o, stdout, 0); got != "1\n2\n3\n4\n" {
		t.Fatalf("stdout = %q", got)
	}
}

func TestOutputAlwaysSpillsEmpty(t *testing.T) {
	dir := t.TempDir()
	o := NewOutput("t6", dir, OutputOptions{SpillBytes: 1024, SpillLines: 100, AlwaysSpill: true})
	// The file exists from the start, so a batch task always gets a path for task.exit.
	path := filepath.Join(dir, "t6.log")
	if o.Path() != path {
		t.Fatalf("path = %q, want %q", o.Path(), path)
	}
	o.Close()
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if len(data) != 0 {
		t.Fatalf("file = %q, want empty", data)
	}
	info, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	if info.Mode().Perm() != 0o600 {
		t.Fatalf("mode = %v", info.Mode())
	}
}

func TestOutputAlwaysSpillsSmall(t *testing.T) {
	dir := t.TempDir()
	o := NewOutput("t7", dir, OutputOptions{SpillBytes: 1 << 20, SpillLines: 2000, AlwaysSpill: true})
	o.Writer(stdout).Write([]byte("hello "))
	o.Writer(stderr).Write([]byte("oops\n"))
	o.Writer(stdout).Write([]byte("world\n"))
	o.Close()
	path := filepath.Join(dir, "t7.log")
	if o.Path() != path {
		t.Fatalf("path = %q", o.Path())
	}
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if string(data) != "hello oops\nworld\n" {
		t.Fatalf("file = %q, want the interleaved 2>&1 stream", data)
	}
	if got := readAll(t, o, stdout, 0); got != "hello world\n" {
		t.Fatalf("stdout = %q", got)
	}
	if got := readAll(t, o, stderr, 0); got != "oops\n" {
		t.Fatalf("stderr = %q", got)
	}
}

func TestOutputAlwaysSpillFallsBackToMemory(t *testing.T) {
	o := NewOutput("t8", filepath.Join(t.TempDir(), "missing"), OutputOptions{SpillBytes: 1 << 20, SpillLines: 2000, AlwaysSpill: true})
	if o.Path() != "" {
		t.Fatalf("path = %q, want no file", o.Path())
	}
	o.Writer(stdout).Write([]byte("x"))
	o.Close()
	if got := readAll(t, o, stdout, 0); got != "x" {
		t.Fatalf("stdout = %q", got)
	}
}

func TestOutputWithoutSpillDir(t *testing.T) {
	o := NewOutput("t4", filepath.Join(t.TempDir(), "missing"), OutputOptions{SpillBytes: 4})
	o.Writer(stdout).Write([]byte(strings.Repeat("x", 100)))
	if o.Path() != "" {
		t.Fatal("spilled into a missing dir")
	}
	if got := readAll(t, o, stdout, 90); got != strings.Repeat("x", 10) {
		t.Fatalf("stdout = %q", got)
	}
}

func TestOutputNotify(t *testing.T) {
	o := NewOutput("t5", "", OutputOptions{})
	o.Writer(stdout).Write([]byte("x"))
	select {
	case <-o.Notify():
	default:
		t.Fatal("no notification")
	}
}

// TestOutputNotifyCloses covers the end of the stream: Close must close the notification
// channel even when the watcher already consumed the last signal, so a forward goroutine
// ranging over it cannot block forever. Writes after Close are ignored, not panics.
func TestOutputNotifyCloses(t *testing.T) {
	o := NewOutput("t9", "", OutputOptions{})
	done := make(chan struct{})
	go func() {
		for range o.Notify() {
		}
		close(done)
	}()
	o.Writer(stdout).Write([]byte("x"))
	o.Close()
	select {
	case <-done:
	case <-time.After(5 * time.Second):
		t.Fatal("Close did not end the notification watcher")
	}
	if _, ok := <-o.Notify(); ok {
		t.Fatal("notification channel is still open after Close")
	}
	o.Close() // a second Close must be a no-op
	o.Writer(stdout).Write([]byte("after close"))
	if got := readAll(t, o, stdout, 0); got != "x" {
		t.Fatalf("stdout = %q, want %q", got, "x")
	}
}

// TestOutputManySmallWrites covers the segment index under a flood of tiny writes, the shape of a
// pipe: writes are coalesced into a few segments and ReadAt finds its segment by binary search, so
// reading does not scan the whole output for every chunk. Without both, 100k one-byte writes make
// every read quadratic.
func TestOutputManySmallWrites(t *testing.T) {
	const writes = 100_000
	o := NewOutput("tiny", "", OutputOptions{})
	w := o.Writer(stdout)
	for i := range writes {
		if _, err := w.Write([]byte{byte(i)}); err != nil {
			t.Fatal(err)
		}
	}
	// One segment per write would leave ~100k entries; coalescing leaves about writes/coalesceBytes.
	if got := len(o.streams[StreamIndex(stdout)]); got > writes/coalesceBytes+1 {
		t.Fatalf("%d segments for %d one-byte writes", got, writes)
	}
	if end := o.End(stdout); end != writes {
		t.Fatalf("end = %d, want %d", end, writes)
	}
	start := time.Now()
	for off := uint64(0); off < writes; off += 7 {
		b, err := o.ReadAt(stdout, off, 7)
		if err != nil {
			t.Fatalf("ReadAt(%d): %v", off, err)
		}
		if want := min(7, writes-int(off)); len(b) != want {
			t.Fatalf("ReadAt(%d) = %d bytes, want %d", off, len(b), want)
		}
		if b[0] != byte(off) {
			t.Fatalf("byte at %d = %d, want %d", off, b[0], byte(off))
		}
	}
	if elapsed := time.Since(start); elapsed > 2*time.Second {
		t.Fatalf("reading %d bytes took %v, want a fast scan", writes, elapsed)
	}
}

// TestOutputCoalescingKeepsInterleaving covers the spill file: a segment may only grow while it is
// the newest one, so the file keeps the arrival order of the two streams (doc/execution-plane.md
// 输出).
func TestOutputCoalescingKeepsInterleaving(t *testing.T) {
	o := NewOutput("interleaved", t.TempDir(), OutputOptions{SpillBytes: 10})
	var want strings.Builder
	for range 100 {
		o.Writer(stdout).Write([]byte("a"))
		o.Writer(stderr).Write([]byte("b"))
		want.WriteString("ab")
	}
	o.Close()
	if o.Path() == "" {
		t.Fatal("output did not spill")
	}
	data, err := os.ReadFile(o.Path())
	if err != nil {
		t.Fatal(err)
	}
	if string(data) != want.String() {
		t.Fatalf("spill file = %q, want the interleaved order", data)
	}
	if got := readAll(t, o, stdout, 0); got != strings.Repeat("a", 100) {
		t.Fatalf("stdout = %q", got)
	}
	if got := readAll(t, o, stderr, 0); got != strings.Repeat("b", 100) {
		t.Fatalf("stderr = %q", got)
	}
}
