package executor

import (
	"bytes"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/Kodecable/ClusterRightHand/client/internal/proto/crhv1"
)

const (
	stdout = crhv1.Stream_STREAM_STDOUT
	stderr = crhv1.Stream_STREAM_STDERR
)

func readAll(t *testing.T, o *Output, s crhv1.Stream, from uint64) string {
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
	o := NewOutput("t1", t.TempDir(), 1024, 100)
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

func TestOutputSpillsByBytes(t *testing.T) {
	dir := t.TempDir()
	o := NewOutput("t2", dir, 10, 0)
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
	o := NewOutput("t3", t.TempDir(), 0, 3)
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

func TestOutputWithoutSpillDir(t *testing.T) {
	o := NewOutput("t4", filepath.Join(t.TempDir(), "missing"), 4, 0)
	o.Writer(stdout).Write([]byte(strings.Repeat("x", 100)))
	if o.Path() != "" {
		t.Fatal("spilled into a missing dir")
	}
	if got := readAll(t, o, stdout, 90); got != strings.Repeat("x", 10) {
		t.Fatalf("stdout = %q", got)
	}
}

func TestOutputNotify(t *testing.T) {
	o := NewOutput("t5", "", 0, 0)
	o.Writer(stdout).Write([]byte("x"))
	select {
	case <-o.Notify():
	default:
		t.Fatal("no notification")
	}
}
