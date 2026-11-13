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
	task, err := New(stdinStart(3, protocol.Hash(sum)), func(uint64, []byte) error { return nil }, nil, nil, root)
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
	task, err := New(stdinStart(3, protocol.Hash(sum)), func(uint64, []byte) error { return nil }, nil, nil, root)
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
	_, err := New(stdinStart(1<<53-1, protocol.Hash{}), func(uint64, []byte) error { return nil }, nil, nil, root)
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
	_, err := New(stdinStart(3, protocol.Hash(sha256.Sum256([]byte("abc")))), func(uint64, []byte) error { return nil }, nil, nil, "")
	var remote *protocol.RemoteError
	if !errors.As(err, &remote) || remote.Code != protocol.CodeInternalError {
		t.Fatalf("got %v, want an internal error for the missing staging directory", err)
	}
}

// pullStart is a file.pull task for path.
func pullStart(path string, maxBytes uint64) protocol.TaskStart {
	return protocol.TaskStart{
		TaskID: "t-pull",
		Spec: protocol.TaskSpec{
			Kind: protocol.TaskSpecFilePull,
			FilePull: &protocol.FilePullSpec{
				Path: path, MaxBytes: protocol.Uint(maxBytes),
				Endpoint: protocol.TransferEndpoint{Kind: protocol.TransferEndpointCRHS, TransferID: "tr-1"},
			},
		},
		Privileged: true,
	}
}

// TestPullStreamsContent covers the privileged half of a file.pull: the bytes reach the
// unprivileged mode through the transfer emitter and the result carries the size and digest the
// data connection's receiver checks.
func TestPullStreamsContent(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "f.txt")
	data := []byte("privileged pull")
	if err := os.WriteFile(path, data, 0o600); err != nil {
		t.Fatal(err)
	}
	var got []byte
	task, err := New(pullStart(path, 1024), func(uint64, []byte) error { return nil }, func(chunk []byte) error {
		got = append(got, chunk...)
		return nil
	}, nil, "")
	if err != nil {
		t.Fatal(err)
	}
	var exit *protocol.TaskExit
	task.Start(nil, func(e *protocol.TaskExit) { exit = e })
	<-task.Done()
	if exit == nil {
		t.Fatal("no task.exit")
	}
	if exit.Outcome.Kind != protocol.OutcomeCode || exit.Outcome.Code != 0 {
		t.Fatalf("outcome = %+v", exit.Outcome)
	}
	if exit.Result == nil || exit.Result.Kind != protocol.TaskResultFilePull || exit.Result.FilePull == nil {
		t.Fatalf("result = %+v", exit.Result)
	}
	want := protocol.Hash(sha256.Sum256(data))
	if r := exit.Result.FilePull; protocol.Uint(len(data)) != r.Size || want != r.SHA256 {
		t.Fatalf("file.pull result = %+v", r)
	}
	if string(got) != string(data) {
		t.Fatalf("emitted %q, want %q", got, data)
	}
}

// TestPullTooLargeEmitsNothing covers the pre-send refusal: a file over max_bytes never reaches the
// data connection and fails with too_large.
func TestPullTooLargeEmitsNothing(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "f.txt")
	if err := os.WriteFile(path, []byte("12345"), 0o600); err != nil {
		t.Fatal(err)
	}
	emitted := false
	task, err := New(pullStart(path, 1), func(uint64, []byte) error { return nil }, func([]byte) error {
		emitted = true
		return nil
	}, nil, "")
	if err != nil {
		t.Fatal(err)
	}
	var exit *protocol.TaskExit
	task.Start(nil, func(e *protocol.TaskExit) { exit = e })
	<-task.Done()
	if exit == nil || exit.Outcome.Kind != protocol.OutcomeError || exit.Outcome.Error == nil {
		t.Fatalf("exit = %+v", exit)
	}
	if exit.Outcome.Error.Code != protocol.CodeTooLarge {
		t.Fatalf("error = %+v, want too_large", exit.Outcome.Error)
	}
	if emitted {
		t.Fatal("a too-large file emitted content")
	}
}

// TestPushWritesVerifiedContent covers the privileged half of a file.push: the chunks the
// unprivileged mode relays as task.input are verified against the approved size and digest before
// the file is published.
func TestPushWritesVerifiedContent(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "pushed.txt")
	data := []byte("push me")
	sum := sha256.Sum256(data)
	ts := protocol.TaskStart{
		TaskID: "t-push",
		Spec: protocol.TaskSpec{
			Kind: protocol.TaskSpecFilePush,
			FilePush: &protocol.FilePushSpec{
				Path: path, Size: protocol.Uint(len(data)), SHA256: protocol.Hash(sum),
				Endpoint: protocol.TransferEndpoint{Kind: protocol.TransferEndpointCRHS, TransferID: "tr-1"},
			},
		},
		Privileged: true,
	}
	task, err := New(ts, func(uint64, []byte) error { return nil }, nil, nil, "")
	if err != nil {
		t.Fatal(err)
	}
	var exit *protocol.TaskExit
	task.Start(nil, func(e *protocol.TaskExit) { exit = e })
	if _, err := task.Input(protocol.TaskInput{TaskID: ts.TaskID, Offset: 0, Data: data}); err != nil {
		t.Fatal(err)
	}
	<-task.Done()
	if exit == nil || exit.Outcome.Kind != protocol.OutcomeCode || exit.Outcome.Code != 0 {
		t.Fatalf("exit = %+v", exit)
	}
	if exit.Result != nil {
		t.Fatalf("a push reported a result: %+v", exit.Result)
	}
	got, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if string(got) != string(data) {
		t.Fatalf("content = %q, want %q", got, data)
	}
}
