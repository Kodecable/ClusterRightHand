package executor

import (
	"bytes"
	"context"
	"crypto/sha256"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"net"
	"os"
	"os/user"
	"path/filepath"
	"strings"
	"syscall"
	"testing"
	"time"

	"github.com/Kodecable/ClusterRightHand/client/internal/protocol"
)

// run executes one file task and returns its structured result.
func run(t *testing.T, kind any, input io.Reader) (*protocol.TaskResult, error) {
	t.Helper()
	result, _, err := runFile(t, kind, input)
	return result, err
}

// runFile executes one file task and returns its structured result, its output and the error.
func runFile(t *testing.T, kind any, input io.Reader) (*protocol.TaskResult, string, error) {
	t.Helper()
	spec := &protocol.TaskSpec{}
	switch k := kind.(type) {
	case *protocol.FileReadSpec:
		spec.Kind, spec.FileRead = protocol.TaskSpecFileRead, k
	case *protocol.FileWriteSpec:
		spec.Kind, spec.FileWrite = protocol.TaskSpecFileWrite, k
	case *protocol.FileEditSpec:
		spec.Kind, spec.FileEdit = protocol.TaskSpecFileEdit, k
	case *protocol.FileStatSpec:
		spec.Kind, spec.FileStat = protocol.TaskSpecFileStat, k
	case *protocol.FileListSpec:
		spec.Kind, spec.FileList = protocol.TaskSpecFileList, k
	}
	var out bytes.Buffer
	result, err := RunFile(context.Background(), spec, input, &out)
	return result, out.String(), err
}

// writeResult is the file.write result of a task that succeeded.
func writeResult(t *testing.T, res *protocol.TaskResult) *protocol.FileWriteResult {
	t.Helper()
	if res == nil || res.FileWrite == nil {
		t.Fatalf("no file.write result: %+v", res)
	}
	return res.FileWrite
}

// editResult is the file.edit result of a task that succeeded.
func editResult(t *testing.T, res *protocol.TaskResult) *protocol.FileEditResult {
	t.Helper()
	if res == nil || res.FileEdit == nil {
		t.Fatalf("no file.edit result: %+v", res)
	}
	return res.FileEdit
}

// statResult is the file.stat result of a task that succeeded.
func statResult(t *testing.T, res *protocol.TaskResult) *protocol.FileStatResult {
	t.Helper()
	if res == nil || res.FileStat == nil {
		t.Fatalf("no file.stat result: %+v", res)
	}
	return res.FileStat
}

// listResult is the file.list result of a task that succeeded.
func listResult(t *testing.T, res *protocol.TaskResult) *protocol.FileListResult {
	t.Helper()
	if res == nil || res.FileList == nil {
		t.Fatalf("no file.list result: %+v", res)
	}
	return res.FileList
}

func wantCode(t *testing.T, err error, code string) {
	t.Helper()
	var e *Error
	if !errors.As(err, &e) || e.Code != code {
		t.Fatalf("want error code %q, got %v", code, err)
	}
}

// wantMessage asserts the text of a task error: the model and UI show it as it is.
func wantMessage(t *testing.T, err error, want string) {
	t.Helper()
	var e *Error
	if !errors.As(err, &e) {
		t.Fatalf("want a task error with message %q, got %v", want, err)
	}
	if e.Message != want {
		t.Fatalf("message = %q, want %q", e.Message, want)
	}
}

func writeFile(t *testing.T, path, content string, mode os.FileMode) {
	t.Helper()
	if err := os.WriteFile(path, []byte(content), mode); err != nil {
		t.Fatal(err)
	}
	os.Chmod(path, mode)
}

func readFileStr(t *testing.T, path string) string {
	t.Helper()
	b, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	return string(b)
}

// chmodOnRead changes dir's mode when the task first reads its input, which happens after the
// temporary file was created and before it is published.
type chmodOnRead struct {
	dir   string
	mode  os.FileMode
	done  bool
	bytes []byte
}

func (r *chmodOnRead) Read(p []byte) (int, error) {
	if !r.done {
		r.done = true
		if err := os.Chmod(r.dir, r.mode); err != nil {
			return 0, err
		}
	}
	if len(r.bytes) == 0 {
		return 0, io.EOF
	}
	n := copy(p, r.bytes)
	r.bytes = r.bytes[n:]
	return n, nil
}

func writeSpec(path, content string) *protocol.FileWriteSpec {
	sum := sha256.Sum256([]byte(content))
	return &protocol.FileWriteSpec{Path: path, Content: protocol.InputRef{Size: protocol.Uint(len(content)), SHA256: protocol.Hash(sum)}}
}

func noTemps(t *testing.T, dir string) {
	t.Helper()
	des, _ := os.ReadDir(dir)
	for _, de := range des {
		if strings.Contains(de.Name(), ".crh-") {
			t.Fatalf("leftover temp file %s", de.Name())
		}
	}
}

func TestFileInvalidPath(t *testing.T) {
	for _, p := range []string{"rel/path", "/a/../b", "/a//b", "/a/"} {
		_, err := run(t, &protocol.FileStatSpec{Path: p}, nil)
		wantCode(t, err, "invalid_spec")
	}
}

// readOnePage runs one file.read task and returns the page and its result.
func readOnePage(t *testing.T, spec *protocol.FileReadSpec) (string, *protocol.FileReadResult, error) {
	t.Helper()
	res, page, err := runFile(t, spec, nil)
	if err != nil {
		return "", nil, err
	}
	if res == nil || res.FileRead == nil {
		t.Fatalf("no file.read result: %+v", res)
	}
	return page, res.FileRead, nil
}

// pageWant is the expected page of a file.read task; total is -1 when the page did not reach the
// end of the file (and the result must then carry no line count).
type pageWant struct {
	from, to uint64
	eof      bool
	total    int
	tooLong  bool
}

func wantPage(t *testing.T, spec *protocol.FileReadSpec, page string, want pageWant) {
	t.Helper()
	gotPage, res, err := readOnePage(t, spec)
	if err != nil {
		t.Fatalf("read: %v", err)
	}
	if gotPage != page {
		t.Fatalf("page = %q, want %q", gotPage, page)
	}
	if res.From != protocol.Uint(want.from) || res.To != protocol.Uint(want.to) || res.EOF != want.eof ||
		res.TooLong != want.tooLong {
		t.Fatalf("result %+v, want lines %d-%d eof=%v too_long=%v", res, want.from, want.to, want.eof, want.tooLong)
	}
	switch {
	case !want.eof && res.Total != nil:
		t.Fatalf("result carries total=%d before the end of the file", *res.Total)
	case want.eof && want.total < 0:
		t.Fatalf("the expectation needs the line count of an EOF page")
	case want.eof && (res.Total == nil || *res.Total != protocol.Uint(want.total)):
		t.Fatalf("result total = %v, want %d", res.Total, want.total)
	}
}

func TestFileRead(t *testing.T) {
	dir := t.TempDir()
	p := filepath.Join(dir, "f")
	writeFile(t, p, "one\ntwo\nthree\nfour\n", 0o644)

	// Whole lines from the start line; the file's end and its line count are only reported at EOF.
	wantPage(t, &protocol.FileReadSpec{Path: p, StartLine: 1, LineCount: 2}, "one\ntwo\n",
		pageWant{from: 1, to: 2})
	wantPage(t, &protocol.FileReadSpec{Path: p, StartLine: 2, LineCount: 2}, "two\nthree\n",
		pageWant{from: 2, to: 3})
	wantPage(t, &protocol.FileReadSpec{Path: p, StartLine: 4, LineCount: 10}, "four\n",
		pageWant{from: 4, to: 4, eof: true, total: 4})
	// A page that ends exactly at the end of the file knows it.
	wantPage(t, &protocol.FileReadSpec{Path: p, StartLine: 1, LineCount: 4}, "one\ntwo\nthree\nfour\n",
		pageWant{from: 1, to: 4, eof: true, total: 4})
	// A start line past the end is an empty page that still reports the line count.
	wantPage(t, &protocol.FileReadSpec{Path: p, StartLine: 9, LineCount: 1}, "",
		pageWant{from: 0, to: 0, eof: true, total: 4})

	_, _, err := readOnePage(t, &protocol.FileReadSpec{Path: p, StartLine: 0, LineCount: 1})
	wantCode(t, err, "invalid_spec")
	_, _, err = readOnePage(t, &protocol.FileReadSpec{Path: p, StartLine: 1, LineCount: 0})
	wantCode(t, err, "invalid_spec")

	_, err = run(t, &protocol.FileReadSpec{Path: dir, StartLine: 1, LineCount: 1}, nil)
	wantCode(t, err, "not_regular_file")
	wantMessage(t, err, dir+" is not a regular file")
	_, err = run(t, &protocol.FileReadSpec{Path: filepath.Join(dir, "nope"), StartLine: 1, LineCount: 1}, nil)
	wantCode(t, err, "not_found")
}

func TestFileReadEmptyFile(t *testing.T) {
	p := filepath.Join(t.TempDir(), "empty")
	writeFile(t, p, "", 0o644)
	wantPage(t, &protocol.FileReadSpec{Path: p, StartLine: 1, LineCount: 10}, "",
		pageWant{from: 0, to: 0, eof: true, total: 0})
}

func TestFileReadLastLineWithoutNewline(t *testing.T) {
	p := filepath.Join(t.TempDir(), "f")
	writeFile(t, p, "a\nb", 0o644)
	// The unterminated last line is a line, returned without a newline; the newline of a page's last
	// line is the file's own, not added.
	wantPage(t, &protocol.FileReadSpec{Path: p, StartLine: 2, LineCount: 5}, "b",
		pageWant{from: 2, to: 2, eof: true, total: 2})
	// A page ending before the unterminated line keeps the newline that line does have.
	wantPage(t, &protocol.FileReadSpec{Path: p, StartLine: 1, LineCount: 1}, "a\n",
		pageWant{from: 1, to: 1})
}

func TestFileReadCRLFCountsLines(t *testing.T) {
	p := filepath.Join(t.TempDir(), "f")
	writeFile(t, p, "a\r\nb\r\n", 0o644)
	// A line ends at "\n"; the "\r" stays part of the line's bytes.
	wantPage(t, &protocol.FileReadSpec{Path: p, StartLine: 2, LineCount: 1}, "b\r\n",
		pageWant{from: 2, to: 2, eof: true, total: 2})
}

func TestFileReadByteCap(t *testing.T) {
	dir := t.TempDir()
	p := filepath.Join(dir, "f")
	// Lines of 1000 bytes: 51 fit whole, the 52nd would pass the 50 KB cap.
	var b strings.Builder
	for range 60 {
		b.WriteString(strings.Repeat("x", 999))
		b.WriteString("\n")
	}
	writeFile(t, p, b.String(), 0o644)
	page, res, err := readOnePage(t, &protocol.FileReadSpec{Path: p, StartLine: 1, LineCount: 2000})
	if err != nil {
		t.Fatal(err)
	}
	if page != strings.Repeat(strings.Repeat("x", 999)+"\n", 51) {
		t.Fatalf("page has %d bytes, want 51 whole lines", len(page))
	}
	if res.To != 51 || res.EOF {
		t.Fatalf("result %+v, want lines 1-51 and no EOF", res)
	}
	if res.From != 1 || res.Total != nil || res.TooLong {
		t.Fatalf("result %+v, want lines 1-51 and no EOF", res)
	}

	// A line alone over the cap cannot be shown; the page stays empty and says so.
	big := filepath.Join(dir, "big")
	writeFile(t, big, strings.Repeat("x", protocol.FileReadMaxBytes)+"\n", 0o644)
	page, res, err = readOnePage(t, &protocol.FileReadSpec{Path: big, StartLine: 1, LineCount: 1})
	if err != nil {
		t.Fatal(err)
	}
	if page != "" || !res.TooLong || res.From != 0 || res.To != 0 || res.EOF || res.Total != nil {
		t.Fatalf("page %q, result %+v, want an empty page with too_long", page, res)
	}

	// One byte under the cap fits, newline included.
	fits := filepath.Join(dir, "fits")
	writeFile(t, fits, strings.Repeat("x", protocol.FileReadMaxBytes-1)+"\n", 0o644)
	page, res, err = readOnePage(t, &protocol.FileReadSpec{Path: fits, StartLine: 1, LineCount: 1})
	if err != nil {
		t.Fatal(err)
	}
	if len(page) != protocol.FileReadMaxBytes || !res.EOF || res.Total == nil || *res.Total != 1 {
		t.Fatalf("page has %d bytes, result %+v, want one full line at EOF", len(page), res)
	}
	if res.From != 1 || res.To != 1 || res.TooLong {
		t.Fatalf("result %+v, want line 1 at EOF", res)
	}
}

// cancelAfterReader cancels ctx once it has delivered after bytes, so a test can interrupt the scan
// of one line at a chosen point instead of racing a timer.
type cancelAfterReader struct {
	r      io.Reader
	n      int
	after  int
	cancel context.CancelFunc
}

func (c *cancelAfterReader) Read(p []byte) (int, error) {
	n, err := c.r.Read(p)
	c.n += n
	if c.n >= c.after {
		c.cancel()
	}
	return n, err
}

// TestFileReadCancelledInsideLine covers a line without a newline: the scan runs to the end of the
// file (or a character device runs for ever), so a cancellation must be seen between the chunks of
// one line, not only between lines.
func TestFileReadCancelledInsideLine(t *testing.T) {
	p := filepath.Join(t.TempDir(), "huge")
	// One 4 MB line without a newline: 64 buffers, far past the page cap.
	writeFile(t, p, strings.Repeat("x", 4<<20), 0o644)
	f, err := os.Open(p)
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	// The scan skips to line 2, so the line is read with keep=false: it never reaches the cap that
	// would stop a kept line, and only the cancellation can end it.
	r := &cancelAfterReader{r: f, after: 2 * 64 << 10, cancel: cancel}
	_, err = readPage(ctx, r, &protocol.FileReadSpec{StartLine: 2, LineCount: 1}, io.Discard)
	if !errors.Is(err, context.Canceled) {
		t.Fatalf("readPage = %v, want context.Canceled", err)
	}
}

func TestFileReadCancelled(t *testing.T) {
	p := filepath.Join(t.TempDir(), "f")
	writeFile(t, p, "x", 0o644)
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	spec := &protocol.TaskSpec{Kind: protocol.TaskSpecFileRead, FileRead: &protocol.FileReadSpec{Path: p, StartLine: 1, LineCount: 1}}
	res, err := RunFile(ctx, spec, nil, io.Discard)
	wantCode(t, err, "cancelled")
	if res != nil {
		t.Fatalf("a cancelled task reported a result: %+v", res)
	}
}

// TestRunTaskCarriesFileResult covers what a task.exit reports for a file task: the result is in the
// task's Result, and the output streams keep no metadata (doc/protocol.md TaskResult).
func TestRunTaskCarriesFileResult(t *testing.T) {
	dir := t.TempDir()
	p := filepath.Join(dir, "f")
	writeFile(t, p, "one\ntwo\n", 0o644)

	runTask := func(t *testing.T, spec *protocol.TaskSpec, input io.Reader) (Result, *Output) {
		t.Helper()
		out := NewOutput("t", "", OutputOptions{})
		res := RunTask(context.Background(), spec, input, out, TaskOptions{})
		out.Close()
		return res, out
	}

	res, out := runTask(t, &protocol.TaskSpec{Kind: protocol.TaskSpecFileRead, FileRead: &protocol.FileReadSpec{
		Path: p, StartLine: 1, LineCount: 10,
	}}, nil)
	if res.TaskResult == nil || res.TaskResult.Kind != protocol.TaskResultFileRead || res.TaskResult.FileRead == nil {
		t.Fatalf("result: %+v", res.TaskResult)
	}
	if page := readAll(t, out, 0); page != "one\ntwo\n" {
		t.Fatalf("output = %q, want the page and nothing else", page)
	}

	res, out = runTask(t, &protocol.TaskSpec{Kind: protocol.TaskSpecFileStat, FileStat: &protocol.FileStatSpec{Path: p}}, nil)
	if res.TaskResult == nil || res.TaskResult.FileStat == nil || res.TaskResult.FileStat.Size != 8 {
		t.Fatalf("result: %+v", res.TaskResult)
	}
	if got := readAll(t, out, 0); got != "" {
		t.Fatalf("output = %q, want empty", got)
	}

	res, out = runTask(t, &protocol.TaskSpec{Kind: protocol.TaskSpecFileList, FileList: &protocol.FileListSpec{Path: dir}}, nil)
	if res.TaskResult == nil || res.TaskResult.FileList == nil || len(res.TaskResult.FileList.Entries) != 1 {
		t.Fatalf("result: %+v", res.TaskResult)
	}
	if got := readAll(t, out, 0); got != "" {
		t.Fatalf("output = %q, want empty", got)
	}

	res, out = runTask(t, &protocol.TaskSpec{
		Kind: protocol.TaskSpecFileWrite, FileWrite: writeSpec(filepath.Join(dir, "written"), "abc"),
	}, strings.NewReader("abc"))
	if res.TaskResult == nil || res.TaskResult.FileWrite == nil || res.TaskResult.FileWrite.Bytes != 3 {
		t.Fatalf("result: %+v", res.TaskResult)
	}
	if got := readAll(t, out, 0); got != "" {
		t.Fatalf("output = %q, want empty", got)
	}

	editSpec := &protocol.FileEditSpec{Path: filepath.Join(dir, "written"), Edits: []protocol.Edit{{OldText: "abc", NewText: "xyz"}}}
	res, out = runTask(t, &protocol.TaskSpec{Kind: protocol.TaskSpecFileEdit, FileEdit: editSpec}, nil)
	if res.TaskResult == nil || res.TaskResult.FileEdit == nil || res.TaskResult.FileEdit.Replacements != 1 {
		t.Fatalf("result: %+v", res.TaskResult)
	}
	if got := readAll(t, out, 0); got != "" {
		t.Fatalf("output = %q, want empty", got)
	}

	// A task that failed reports no result at all.
	res, out = runTask(t, &protocol.TaskSpec{Kind: protocol.TaskSpecFileStat, FileStat: &protocol.FileStatSpec{Path: filepath.Join(dir, "nope")}}, nil)
	if res.Err == nil || res.TaskResult != nil {
		t.Fatalf("failed task: %+v", res)
	}
	if got := readAll(t, out, 0); got != "" {
		t.Fatalf("output = %q, want empty", got)
	}
}

// TestFileSpecialFilesDoNotBlock covers FIFOs and sockets: opening one for reading blocks in
// open(2) (a FIFO waits for a writer) and a cancellation cannot interrupt it, so read, edit and
// list refuse them with not_regular_file like the privileged executor (doc/privilege.md 方法与目标).
func TestFileSpecialFilesDoNotBlock(t *testing.T) {
	dir := t.TempDir()
	fifo := filepath.Join(dir, "fifo")
	if err := syscall.Mkfifo(fifo, 0o600); err != nil {
		t.Fatal(err)
	}
	socket := filepath.Join(dir, "socket")
	listener, err := net.Listen("unix", socket)
	if err != nil {
		t.Fatal(err)
	}
	defer listener.Close()

	runSpecial := func(t *testing.T, spec *protocol.TaskSpec) error {
		t.Helper()
		done := make(chan error, 1)
		go func() {
			_, err := RunFile(context.Background(), spec, nil, io.Discard)
			done <- err
		}()
		select {
		case err := <-done:
			return err
		case <-time.After(5 * time.Second):
			t.Fatal("a special file blocked the task")
			return nil
		}
	}
	for _, tc := range []struct {
		name string
		path string
	}{
		{"fifo", fifo},
		{"socket", socket},
	} {
		t.Run(tc.name+"/read", func(t *testing.T) {
			spec := &protocol.TaskSpec{Kind: protocol.TaskSpecFileRead, FileRead: &protocol.FileReadSpec{Path: tc.path, StartLine: 1, LineCount: 1}}
			wantCode(t, runSpecial(t, spec), "not_regular_file")
		})
		t.Run(tc.name+"/edit", func(t *testing.T) {
			spec := &protocol.TaskSpec{Kind: protocol.TaskSpecFileEdit, FileEdit: &protocol.FileEditSpec{
				Path: tc.path, Edits: []protocol.Edit{{OldText: "a", NewText: "b"}},
			}}
			wantCode(t, runSpecial(t, spec), "not_regular_file")
		})
		t.Run(tc.name+"/list", func(t *testing.T) {
			spec := &protocol.TaskSpec{Kind: protocol.TaskSpecFileList, FileList: &protocol.FileListSpec{Path: tc.path}}
			wantCode(t, runSpecial(t, spec), "not_regular_file")
		})
	}
}

// TestFileReadEditRequireRegularFile covers the type rule of file.read and file.edit: only a regular
// file is opened, so a character device is never read (or opened) and a directory is refused with
// the same code. A symbolic link to a regular file keeps working in the unprivileged mode, which
// follows it.
func TestFileReadEditRequireRegularFile(t *testing.T) {
	dir := t.TempDir()
	p := filepath.Join(dir, "f")
	writeFile(t, p, "one\ntwo\n", 0o644)
	link := filepath.Join(dir, "link")
	linkAt(t, p, link)

	read := func(t *testing.T, path string) (*protocol.TaskResult, error) {
		t.Helper()
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		return RunFile(ctx, &protocol.TaskSpec{
			Kind:     protocol.TaskSpecFileRead,
			FileRead: &protocol.FileReadSpec{Path: path, StartLine: 2, LineCount: 10},
		}, nil, io.Discard)
	}
	edit := func(t *testing.T, path string) error {
		t.Helper()
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		_, err := RunFile(ctx, &protocol.TaskSpec{
			Kind:     protocol.TaskSpecFileEdit,
			FileEdit: &protocol.FileEditSpec{Path: path, Edits: []protocol.Edit{{OldText: "one", NewText: "1"}}},
		}, nil, io.Discard)
		return err
	}

	// A regular file and a symbolic link to it still work.
	page, err := read(t, p)
	if err != nil {
		t.Fatal(err)
	}
	if page.FileRead == nil || page.FileRead.To != 2 {
		t.Fatalf("read result: %+v", page.FileRead)
	}
	if _, err := read(t, link); err != nil {
		t.Fatalf("read through a symbolic link: %v", err)
	}
	if err := edit(t, link); err != nil {
		t.Fatalf("edit through a symbolic link: %v", err)
	}
	if got := readFileStr(t, p); got != "1\ntwo\n" {
		t.Fatalf("target = %q", got)
	}

	// A directory is not a regular file for either task.
	if _, err := read(t, dir); err == nil {
		t.Fatal("read a directory")
	} else {
		wantCode(t, err, "not_regular_file")
		wantMessage(t, err, dir+" is not a regular file")
	}
	if err := edit(t, dir); err == nil {
		t.Fatal("edited a directory")
	} else {
		wantCode(t, err, "not_regular_file")
		wantMessage(t, err, dir+" is not a regular file")
	}

	// A character device is refused, and the read of /dev/zero starts past the first line: the scan
	// used to loop on ErrBufferFull there instead of reaching the end of the file.
	dev := ""
	for _, candidate := range []string{"/dev/zero", "/dev/null"} {
		if fi, err := os.Stat(candidate); err == nil && fi.Mode()&os.ModeCharDevice != 0 {
			dev = candidate
			break
		}
	}
	if dev == "" {
		t.Skip("no character device to read")
	}
	_, err = read(t, dev)
	wantCode(t, err, "not_regular_file")
	wantMessage(t, err, dev+" is not a regular file")
	err = edit(t, dev)
	wantCode(t, err, "not_regular_file")
	wantMessage(t, err, dev+" is not a regular file")
}

// TestFileListRefusesWithoutOpening covers a listing of a path that is not a directory: HEAD
// stat'ed it and stopped there, and opening a character or block device can have side effects (a
// tty raises DTR, a tape rewinds). The mode-000 FIFO would fail an open with permission_denied, so
// not_regular_file shows the listing decided from the stat alone; /dev/null is the character device
// a listing meets in practice, and it is not a directory.
func TestFileListRefusesWithoutOpening(t *testing.T) {
	dir := t.TempDir()
	fifo := filepath.Join(dir, "fifo")
	if err := syscall.Mkfifo(fifo, 0o600); err != nil {
		t.Fatal(err)
	}
	noRead := filepath.Join(dir, "fifo-no-read")
	if err := syscall.Mkfifo(noRead, 0); err != nil {
		t.Fatal(err)
	}

	list := func(t *testing.T, path string) error {
		t.Helper()
		done := make(chan error, 1)
		go func() {
			_, err := RunFile(context.Background(), &protocol.TaskSpec{
				Kind: protocol.TaskSpecFileList, FileList: &protocol.FileListSpec{Path: path},
			}, nil, io.Discard)
			done <- err
		}()
		select {
		case err := <-done:
			return err
		case <-time.After(5 * time.Second):
			t.Fatal("listing a special file blocked the task")
			return nil
		}
	}

	// No writer ever opens the FIFO, and the mode-000 one cannot be opened at all.
	wantCode(t, list(t, fifo), "not_regular_file")
	wantCode(t, list(t, noRead), "not_regular_file")
	if _, err := os.Stat("/dev/null"); err == nil {
		wantCode(t, list(t, "/dev/null"), "not_a_directory")
	}
	// An unreadable regular file keeps the permission_denied the listing reported while it opened
	// the path; the read-permission probe gives that answer without opening it.
	if os.Geteuid() != 0 {
		unreadable := filepath.Join(dir, "unreadable")
		writeFile(t, unreadable, "x", 0o600)
		if err := os.Chmod(unreadable, 0); err != nil {
			t.Fatal(err)
		}
		err := list(t, unreadable)
		wantCode(t, err, "permission_denied")
		wantMessage(t, err, "open "+unreadable+": permission denied")
	}
}

func TestFileWriteCreate(t *testing.T) {
	dir := t.TempDir()
	p := filepath.Join(dir, "new")
	out, err := run(t, writeSpec(p, "hello"), strings.NewReader("hello"))
	if err != nil {
		t.Fatal(err)
	}
	if w := writeResult(t, out); w.Bytes != 5 || !w.Created {
		t.Fatalf("result: %+v", w)
	}
	if readFileStr(t, p) != "hello" {
		t.Fatal("content")
	}
	if fi, _ := os.Stat(p); fi.Mode().Perm() != 0o644 {
		t.Fatalf("mode %v", fi.Mode())
	}
	noTemps(t, dir)
}

func TestFileWriteCreateParentDirs(t *testing.T) {
	dir := t.TempDir()
	// A known umask makes the 0755 assertion meaningful; restore it afterwards.
	old := syscall.Umask(0o022)
	t.Cleanup(func() { syscall.Umask(old) })
	p := filepath.Join(dir, "a", "b", "c", "f")
	s := writeSpec(p, "hello")
	s.CreateParentDirs = true
	out, err := run(t, s, strings.NewReader("hello"))
	if err != nil {
		t.Fatal(err)
	}
	if w := writeResult(t, out); w.Bytes != 5 || !w.Created {
		t.Fatalf("result: %+v", w)
	}
	if readFileStr(t, p) != "hello" {
		t.Fatal("content")
	}
	for _, d := range []string{"a", filepath.Join("a", "b"), filepath.Join("a", "b", "c")} {
		fi, err := os.Stat(filepath.Join(dir, d))
		if err != nil {
			t.Fatal(err)
		}
		if fi.Mode().Perm() != 0o755 {
			t.Fatalf("%s mode = %v, want 0755 before the umask", d, fi.Mode())
		}
	}
	noTemps(t, filepath.Join(dir, "a", "b", "c"))
}

func TestFileWriteCreateParentDirsKeepsExisting(t *testing.T) {
	dir := t.TempDir()
	// An existing directory keeps its own mode; only the missing ones are created.
	if err := os.Mkdir(filepath.Join(dir, "a"), 0o700); err != nil {
		t.Fatal(err)
	}
	p := filepath.Join(dir, "a", "b", "f")
	s := writeSpec(p, "x")
	s.CreateParentDirs = true
	if _, err := run(t, s, strings.NewReader("x")); err != nil {
		t.Fatal(err)
	}
	if fi, _ := os.Stat(filepath.Join(dir, "a")); fi.Mode().Perm() != 0o700 {
		t.Fatalf("existing dir mode = %v, want unchanged 0700", fi.Mode())
	}
	if readFileStr(t, p) != "x" {
		t.Fatal("content")
	}
}

func TestFileWriteCreateParentDirsOwner(t *testing.T) {
	cur, err := user.Current()
	if err != nil || cur.Username == "" {
		t.Skip("no current user")
	}
	dir := t.TempDir()
	p := filepath.Join(dir, "a", "b", "f")
	s := writeSpec(p, "x")
	s.CreateParentDirs = true
	s.Owner = cur.Username
	if g, err := user.LookupGroupId(cur.Gid); err == nil {
		s.Group = g.Name
	}
	if _, err := run(t, s, strings.NewReader("x")); err != nil {
		t.Fatal(err)
	}
	for _, d := range []string{"a", filepath.Join("a", "b")} {
		var st syscall.Stat_t
		if err := syscall.Stat(filepath.Join(dir, d), &st); err != nil {
			t.Fatal(err)
		}
		if int(st.Uid) != os.Getuid() || int(st.Gid) != os.Getgid() {
			t.Fatalf("%s owner = %d:%d, want %d:%d", d, st.Uid, st.Gid, os.Getuid(), os.Getgid())
		}
	}
}

func TestFileWriteCreateParentDirsThroughSymlink(t *testing.T) {
	dir := t.TempDir()
	target := filepath.Join(dir, "real", "nested", "f")
	if err := os.MkdirAll(filepath.Dir(filepath.Dir(target)), 0o755); err != nil {
		t.Fatal(err)
	}
	link := filepath.Join(dir, "link")
	linkAt(t, target, link)
	s := writeSpec(link, "x")
	s.CreateParentDirs = true
	if _, err := run(t, s, strings.NewReader("x")); err != nil {
		t.Fatal(err)
	}
	if readFileStr(t, target) != "x" {
		t.Fatal("content")
	}
	wantSymlink(t, link)
}

func TestFileWriteCreateParentDirsNotADirectory(t *testing.T) {
	dir := t.TempDir()
	file := filepath.Join(dir, "file")
	writeFile(t, file, "x", 0o644)
	s := writeSpec(filepath.Join(file, "f"), "x")
	s.CreateParentDirs = true
	_, err := run(t, s, strings.NewReader("x"))
	wantCode(t, err, "not_found")
}

func TestFileWriteExplicitMode(t *testing.T) {
	p := filepath.Join(t.TempDir(), "new")
	s := writeSpec(p, "x")
	s.Mode = 0o600
	if _, err := run(t, s, strings.NewReader("x")); err != nil {
		t.Fatal(err)
	}
	if fi, _ := os.Stat(p); fi.Mode().Perm() != 0o600 {
		t.Fatalf("mode %v", fi.Mode())
	}
}

func TestFileWriteExists(t *testing.T) {
	dir := t.TempDir()
	p := filepath.Join(dir, "f")
	writeFile(t, p, "old", 0o644)
	_, err := run(t, writeSpec(p, "new"), strings.NewReader("new"))
	wantCode(t, err, "exists")
	if readFileStr(t, p) != "old" {
		t.Fatal("file was modified")
	}
	noTemps(t, dir)
}

func TestFileWriteOverwriteKeepsMode(t *testing.T) {
	dir := t.TempDir()
	p := filepath.Join(dir, "f")
	writeFile(t, p, "old", 0o640)
	s := writeSpec(p, "new")
	s.Overwrite = true
	out, err := run(t, s, strings.NewReader("new"))
	if err != nil {
		t.Fatal(err)
	}
	if writeResult(t, out).Created {
		t.Fatalf("result: %+v", out.FileWrite)
	}
	if readFileStr(t, p) != "new" {
		t.Fatal("content")
	}
	if fi, _ := os.Stat(p); fi.Mode().Perm() != 0o640 {
		t.Fatalf("mode %v", fi.Mode())
	}
	noTemps(t, dir)
}

// linkAt creates a symbolic link and checks that it survives a write as a link.
func linkAt(t *testing.T, target, link string) {
	t.Helper()
	if err := os.Symlink(target, link); err != nil {
		t.Fatal(err)
	}
}

func wantSymlink(t *testing.T, link string) {
	t.Helper()
	fi, err := os.Lstat(link)
	if err != nil {
		t.Fatal(err)
	}
	if fi.Mode()&fs.ModeSymlink == 0 {
		t.Fatalf("%s is no longer a symbolic link", link)
	}
}

// TestFileWriteThroughSymlink covers a write whose path is a symbolic link: the write replaces the
// file the link points to, keeps the link, and keeps the target's mode. Replacing the link instead
// would leave a world-writable regular file where the link was (the link's own mode is 0777) and
// would never write the target.
func TestFileWriteThroughSymlink(t *testing.T) {
	dir := t.TempDir()
	target := filepath.Join(dir, "target")
	writeFile(t, target, "old", 0o640)
	link := filepath.Join(dir, "link")
	linkAt(t, target, link)

	s := writeSpec(link, "new")
	s.Overwrite = true
	out, err := run(t, s, strings.NewReader("new"))
	if err != nil {
		t.Fatal(err)
	}
	if writeResult(t, out).Created {
		t.Fatalf("result: %+v", out.FileWrite)
	}
	wantSymlink(t, link)
	if got := readFileStr(t, target); got != "new" {
		t.Fatalf("target = %q, want %q", got, "new")
	}
	if fi, err := os.Stat(target); err != nil || fi.Mode().Perm() != 0o640 {
		t.Fatalf("target mode = %v (%v), want 0640", fi.Mode(), err)
	}
	noTemps(t, dir)
}

// TestFileWriteThroughRelativeSymlink covers a link whose target is relative and a link to a
// directory, which must be refused instead of replaced.
func TestFileWriteThroughRelativeSymlink(t *testing.T) {
	dir := t.TempDir()
	writeFile(t, filepath.Join(dir, "target"), "old", 0o600)
	link := filepath.Join(dir, "rel")
	linkAt(t, "target", link)

	s := writeSpec(link, "new")
	s.Overwrite = true
	if _, err := run(t, s, strings.NewReader("new")); err != nil {
		t.Fatal(err)
	}
	wantSymlink(t, link)
	if got := readFileStr(t, filepath.Join(dir, "target")); got != "new" {
		t.Fatalf("target = %q", got)
	}
	if fi, _ := os.Stat(filepath.Join(dir, "target")); fi.Mode().Perm() != 0o600 {
		t.Fatalf("target mode %v", fi.Mode())
	}

	dirLink := filepath.Join(dir, "dirlink")
	linkAt(t, dir, dirLink)
	s = writeSpec(dirLink, "x")
	s.Overwrite = true
	_, err := run(t, s, strings.NewReader("x"))
	wantCode(t, err, "is_directory")
	wantSymlink(t, dirLink)
	noTemps(t, dir)
}

// TestFileWriteThroughSymlinkedDirectory covers a relative link target reached through a symbolic
// link: the kernel resolves ".." against the link's real directory, so joining onto the path used to
// reach the link would write elsewhere and leave the target untouched.
func TestFileWriteThroughSymlinkedDirectory(t *testing.T) {
	root := t.TempDir()
	// The link lives in root/a/b, which the test reaches as root/alias. From the real directory
	// "../../target" names root/target; lexically it names the parent of root.
	real := filepath.Join(root, "a", "b")
	if err := os.MkdirAll(real, 0o755); err != nil {
		t.Fatal(err)
	}
	target := filepath.Join(root, "target")
	writeFile(t, target, "old", 0o640)
	alias := filepath.Join(root, "alias")
	linkAt(t, real, alias)
	link := filepath.Join(alias, "rel")
	linkAt(t, "../../target", link)

	s := writeSpec(link, "new")
	s.Overwrite = true
	out, err := run(t, s, strings.NewReader("new"))
	if err != nil {
		t.Fatal(err)
	}
	if writeResult(t, out).Created {
		t.Fatalf("result: %+v", out.FileWrite)
	}
	wantSymlink(t, link)
	if got := readFileStr(t, target); got != "new" {
		t.Fatalf("target = %q, want %q", got, "new")
	}
	if fi, err := os.Stat(target); err != nil || fi.Mode().Perm() != 0o640 {
		t.Fatalf("target mode = %v (%v), want 0640", fi.Mode(), err)
	}
}

// TestFileWriteThroughDanglingSymlink covers a link whose target does not exist: the target is
// created with the requested or default mode and the link becomes usable, instead of being
// replaced by a regular file.
func TestFileWriteThroughDanglingSymlink(t *testing.T) {
	dir := t.TempDir()
	target := filepath.Join(dir, "missing")
	link := filepath.Join(dir, "dangling")
	linkAt(t, target, link)

	out, err := run(t, writeSpec(link, "new"), strings.NewReader("new"))
	if err != nil {
		t.Fatal(err)
	}
	if !writeResult(t, out).Created {
		t.Fatalf("result: %+v", out.FileWrite)
	}
	wantSymlink(t, link)
	if got := readFileStr(t, target); got != "new" {
		t.Fatalf("target = %q", got)
	}
	if fi, _ := os.Stat(target); fi.Mode().Perm() != 0o644 {
		t.Fatalf("target mode %v, want the default 0644", fi.Mode())
	}

	s := writeSpec(filepath.Join(dir, "explicit"), "x")
	s.Mode = 0o600
	linkAt(t, filepath.Join(dir, "explicit"), filepath.Join(dir, "dangling2"))
	if _, err := run(t, s, strings.NewReader("x")); err != nil {
		t.Fatal(err)
	}
	if fi, _ := os.Stat(filepath.Join(dir, "explicit")); fi.Mode().Perm() != 0o600 {
		t.Fatalf("explicit mode %v", fi.Mode())
	}
	noTemps(t, dir)
}

// TestFileEditThroughSymlink covers an edit whose path is a symbolic link: it edits the target and
// leaves the link in place, with the target's mode unchanged.
func TestFileEditThroughSymlink(t *testing.T) {
	dir := t.TempDir()
	target := filepath.Join(dir, "target")
	writeFile(t, target, "alpha beta\n", 0o640)
	link := filepath.Join(dir, "link")
	linkAt(t, target, link)

	if _, err := edit(t, link, "alpha", "gamma"); err != nil {
		t.Fatal(err)
	}
	wantSymlink(t, link)
	if got := readFileStr(t, target); got != "gamma beta\n" {
		t.Fatalf("target = %q", got)
	}
	if fi, _ := os.Stat(target); fi.Mode().Perm() != 0o640 {
		t.Fatalf("target mode %v", fi.Mode())
	}
	noTemps(t, dir)
}

func TestFileWriteMismatch(t *testing.T) {
	dir := t.TempDir()
	p := filepath.Join(dir, "f")
	for name, in := range map[string]string{"short": "hel", "long": "hello!!", "hash": "jello"} {
		t.Run(name, func(t *testing.T) {
			_, err := run(t, writeSpec(p, "hello"), strings.NewReader(in))
			wantCode(t, err, "input_mismatch")
			if _, err := os.Lstat(p); !os.IsNotExist(err) {
				t.Fatal("target created")
			}
			noTemps(t, dir)
		})
	}
}

func TestFileWriteErrors(t *testing.T) {
	dir := t.TempDir()
	_, err := run(t, writeSpec(filepath.Join(dir, "missing", "f"), "x"), strings.NewReader("x"))
	wantCode(t, err, "not_found")

	s := writeSpec(dir, "x")
	s.Overwrite = true
	_, err = run(t, s, strings.NewReader("x"))
	wantCode(t, err, "is_directory")

	s = writeSpec(filepath.Join(dir, "f"), "x")
	s.Owner = "no-such-user-crh"
	_, err = run(t, s, strings.NewReader("x"))
	wantCode(t, err, "invalid_spec")
	noTemps(t, dir)
}

func edit(t *testing.T, path string, pairs ...string) (*protocol.TaskResult, error) {
	t.Helper()
	s := &protocol.FileEditSpec{Path: path}
	for i := 0; i < len(pairs); i += 2 {
		s.Edits = append(s.Edits, protocol.Edit{OldText: pairs[i], NewText: pairs[i+1]})
	}
	return run(t, s, nil)
}

func TestFileEditBasic(t *testing.T) {
	dir := t.TempDir()
	p := filepath.Join(dir, "f")
	writeFile(t, p, "alpha\nbeta\ngamma\n", 0o750)
	out, err := edit(t, p, "gamma", "GAMMA", "alpha", "ALPHA")
	if err != nil {
		t.Fatal(err)
	}
	if e := editResult(t, out); e.Replacements != 2 {
		t.Fatalf("result: %+v", e)
	}
	if got := readFileStr(t, p); got != "ALPHA\nbeta\nGAMMA\n" {
		t.Fatalf("got %q", got)
	}
	if fi, _ := os.Stat(p); fi.Mode().Perm() != 0o750 {
		t.Fatalf("mode %v", fi.Mode())
	}
	noTemps(t, dir)
}

func TestFileEditAgainstOriginal(t *testing.T) {
	p := filepath.Join(t.TempDir(), "f")
	writeFile(t, p, "a b\n", 0o644)
	// the second edit's old text only exists in the first edit's replacement
	_, err := edit(t, p, "a", "b", "x", "y")
	wantCode(t, err, "edit_no_match")
	// swap: both match the original
	if _, err := edit(t, p, "a", "b", "b", "a"); err != nil {
		t.Fatal(err)
	}
	if got := readFileStr(t, p); got != "b a\n" {
		t.Fatalf("got %q", got)
	}
}

func TestFileEditCRLF(t *testing.T) {
	p := filepath.Join(t.TempDir(), "f")
	writeFile(t, p, "one\r\ntwo\r\nthree\r\n", 0o644)
	if _, err := edit(t, p, "one\ntwo", "1\n2\n2.5"); err != nil {
		t.Fatal(err)
	}
	if got := readFileStr(t, p); got != "1\r\n2\r\n2.5\r\nthree\r\n" {
		t.Fatalf("got %q", got)
	}
}

func TestFileEditBOM(t *testing.T) {
	p := filepath.Join(t.TempDir(), "f")
	writeFile(t, p, "\xEF\xBB\xBFhello\n", 0o644)
	if _, err := edit(t, p, "hello", "bye"); err != nil {
		t.Fatal(err)
	}
	if got := readFileStr(t, p); got != "\xEF\xBB\xBFbye\n" {
		t.Fatalf("got %q", got)
	}
}

func TestFileEditErrors(t *testing.T) {
	dir := t.TempDir()
	p := filepath.Join(dir, "f")
	writeFile(t, p, "foo bar foo\nbaz\n", 0o644)

	_, err := edit(t, p, "nothing", "x")
	wantCode(t, err, "edit_no_match")
	_, err = edit(t, p, "foo", "x")
	wantCode(t, err, "edit_ambiguous")
	_, err = edit(t, p, "bar foo", "x", "foo bar", "y")
	wantCode(t, err, "edit_overlap")
	_, err = edit(t, p, "", "x")
	wantCode(t, err, "invalid_spec")
	_, err = edit(t, p)
	wantCode(t, err, "invalid_spec")
	_, err = edit(t, p, "baz", "baz")
	wantCode(t, err, "edit_no_change")
	missing := filepath.Join(dir, "missing")
	_, err = edit(t, missing, "a", "b")
	wantCode(t, err, "not_found")
	// HEAD opened the target itself, so its message names the target, not the missing parent.
	wantMessage(t, err, "open "+missing+": no such file or directory")
	noParent := filepath.Join(dir, "noparent", "f")
	_, err = edit(t, noParent, "a", "b")
	wantCode(t, err, "not_found")
	wantMessage(t, err, "open "+noParent+": no such file or directory")
	_, err = edit(t, dir, "a", "b")
	wantCode(t, err, "not_regular_file")
	wantMessage(t, err, dir+" is not a regular file")

	if got := readFileStr(t, p); got != "foo bar foo\nbaz\n" {
		t.Fatalf("file modified: %q", got)
	}
	noTemps(t, dir)

	_, err = edit(t, p, "bar", "x", "foo bar foo", "y")
	wantCode(t, err, "edit_overlap")
}

func TestFileEditTooLarge(t *testing.T) {
	p := filepath.Join(t.TempDir(), "big")
	f, _ := os.Create(p)
	f.Truncate(maxEditSize + 1)
	f.Close()
	_, err := edit(t, p, "a", "b")
	wantCode(t, err, "too_large")
}

func TestFileStat(t *testing.T) {
	dir := t.TempDir()
	p := filepath.Join(dir, "f")
	writeFile(t, p, "abc", 0o640)
	out, err := run(t, &protocol.FileStatSpec{Path: p}, nil)
	if err != nil {
		t.Fatal(err)
	}
	st := statResult(t, out)
	if st.Type != "file" || st.Size != 3 || st.Mode != "0640" || st.Path != p {
		t.Fatalf("result: %+v", st)
	}
	if st.LinkTarget != nil {
		t.Fatalf("unexpected link target %q", *st.LinkTarget)
	}
	if _, err := os.Stat(p); err != nil || st.MTime == "" {
		t.Fatal("mtime")
	}

	out, _ = run(t, &protocol.FileStatSpec{Path: dir}, nil)
	if stat := statResult(t, out); stat.Type != "dir" {
		t.Fatalf("result: %+v", stat)
	}

	_, err = run(t, &protocol.FileStatSpec{Path: filepath.Join(dir, "nope")}, nil)
	wantCode(t, err, "not_found")
}

func TestFileStatSymlink(t *testing.T) {
	dir := t.TempDir()
	l := filepath.Join(dir, "l")
	if err := os.Symlink("/nonexistent/target", l); err != nil {
		t.Fatal(err)
	}
	out, err := run(t, &protocol.FileStatSpec{Path: l}, nil)
	if err != nil {
		t.Fatal(err)
	}
	st := statResult(t, out)
	if st.Type != "symlink" || st.LinkTarget == nil || *st.LinkTarget != "/nonexistent/target" {
		t.Fatalf("result: %+v", st)
	}
}

func TestFileList(t *testing.T) {
	dir := t.TempDir()
	for _, n := range []string{"c", "a", "b", "d"} {
		writeFile(t, filepath.Join(dir, n), n, 0o644)
	}
	os.Mkdir(filepath.Join(dir, "sub"), 0o755)
	os.Symlink("a", filepath.Join(dir, "ln"))

	names := func(res *protocol.TaskResult) []string {
		var ns []string
		for _, e := range listResult(t, res).Entries {
			ns = append(ns, e.Name)
		}
		return ns
	}
	out, err := run(t, &protocol.FileListSpec{Path: dir}, nil)
	if err != nil {
		t.Fatal(err)
	}
	if got := listResult(t, out); fmt.Sprint(names(out)) != "[a b c d ln sub]" || got.Truncated {
		t.Fatalf("got %s, truncated %v", fmt.Sprint(names(out)), got.Truncated)
	}
	types := map[string]string{}
	for _, e := range listResult(t, out).Entries {
		types[e.Name] = e.Type
	}
	if types["a"] != "file" || types["sub"] != "dir" || types["ln"] != "symlink" {
		t.Fatalf("types: %v", types)
	}

	out, _ = run(t, &protocol.FileListSpec{Path: dir, Limit: 2}, nil)
	if got := listResult(t, out); fmt.Sprint(names(out)) != "[a b]" || !got.Truncated {
		t.Fatalf("got %s, truncated %v", fmt.Sprint(names(out)), got.Truncated)
	}
	// The entries carry the metadata the node reported for each one.
	first := listResult(t, out).Entries[0]
	if first.Name != "a" || first.Type != "file" || first.Size != 1 || first.Mode != "0644" || first.MTime == "" {
		t.Fatalf("entry: %+v", first)
	}
	out, _ = run(t, &protocol.FileListSpec{Path: dir, Limit: 6}, nil)
	if listResult(t, out).Truncated {
		t.Fatal("exact limit must not truncate")
	}

	_, err = run(t, &protocol.FileListSpec{Path: filepath.Join(dir, "a")}, nil)
	wantCode(t, err, "not_a_directory")
	missing := filepath.Join(dir, "nope")
	_, err = run(t, &protocol.FileListSpec{Path: missing}, nil)
	wantCode(t, err, "not_found")
	// HEAD stat'ed the path, so its message says "stat"; the listing must keep that wording.
	wantMessage(t, err, "stat "+missing+": no such file or directory")
}

// TestFileListResultFitsAFrame covers the entry budget of a listing: its result travels in one
// task.exit frame, so a huge directory is listed up to the budget and reported truncated
// (doc/protocol.md TaskResult).
func TestFileListResultFitsAFrame(t *testing.T) {
	dir := t.TempDir()
	for i := range 2000 {
		writeFile(t, filepath.Join(dir, fmt.Sprintf("%04d-%s", i, strings.Repeat("x", 200))), "", 0o644)
	}
	res, err := run(t, &protocol.FileListSpec{Path: dir, Limit: 5000}, nil)
	if err != nil {
		t.Fatal(err)
	}
	list := listResult(t, res)
	if !list.Truncated {
		t.Fatalf("a %d-entry listing is not truncated", len(list.Entries))
	}
	if len(list.Entries) == 0 || len(list.Entries) >= 2000 {
		t.Fatalf("kept %d entries, want some but not all", len(list.Entries))
	}
	// The exit carrying it still fits one frame.
	raw, err := protocol.Marshal(protocol.TaskExit{
		TaskID:  "t-list",
		Outcome: protocol.Outcome{Kind: protocol.OutcomeCode, Code: 0},
		Result:  res,
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(raw) > protocol.MaxFrameBytes {
		t.Fatalf("task.exit is %d bytes, over the %d-byte frame", len(raw), protocol.MaxFrameBytes)
	}
}

func TestFileListEmpty(t *testing.T) {
	out, err := run(t, &protocol.FileListSpec{Path: t.TempDir()}, nil)
	if err != nil {
		t.Fatal(err)
	}
	if entries := listResult(t, out).Entries; len(entries) != 0 {
		t.Fatalf("entries: %v", entries)
	}
}

// TestFileListEntryErrorNamesTheEntry covers a per-entry stat that fails: HEAD's DirEntry.Info
// reported "lstat dir/name", and the listing keeps that wording now that it stats the entry through
// the directory fd. A directory without search permission can be read, but its entries cannot be
// stat'ed.
func TestFileListEntryErrorNamesTheEntry(t *testing.T) {
	if os.Geteuid() == 0 {
		t.Skip("root stats entries in a directory it cannot search")
	}
	dir := t.TempDir()
	sub := filepath.Join(dir, "sub")
	if err := os.Mkdir(sub, 0o755); err != nil {
		t.Fatal(err)
	}
	entry := filepath.Join(sub, "f")
	writeFile(t, entry, "x", 0o644)
	if err := os.Chmod(sub, 0o400); err != nil {
		t.Fatal(err)
	}
	defer os.Chmod(sub, 0o755)

	_, err := run(t, &protocol.FileListSpec{Path: sub}, nil)
	wantCode(t, err, "permission_denied")
	wantMessage(t, err, "lstat "+entry+": permission denied")
}

// TestFileWriteRenameErrorStaysBare covers the message of a rename that fails after the content was
// written: HEAD reported the errno alone, not the rename prefixed with the temporary file's random
// name. The directory loses write permission once the temporary file exists.
func TestFileWriteRenameErrorStaysBare(t *testing.T) {
	if os.Geteuid() == 0 {
		t.Skip("root renames in a directory it cannot write")
	}
	dir := t.TempDir()
	input := &chmodOnRead{dir: dir, mode: 0o555, bytes: []byte("abc")}
	defer os.Chmod(dir, 0o755)

	_, err := run(t, writeSpec(filepath.Join(dir, "f"), "abc"), input)
	wantCode(t, err, "permission_denied")
	wantMessage(t, err, "permission denied")
}
