package taskrun

import (
	"crypto/sha256"
	"errors"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/Kodecable/ClusterRightHand/client/internal/protocol"
)

// stdinStart is an exec task that declares size bytes of stdin.
func stdinStart(size uint64, sum protocol.Hash) protocol.TaskStart {
	return protocol.TaskStart{
		TaskID: "t-stdin",
		Spec: protocol.TaskSpec{
			Kind: protocol.TaskSpecExec,
			Exec: &protocol.ExecSpec{
				Command: protocol.Command{Kind: protocol.CommandArgv, Argv: []string{"/bin/true"}},
				Stdin:   &protocol.InputRef{Size: protocol.Uint(size), SHA256: sum},
			},
		},
	}
}

// TestSpoolLivesBelowStateDir covers where a task's stdin is staged and that the staged file is
// removed when the task ends: the file is in the privileged state directory's stdin subdirectory,
// not in the process's temporary directory.
func TestSpoolLivesBelowStateDir(t *testing.T) {
	root := t.TempDir()
	sum := sha256.Sum256([]byte("abc"))
	task, err := New(stdinStart(3, protocol.Hash(sum)), func(uint64, []byte) error { return nil }, nil, root)
	if err != nil {
		t.Fatal(err)
	}
	dir := filepath.Join(root, "stdin")
	if got := filepath.Dir(task.spoolPath); got != dir {
		t.Fatalf("spool path %s, want it below %s", task.spoolPath, dir)
	}
	fi, err := os.Stat(dir)
	if err != nil {
		t.Fatal(err)
	}
	if fi.Mode().Perm() != 0o700 {
		t.Fatalf("stdin directory mode = %v, want 0700", fi.Mode())
	}
	if fi, err := os.Stat(task.spoolPath); err != nil || fi.Mode().Perm() != 0o600 {
		t.Fatalf("spool file = %v, %v; want mode 0600", fi, err)
	}

	task.Start(nil, nil)
	task.Abort()
	select {
	case <-task.Done():
	case <-time.After(5 * time.Second):
		t.Fatal("the aborted task did not finish")
	}
	if _, err := os.Stat(task.spoolPath); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("staged stdin was not removed: %v", err)
	}
}

// TestDiscardRemovesPreparedStaging covers the cleanup a caller uses when it prepared a task but
// then refused or failed before adding it to the session (for example the daemon's used-record
// write). The task never runs, so Discard must release the staged file itself.
func TestDiscardRemovesPreparedStaging(t *testing.T) {
	root := t.TempDir()
	sum := sha256.Sum256([]byte("abc"))
	task, err := New(stdinStart(3, protocol.Hash(sum)), func(uint64, []byte) error { return nil }, nil, root)
	if err != nil {
		t.Fatal(err)
	}
	path := task.spoolPath
	task.Discard()
	if _, err := os.Stat(path); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("staged stdin was not removed: %v", err)
	}
	// Discarding again is a no-op.
	task.Discard()
}

// TestSpoolRefusesInputThatDoesNotFit covers the free-space rule: the declared size is checked
// before the file is created, and a declaration larger than the filesystem fails with the input
// error code instead of filling it.
func TestSpoolRefusesInputThatDoesNotFit(t *testing.T) {
	root := t.TempDir()
	_, err := New(stdinStart(1<<53-1, protocol.Hash{}), func(uint64, []byte) error { return nil }, nil, root)
	var remote *protocol.RemoteError
	if !errors.As(err, &remote) {
		t.Fatalf("got %v, want a remote error", err)
	}
	if remote.Code != protocol.CodeInputTooLarge {
		t.Fatalf("code = %s, want %s", remote.Code, protocol.CodeInputTooLarge)
	}
	des, err := os.ReadDir(filepath.Join(root, "stdin"))
	if err != nil {
		t.Fatal(err)
	}
	if len(des) != 0 {
		t.Fatalf("a refused task left files behind: %v", des)
	}
}

// TestSpoolFits covers the reserve: the larger of 5% of the filesystem and 64 MiB stays free.
func TestSpoolFits(t *testing.T) {
	const mib = 1 << 20
	for _, tc := range []struct {
		name              string
		total, free, size uint64
		want              bool
	}{
		{"5% reserve, fits", 10 << 30, 1 << 30, 400 * mib, true},
		{"5% reserve, refused", 10 << 30, 1 << 30, 600 * mib, false},
		{"64 MiB reserve, fits", 100 * mib, 100 * mib, 30 * mib, true},
		{"64 MiB reserve, refused", 100 * mib, 100 * mib, 40 * mib, false},
		{"larger than free", 1 << 30, 100 * mib, 200 * mib, false},
		{"free already below reserve", 100 * mib, 10 * mib, 1, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if got := spoolFits(tc.total, tc.free, tc.size); got != tc.want {
				t.Fatalf("spoolFits(%d, %d, %d) = %v, want %v", tc.total, tc.free, tc.size, got, tc.want)
			}
		})
	}
}

// TestSpoolWithoutStateDir covers a session that has no spool root: a task with input is refused
// rather than staged somewhere shared.
func TestSpoolWithoutStateDir(t *testing.T) {
	_, err := New(stdinStart(3, protocol.Hash(sha256.Sum256([]byte("abc")))), func(uint64, []byte) error { return nil }, nil, "")
	var remote *protocol.RemoteError
	if !errors.As(err, &remote) || remote.Code != protocol.CodeInternalError {
		t.Fatalf("got %v, want an internal error for the missing staging directory", err)
	}
}
