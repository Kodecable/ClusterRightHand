package statedir

import (
	"errors"
	"os"
	"path/filepath"
	"strings"
	"syscall"
	"testing"
	"time"
)

// fakeInfo is an os.FileInfo whose owner and mode the test chooses. verify takes its stat function
// as a parameter, so ownership rules can be tested without being root.
type fakeInfo struct {
	mode os.FileMode
	uid  uint32
	gid  uint32
}

func (f fakeInfo) Name() string       { return "" }
func (f fakeInfo) Size() int64        { return 0 }
func (f fakeInfo) Mode() os.FileMode  { return f.mode }
func (f fakeInfo) ModTime() time.Time { return time.Time{} }
func (f fakeInfo) IsDir() bool        { return f.mode.IsDir() }
func (f fakeInfo) Sys() any           { return &syscall.Stat_t{Uid: f.uid, Gid: f.gid} }

// fakeFS returns a stat function for the given files. A path that is not listed does not exist.
func fakeFS(files map[string]fakeInfo) func(string) (os.FileInfo, error) {
	return func(path string) (os.FileInfo, error) {
		fi, ok := files[path]
		if !ok {
			return nil, &os.PathError{Op: "lstat", Path: path, Err: os.ErrNotExist}
		}
		return fi, nil
	}
}

func TestVerifyAcceptsPrivateDirectory(t *testing.T) {
	if err := Verify(t.TempDir()); err != nil {
		t.Fatalf("Verify(t.TempDir()) = %v, want it accepted", err)
	}
}

func TestVerifyRefusesSymlinkedDirectory(t *testing.T) {
	real := t.TempDir()
	link := filepath.Join(t.TempDir(), "state")
	if err := os.Symlink(real, link); err != nil {
		t.Fatal(err)
	}
	err := Verify(link)
	if err == nil || !strings.Contains(err.Error(), "symbolic link") {
		t.Fatalf("Verify(symlink) = %v, want a symbolic-link refusal", err)
	}
	if !strings.Contains(err.Error(), DefaultDir) {
		t.Fatalf("error %q does not name %s", err, DefaultDir)
	}
}

func TestVerifyRefusesGroupWritableDirectory(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "state")
	if err := os.Mkdir(dir, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(dir, 0o770); err != nil {
		t.Fatal(err)
	}
	err := Verify(dir)
	if err == nil || !strings.Contains(err.Error(), "writable by group or others") {
		t.Fatalf("Verify(group-writable) = %v, want a mode refusal", err)
	}
}

func TestVerifyRefusesDirectoryOwnedByAnotherUID(t *testing.T) {
	if os.Geteuid() != 0 {
		t.Skip("changing the owner needs root")
	}
	dir := filepath.Join(t.TempDir(), "state")
	if err := os.Mkdir(dir, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.Chown(dir, 12345, 12345); err != nil {
		t.Fatal(err)
	}
	err := Verify(dir)
	if err == nil || !strings.Contains(err.Error(), "owned by uid 12345") {
		t.Fatalf("Verify(other-owned) = %v, want an owner refusal", err)
	}
}

func TestVerifyRefusesParentTheUnprivilegedUserOwns(t *testing.T) {
	const euid = 1000
	dir := "/var/lib/crha/privileged"
	fs := fakeFS(map[string]fakeInfo{
		dir:             {mode: os.ModeDir | 0o700, uid: euid},
		"/var/lib/crha": {mode: os.ModeDir | 0o700, uid: 998},
		"/var/lib":      {mode: os.ModeDir | 0o755, uid: 0},
		"/var":          {mode: os.ModeDir | 0o755, uid: 0},
		"/":             {mode: os.ModeDir | 0o755, uid: 0},
	})
	err := verify(dir, fs, euid)
	if err == nil || !strings.Contains(err.Error(), "/var/lib/crha") ||
		!strings.Contains(err.Error(), "owned by uid 998") {
		t.Fatalf("verify(crha-owned parent) = %v, want the parent named", err)
	}
}

func TestVerifyRefusesWorldWritableParentWithoutStickyBit(t *testing.T) {
	const euid = 1000
	dir := "/tmp/test/state"
	fs := fakeFS(map[string]fakeInfo{
		dir:         {mode: os.ModeDir | 0o700, uid: euid},
		"/tmp/test": {mode: os.ModeDir | 0o700, uid: euid},
		"/tmp":      {mode: os.ModeDir | 0o777, uid: 0},
		"/":         {mode: os.ModeDir | 0o755, uid: 0},
	})
	err := verify(dir, fs, euid)
	if err == nil || !strings.Contains(err.Error(), "/tmp") ||
		!strings.Contains(err.Error(), "writable by group or others") {
		t.Fatalf("verify(world-writable /tmp) = %v, want the parent named", err)
	}
}

func TestVerifyAllowsStickyParent(t *testing.T) {
	const euid = 1000
	dir := "/tmp/test/state"
	fs := fakeFS(map[string]fakeInfo{
		dir:         {mode: os.ModeDir | 0o700, uid: euid},
		"/tmp/test": {mode: os.ModeDir | 0o700, uid: euid},
		"/tmp":      {mode: os.ModeDir | os.ModeSticky | 0o777, uid: 0},
		"/":         {mode: os.ModeDir | 0o755, uid: 0},
	})
	if err := verify(dir, fs, euid); err != nil {
		t.Fatalf("verify(sticky parent) = %v, want it accepted", err)
	}
}

func TestVerifyRefusesRelativePath(t *testing.T) {
	fs := fakeFS(nil)
	err := verify("relative/state", fs, 1000)
	if err == nil || !strings.Contains(err.Error(), "absolute") {
		t.Fatalf("verify(relative) = %v, want an absolute-path refusal", err)
	}
}

func TestVerifyReportsMissingDirectory(t *testing.T) {
	err := verify("/does/not/exist/state", fakeFS(nil), 1000)
	if err == nil || !errors.Is(err, os.ErrNotExist) && !strings.Contains(err.Error(), "cannot be inspected") {
		t.Fatalf("verify(missing) = %v, want a stat error", err)
	}
}
