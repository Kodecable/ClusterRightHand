package executor

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"golang.org/x/sys/unix"

	"github.com/Kodecable/ClusterRightHand/client/internal/protocol"
)

// privateDir returns a temporary directory with every path component resolved. Privileged file
// tasks refuse a symbolic link at any level, and on some systems the temporary directory itself is
// reached through one.
func privateDir(t *testing.T) string {
	t.Helper()
	dir, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	return dir
}

func privilegedSpec(kind any) *protocol.TaskSpec {
	spec := &protocol.TaskSpec{}
	switch k := kind.(type) {
	case *protocol.FileReadSpec:
		spec.Kind, spec.FileRead = protocol.TaskSpecFileRead, k
	case *protocol.FileWriteSpec:
		spec.Kind, spec.FileWrite = protocol.TaskSpecFileWrite, k
	case *protocol.FilePushSpec:
		spec.Kind, spec.FilePush = protocol.TaskSpecFilePush, k
	case *protocol.FileEditSpec:
		spec.Kind, spec.FileEdit = protocol.TaskSpecFileEdit, k
	case *protocol.FileStatSpec:
		spec.Kind, spec.FileStat = protocol.TaskSpecFileStat, k
	case *protocol.FileListSpec:
		spec.Kind, spec.FileList = protocol.TaskSpecFileList, k
	}
	return spec
}

func runPrivileged(t *testing.T, kind any, input io.Reader) (*protocol.TaskResult, error) {
	t.Helper()
	var out strings.Builder
	result, err := RunFilePrivileged(context.Background(), privilegedSpec(kind), input, &out)
	if err != nil {
		return nil, err
	}
	return result, nil
}

func TestPrivilegedFilePlainPaths(t *testing.T) {
	dir := privateDir(t)
	p := filepath.Join(dir, "f")
	writeFile(t, p, "one\ntwo\nthree\n", 0o640)

	// The privileged executor pages by lines exactly like the unprivileged one, with the protections
	// around the open (doc/design/privilege.md "Methods and targets").
	read := func(start, count uint64) (string, *protocol.FileReadResult) {
		t.Helper()
		var out strings.Builder
		spec := privilegedSpec(&protocol.FileReadSpec{Path: p, StartLine: protocol.Uint(start), LineCount: protocol.Uint(count)})
		res, err := RunFilePrivileged(context.Background(), spec, nil, &out)
		if err != nil {
			t.Fatal(err)
		}
		if res.FileRead == nil {
			t.Fatalf("no file.read result: %+v", res)
		}
		return out.String(), res.FileRead
	}
	page, res := read(1, 2)
	if page != "one\ntwo\n" || res.From != 1 || res.To != 2 || res.EOF || res.Total != nil || res.TooLong {
		t.Fatalf("first page: %q %+v", page, res)
	}
	page, res = read(3, 5)
	if page != "three\n" || !res.EOF || res.Total == nil || *res.Total != 3 || res.From != 3 || res.To != 3 {
		t.Fatalf("last page: %q %+v", page, res)
	}
	page, res = read(9, 1)
	if page != "" || !res.EOF || res.Total == nil || *res.Total != 3 || res.From != 0 || res.To != 0 {
		t.Fatalf("past the end: %q %+v", page, res)
	}

	out, err := runPrivileged(t, &protocol.FileStatSpec{Path: p}, nil)
	if err != nil {
		t.Fatal(err)
	}
	st := statResult(t, out)
	if st.Type != "file" || st.Size != 14 || st.Mode != "0640" || st.Path != p {
		t.Fatalf("stat: %+v", st)
	}
	if st.LinkTarget != nil {
		t.Fatalf("privileged stat reported a link target %q", *st.LinkTarget)
	}
	out, err = runPrivileged(t, &protocol.FileStatSpec{Path: dir}, nil)
	if err != nil || statResult(t, out).Type != "dir" {
		t.Fatalf("stat dir: %+v %v", out, err)
	}

	writeFile(t, filepath.Join(dir, "b"), "b", 0o644)
	writeFile(t, filepath.Join(dir, "a"), "a", 0o644)
	out, err = runPrivileged(t, &protocol.FileListSpec{Path: dir}, nil)
	if err != nil {
		t.Fatal(err)
	}
	var names []string
	for _, e := range listResult(t, out).Entries {
		names = append(names, e.Name)
	}
	if got := strings.Join(names, ","); got != "a,b,f" {
		t.Fatalf("list: %s", got)
	}
}

func TestPrivilegedFileWriteAndEdit(t *testing.T) {
	dir := privateDir(t)
	p := filepath.Join(dir, "new")
	out, err := runPrivileged(t, writeSpec(p, "hello"), strings.NewReader("hello"))
	if err != nil {
		t.Fatal(err)
	}
	if w := writeResult(t, out); w.Bytes != 5 || !w.Created {
		t.Fatalf("write: %+v", w)
	}
	if readFileStr(t, p) != "hello" {
		t.Fatal("content")
	}
	if fi, _ := os.Stat(p); fi.Mode().Perm() != 0o644 {
		t.Fatalf("mode %v", fi.Mode())
	}
	noTemps(t, dir)

	// overwrite = false refuses an existing file and leaves it alone.
	_, err = runPrivileged(t, writeSpec(p, "other"), strings.NewReader("other"))
	wantCode(t, err, "exists")
	if readFileStr(t, p) != "hello" {
		t.Fatal("file was modified")
	}

	// overwrite keeps the existing mode.
	if err := os.Chmod(p, 0o600); err != nil {
		t.Fatal(err)
	}
	s := writeSpec(p, "other")
	s.Overwrite = true
	if _, err := runPrivileged(t, s, strings.NewReader("other")); err != nil {
		t.Fatal(err)
	}
	if readFileStr(t, p) != "other" {
		t.Fatal("overwrite content")
	}
	if fi, _ := os.Stat(p); fi.Mode().Perm() != 0o600 {
		t.Fatalf("overwrite mode %v", fi.Mode())
	}

	// edit replaces and keeps the mode.
	if err := os.Chmod(p, 0o750); err != nil {
		t.Fatal(err)
	}
	edits := &protocol.FileEditSpec{Path: p, Edits: []protocol.Edit{{OldText: "other", NewText: "edited"}}}
	out, err = runPrivileged(t, edits, nil)
	if err != nil {
		t.Fatal(err)
	}
	if e := editResult(t, out); e.Replacements != 1 {
		t.Fatalf("edit: %+v", e)
	}
	if readFileStr(t, p) != "edited" {
		t.Fatal("edit content")
	}
	if fi, _ := os.Stat(p); fi.Mode().Perm() != 0o750 {
		t.Fatalf("edit mode %v", fi.Mode())
	}
	noTemps(t, dir)

	// A content mismatch leaves nothing behind.
	s = writeSpec(filepath.Join(dir, "mismatch"), "hello")
	_, err = runPrivileged(t, s, strings.NewReader("jello"))
	wantCode(t, err, "input_mismatch")
	if _, err := os.Lstat(filepath.Join(dir, "mismatch")); !os.IsNotExist(err) {
		t.Fatal("target created")
	}
	noTemps(t, dir)

	// A directory without read permission still accepts a write, like the unprivileged path: only
	// write and execute are needed to create a file in it.
	writeOnly := filepath.Join(dir, "write-only")
	if err := os.Mkdir(writeOnly, 0o300); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.Chmod(writeOnly, 0o700) })
	target := filepath.Join(writeOnly, "f")
	if _, err := runPrivileged(t, writeSpec(target, "inside"), strings.NewReader("inside")); err != nil {
		t.Fatalf("write into a write-only directory: %v", err)
	}
	if readFileStr(t, target) != "inside" {
		t.Fatal("content in a write-only directory")
	}
	edits = &protocol.FileEditSpec{Path: target, Edits: []protocol.Edit{{OldText: "inside", NewText: "edited"}}}
	if _, err := runPrivileged(t, edits, nil); err != nil {
		t.Fatalf("edit in a write-only directory: %v", err)
	}
	if readFileStr(t, target) != "edited" {
		t.Fatal("edited content in a write-only directory")
	}

	// Writing through the directory path itself is a directory, not a file.
	if _, err := runPrivileged(t, writeSpec(dir, "x"), strings.NewReader("x")); err == nil {
		t.Fatal("wrote a directory path")
	} else {
		wantCode(t, err, "is_directory")
	}
}

func TestPrivilegedFileSymlinks(t *testing.T) {
	dir := privateDir(t)
	realDir := filepath.Join(dir, "real")
	if err := os.Mkdir(realDir, 0o755); err != nil {
		t.Fatal(err)
	}
	writeFile(t, filepath.Join(realDir, "f"), "content", 0o644)

	// Links at the end and in the middle of the path, and to both files and directories.
	fileLink := filepath.Join(dir, "file-link")
	dirLink := filepath.Join(dir, "dir-link")
	if err := os.Symlink(filepath.Join(realDir, "f"), fileLink); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(realDir, dirLink); err != nil {
		t.Fatal(err)
	}
	middle := filepath.Join(dirLink, "f")

	for _, tc := range []struct {
		name string
		kind any
		in   io.Reader
	}{
		{"read file link", &protocol.FileReadSpec{Path: fileLink}, nil},
		{"read middle link", &protocol.FileReadSpec{Path: middle}, nil},
		{"stat file link", &protocol.FileStatSpec{Path: fileLink}, nil},
		{"stat middle link", &protocol.FileStatSpec{Path: middle}, nil},
		{"list dir link", &protocol.FileListSpec{Path: dirLink}, nil},
		{"list middle link", &protocol.FileListSpec{Path: filepath.Join(dirLink, "f")}, nil},
		{"write file link", writeSpec(fileLink, "new"), strings.NewReader("new")},
		{"write middle link", writeSpec(middle, "new"), strings.NewReader("new")},
		{"write new in link", writeSpec(filepath.Join(dirLink, "new"), "new"), strings.NewReader("new")},
		{"edit file link", &protocol.FileEditSpec{Path: fileLink, Edits: []protocol.Edit{{OldText: "content", NewText: "x"}}}, nil},
		{"edit middle link", &protocol.FileEditSpec{Path: middle, Edits: []protocol.Edit{{OldText: "content", NewText: "x"}}}, nil},
	} {
		t.Run(tc.name, func(t *testing.T) {
			_, err := runPrivileged(t, tc.kind, tc.in)
			wantCode(t, err, "symlink_not_allowed")
		})
	}

	// Nothing was changed through the links.
	if got := readFileStr(t, filepath.Join(realDir, "f")); got != "content" {
		t.Fatalf("target content %q", got)
	}
	noTemps(t, dir)
	noTemps(t, realDir)
}

func TestPrivilegedFileErrors(t *testing.T) {
	dir := privateDir(t)
	_, err := runPrivileged(t, &protocol.FileReadSpec{Path: filepath.Join(dir, "missing")}, nil)
	wantCode(t, err, "not_found")
	_, err = runPrivileged(t, &protocol.FileReadSpec{Path: dir}, nil)
	wantCode(t, err, "not_regular_file")
	wantMessage(t, err, dir+" is not a regular file")
	_, err = runPrivileged(t, &protocol.FileListSpec{Path: filepath.Join(dir, "missing")}, nil)
	wantCode(t, err, "not_found")
	_, err = runPrivileged(t, &protocol.FileEditSpec{Path: filepath.Join(dir, "missing"), Edits: []protocol.Edit{{OldText: "a", NewText: "b"}}}, nil)
	wantCode(t, err, "not_found")
	// HEAD failed the edit at the stat and reported the bare errno, without an operation prefix.
	wantMessage(t, err, "no such file or directory")
	_, err = runPrivileged(t, &protocol.FileStatSpec{Path: "relative"}, nil)
	wantCode(t, err, "invalid_spec")
}

func TestOpenat2ErrorMapping(t *testing.T) {
	for _, tc := range []struct {
		name string
		err  error
		code string
	}{
		{"symlink", unix.ELOOP, "symlink_not_allowed"},
		{"old kernel", unix.ENOSYS, "openat2_unavailable"},
		{"seccomp", unix.EPERM, "openat2_unavailable"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			err := openat2Error("/etc/x", tc.err)
			var e *Error
			if !errors.As(err, &e) || e.Code != tc.code {
				t.Fatalf("got %v, want code %s", err, tc.code)
			}
		})
	}
	// Any other failure keeps its errno so the normal mapping applies (for example ENOENT).
	err := openat2Error("/etc/x", unix.ENOENT)
	var e *Error
	if errors.As(err, &e) {
		t.Fatalf("ENOENT became %v, want the raw error", e)
	}
	if !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("got %v, want a not-found error", err)
	}
}

func TestPrivilegedExecEnvironment(t *testing.T) {
	ctx := context.Background()
	o := NewOutput("x", "", OutputOptions{})
	res := RunExec(ctx, &protocol.ExecSpec{
		Command: protocol.Command{Kind: protocol.CommandShell, Shell: `printf '%s|%s|%s' "$PATH" "$CRH_X" "$(pwd)"`},
		Env:     map[string]string{"CRH_X": "y", "PATH": "/evil"},
	}, nil, o, ExecOptions{Privileged: true})
	o.Close()
	if res.Err != nil || res.ExitCode == nil || *res.ExitCode != 0 {
		t.Fatalf("res %+v", res)
	}
	want := PrivilegedPath + "|y|/"
	if got := readAll(t, o, 0); got != want {
		t.Fatalf("got %q, want %q", got, want)
	}

	// A bare command name resolves against the fixed PATH, not crha's environment.
	o = NewOutput("x", "", OutputOptions{})
	res = RunExec(ctx, &protocol.ExecSpec{
		Command: protocol.Command{Kind: protocol.CommandArgv, Argv: []string{"printenv", "PATH"}},
	}, nil, o, ExecOptions{Privileged: true})
	o.Close()
	if res.Err != nil {
		t.Fatalf("res %+v", res)
	}
	if got := readAll(t, o, 0); got != PrivilegedPath+"\n" {
		t.Fatalf("printenv PATH = %q", got)
	}

	o = NewOutput("x", "", OutputOptions{})
	res = RunExec(ctx, &protocol.ExecSpec{
		Command: protocol.Command{Kind: protocol.CommandArgv, Argv: []string{"no-such-command-crh"}},
	}, nil, o, ExecOptions{Privileged: true})
	o.Close()
	if res.Err == nil || res.Err.Code != "not_found" {
		t.Fatalf("missing command: %+v", res)
	}

	// An invalid variable name fails closed instead of reaching exec with a malformed environment.
	o = NewOutput("x", "", OutputOptions{})
	res = RunExec(ctx, &protocol.ExecSpec{
		Command: protocol.Command{Kind: protocol.CommandArgv, Argv: []string{"/bin/true"}},
		Env:     map[string]string{"A=B": "x"},
	}, nil, o, ExecOptions{Privileged: true})
	o.Close()
	if res.Err == nil || res.Err.Code != "invalid_spec" {
		t.Fatalf("invalid env: %+v", res)
	}
}

func TestResultOutcome(t *testing.T) {
	code := int32(3)
	if got := (Result{ExitCode: &code}).Outcome(); got.Kind != protocol.OutcomeCode || got.Code != 3 {
		t.Fatalf("code outcome: %+v", got)
	}
	if got := (Result{Signal: "TERM"}).Outcome(); got.Kind != protocol.OutcomeSignal || got.Signal != "TERM" {
		t.Fatalf("signal outcome: %+v", got)
	}
	if got := (Result{Err: &Error{Code: "nope", Message: "m"}}).Outcome(); got.Kind != protocol.OutcomeError || got.Error.Code != "nope" {
		t.Fatalf("error outcome: %+v", got)
	}
	if got := (Result{}).Outcome(); got.Kind != protocol.OutcomeError || got.Error.Code != "internal_error" {
		t.Fatalf("empty outcome: %+v", got)
	}
	written := &protocol.TaskResult{Kind: protocol.TaskResultFileWrite, FileWrite: &protocol.FileWriteResult{Bytes: 1}}
	if got := FileResult(written, nil); got.ExitCode == nil || *got.ExitCode != 0 || got.TaskResult != written {
		t.Fatalf("successful file task: %+v", got)
	}
	if got := FileResult(nil, errf("cancelled", "x")); got.Err == nil || !got.Cancelled || got.TaskResult != nil {
		t.Fatalf("cancelled file task: %+v", got)
	}
}

// fileModeBits renders the permission, setuid, setgid and sticky bits of path as octal.
func fileModeBits(t *testing.T, path string) string {
	t.Helper()
	var st unix.Stat_t
	if err := unix.Stat(path, &st); err != nil {
		t.Fatal(err)
	}
	return fmt.Sprintf("%04o", st.Mode&0o7777)
}

// TestFileWriteSpecialModes covers the mode of a file.write: setuid, setgid and sticky are kept,
// both when the request names them and when an existing file's mode is reused
// (doc/design/privilege.md "Methods and targets").
func TestPrivilegedFileWriteCreateParentDirs(t *testing.T) {
	dir := privateDir(t)
	p := filepath.Join(dir, "a", "b", "f")
	s := writeSpec(p, "hello")
	s.CreateParentDirs = true
	if _, err := runPrivileged(t, s, strings.NewReader("hello")); err != nil {
		t.Fatal(err)
	}
	if readFileStr(t, p) != "hello" {
		t.Fatal("content")
	}
	for _, d := range []string{"a", filepath.Join("a", "b")} {
		fi, err := os.Stat(filepath.Join(dir, d))
		if err != nil {
			t.Fatal(err)
		}
		if fi.Mode().Perm() != 0o755 {
			t.Fatalf("%s mode = %v, want 0755 before the umask", d, fi.Mode())
		}
	}

	// Without create_parent_dirs a missing parent is still not_found.
	s = writeSpec(filepath.Join(dir, "x", "y", "f"), "x")
	_, err := runPrivileged(t, s, strings.NewReader("x"))
	wantCode(t, err, "not_found")
}

func TestPrivilegedFilePushCreateParentDirs(t *testing.T) {
	dir := privateDir(t)
	p := filepath.Join(dir, "a", "b", "f")
	s := pushSpec(p, []byte("hello"))
	s.CreateParentDirs = true
	if _, err := runPrivileged(t, s, strings.NewReader("hello")); err != nil {
		t.Fatal(err)
	}
	if readFileStr(t, p) != "hello" {
		t.Fatal("content")
	}
	for _, d := range []string{"a", filepath.Join("a", "b")} {
		fi, err := os.Stat(filepath.Join(dir, d))
		if err != nil {
			t.Fatal(err)
		}
		if fi.Mode().Perm() != 0o755 {
			t.Fatalf("%s mode = %v, want 0755 before the umask", d, fi.Mode())
		}
	}

	// Without create_parent_dirs a missing parent is still not_found.
	s = pushSpec(filepath.Join(dir, "x", "y", "f"), []byte("x"))
	_, err := runPrivileged(t, s, strings.NewReader("x"))
	wantCode(t, err, "not_found")
}

func TestPrivilegedFilePushCreateParentDirsRefusesSymlink(t *testing.T) {
	dir := privateDir(t)
	outside := t.TempDir()
	if err := os.Symlink(outside, filepath.Join(dir, "link")); err != nil {
		t.Fatal(err)
	}
	s := pushSpec(filepath.Join(dir, "link", "a", "f"), []byte("x"))
	s.CreateParentDirs = true
	_, err := runPrivileged(t, s, strings.NewReader("x"))
	wantCode(t, err, "symlink_not_allowed")
}

func TestPrivilegedFileWriteCreateParentDirsRefusesSymlink(t *testing.T) {
	dir := privateDir(t)
	outside := t.TempDir()
	if err := os.Symlink(outside, filepath.Join(dir, "link")); err != nil {
		t.Fatal(err)
	}
	s := writeSpec(filepath.Join(dir, "link", "a", "f"), "x")
	s.CreateParentDirs = true
	_, err := runPrivileged(t, s, strings.NewReader("x"))
	wantCode(t, err, "symlink_not_allowed")
	if _, err := os.Stat(filepath.Join(outside, "a")); !os.IsNotExist(err) {
		t.Fatal("created a directory outside the resolved path")
	}
}

func TestFileWriteSpecialModes(t *testing.T) {
	test := func(t *testing.T, run func(t *testing.T, spec *protocol.FileWriteSpec, input io.Reader) error) {
		dir := privateDir(t)
		for _, tc := range []struct {
			name string
			mode uint32
		}{
			{"setuid", 0o4755},
			{"setgid", 0o2755},
			{"sticky", 0o1777},
			{"all", 0o7755},
		} {
			t.Run(tc.name, func(t *testing.T) {
				path := filepath.Join(dir, "mode-"+tc.name)
				spec := writeSpec(path, "content")
				spec.Mode = protocol.Uint(tc.mode)
				if err := run(t, spec, strings.NewReader("content")); err != nil {
					t.Fatalf("write: %v", err)
				}
				if got := fileModeBits(t, path); got != fmt.Sprintf("%04o", tc.mode) {
					t.Fatalf("mode = %s, want %04o", got, tc.mode)
				}
				noTemps(t, dir)

				// Overwriting with mode 0 keeps the existing bits.
				overwrite := writeSpec(path, "other")
				overwrite.Overwrite = true
				if err := run(t, overwrite, strings.NewReader("other")); err != nil {
					t.Fatalf("overwrite: %v", err)
				}
				if got := fileModeBits(t, path); got != fmt.Sprintf("%04o", tc.mode) {
					t.Fatalf("overwrite mode = %s, want the existing %04o", got, tc.mode)
				}
				noTemps(t, dir)
			})
		}
	}

	t.Run("unprivileged", func(t *testing.T) {
		test(t, func(t *testing.T, spec *protocol.FileWriteSpec, input io.Reader) error {
			_, err := run(t, spec, input)
			return err
		})
	})
	t.Run("privileged", func(t *testing.T) {
		test(t, func(t *testing.T, spec *protocol.FileWriteSpec, input io.Reader) error {
			_, err := runPrivileged(t, spec, input)
			return err
		})
	})
}

// TestPrivilegedFileSpecialFiles covers FIFOs and sockets: opening one for reading must not block
// a privileged file task forever, so both are refused with not_regular_file
// (doc/design/privilege.md "Methods and targets").
func TestPrivilegedFileSpecialFiles(t *testing.T) {
	dir := privateDir(t)
	fifo := filepath.Join(dir, "fifo")
	if err := unix.Mkfifo(fifo, 0o600); err != nil {
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
			_, err := RunFilePrivileged(context.Background(), spec, nil, io.Discard)
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
			spec := privilegedSpec(&protocol.FileReadSpec{Path: tc.path, StartLine: 1, LineCount: 1})
			wantCode(t, runSpecial(t, spec), "not_regular_file")
		})
		t.Run(tc.name+"/list", func(t *testing.T) {
			wantCode(t, runSpecial(t, privilegedSpec(&protocol.FileListSpec{Path: tc.path})), "not_regular_file")
		})
		t.Run(tc.name+"/edit", func(t *testing.T) {
			// The edit opens the file too, so it must not block on a FIFO that has no writer.
			spec := privilegedSpec(&protocol.FileEditSpec{Path: tc.path, Edits: []protocol.Edit{{OldText: "a", NewText: "b"}}})
			wantCode(t, runSpecial(t, spec), "not_regular_file")
		})
	}
}

// TestPrivilegedFileReadEditRequireRegularFile covers the type rule of privileged file.read and
// file.edit: the path is opened as O_PATH first, so a device is never opened for reading and a
// directory is refused as not_regular_file.
func TestPrivilegedFileReadEditRequireRegularFile(t *testing.T) {
	dir := privateDir(t)
	p := filepath.Join(dir, "f")
	writeFile(t, p, "one\ntwo\n", 0o644)

	read := func(t *testing.T, path string) (*protocol.TaskResult, error) {
		t.Helper()
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		return RunFilePrivileged(ctx, privilegedSpec(&protocol.FileReadSpec{
			Path: path, StartLine: 2, LineCount: 10,
		}), nil, io.Discard)
	}
	edit := func(t *testing.T, path string) error {
		t.Helper()
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		_, err := RunFilePrivileged(ctx, privilegedSpec(&protocol.FileEditSpec{
			Path: path, Edits: []protocol.Edit{{OldText: "one", NewText: "1"}},
		}), nil, io.Discard)
		return err
	}

	if _, err := read(t, p); err != nil {
		t.Fatal(err)
	}
	if err := edit(t, p); err != nil {
		t.Fatal(err)
	}
	if got := readFileStr(t, p); got != "1\ntwo\n" {
		t.Fatalf("content = %q", got)
	}

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
	_, err := read(t, dev)
	wantCode(t, err, "not_regular_file")
	wantMessage(t, err, dev+" is not a regular file")
	err = edit(t, dev)
	wantCode(t, err, "not_regular_file")
	wantMessage(t, err, dev+" is not a regular file")
}

// TestPrivilegedFileListChecksTypeBeforeOpening covers the order of a privileged listing: it stats
// the path with O_PATH first and opens only a directory for reading. A mode-000 FIFO is refused as
// not_regular_file because no read open is attempted, a regular file is still not_a_directory, and
// a directory is still listed.
func TestPrivilegedFileListChecksTypeBeforeOpening(t *testing.T) {
	dir := privateDir(t)
	regular := filepath.Join(dir, "regular")
	writeFile(t, regular, "x", 0o644)
	fifo := filepath.Join(dir, "fifo")
	if err := unix.Mkfifo(fifo, 0o600); err != nil {
		t.Fatal(err)
	}
	noReadFIFO := filepath.Join(dir, "fifo-no-read")
	if err := unix.Mkfifo(noReadFIFO, 0); err != nil {
		t.Fatal(err)
	}

	type listOut struct {
		result *protocol.TaskResult
		err    error
	}
	list := func(t *testing.T, path string) listOut {
		t.Helper()
		done := make(chan listOut, 1)
		go func() {
			result, err := RunFilePrivileged(context.Background(),
				privilegedSpec(&protocol.FileListSpec{Path: path}), nil, io.Discard)
			done <- listOut{result: result, err: err}
		}()
		select {
		case out := <-done:
			return out
		case <-time.After(5 * time.Second):
			t.Fatal("listing a non-directory blocked the task")
			return listOut{}
		}
	}

	out := list(t, dir)
	if out.err != nil {
		t.Fatalf("list directory: %v", out.err)
	}
	var names []string
	for _, e := range listResult(t, out.result).Entries {
		names = append(names, e.Name)
	}
	if got := strings.Join(names, ","); got != "fifo,fifo-no-read,regular" {
		t.Fatalf("list: %s", got)
	}

	// No writer ever opens either FIFO. The mode-000 one would fail a read open with
	// permission_denied, so not_regular_file shows the type decided from the O_PATH fd alone.
	wantCode(t, list(t, fifo).err, "not_regular_file")
	wantCode(t, list(t, noReadFIFO).err, "not_regular_file")

	// A regular file keeps the not_a_directory result an open-and-stat listing reported.
	wantCode(t, list(t, regular).err, "not_a_directory")
	wantMessage(t, list(t, regular).err, regular+" is not a directory")

	// An unreadable regular file reports permission_denied without being opened.
	if os.Geteuid() != 0 {
		unreadable := filepath.Join(dir, "unreadable")
		writeFile(t, unreadable, "x", 0o600)
		if err := os.Chmod(unreadable, 0); err != nil {
			t.Fatal(err)
		}
		err := list(t, unreadable).err
		wantCode(t, err, "permission_denied")
		wantMessage(t, err, "permission denied")
	}
}
