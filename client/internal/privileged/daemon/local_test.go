package daemon

import (
	"errors"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/Kodecable/ClusterRightHand/client/internal/privileged/authz"
	"github.com/Kodecable/ClusterRightHand/client/internal/privileged/localclient"
	"github.com/Kodecable/ClusterRightHand/client/internal/privileged/wire"
	"github.com/Kodecable/ClusterRightHand/client/internal/protocol"
)

// localEnv is a daemon with a crhs entry and one local entry for this process's uid. The
// crhs entry denies every exec task, so a crhs authorization for one is only accepted while
// the local approval window is open.
func localEnv(t *testing.T, keys *testKeys) *testEnv {
	t.Helper()
	uid := uint32(os.Getuid())
	return newTestEnv(t, keys, func(p envPaths) string {
		return baseConfig(p, os.Getuid()) +
			sshTrust("crhs", "crhs", keys.crhsLine, `["execute"]`, "deny = [{ method = \"exec\" }]\n") +
			localTrust("local-admins", []uint32{uid}, "")
	})
}

// dialLocal connects to the daemon in the local role.
func dialLocal(t *testing.T, socket string) *localclient.Client {
	t.Helper()
	client, err := localclient.Dial(requestContext(t), socket, "test")
	if err != nil {
		t.Fatalf("local dial: %v", err)
	}
	t.Cleanup(func() { _ = client.Close() })
	return client
}

func TestWindowOpenStatusClose(t *testing.T) {
	keys := newTestKeys(t)
	env := localEnv(t, keys)
	forward := dialForward(t, env.paths.Socket)
	local := dialLocal(t, env.paths.Socket)
	ctx := requestContext(t)

	// A closed window is reported as closed.
	state, err := local.Window(ctx)
	if err != nil || state.Kind != protocol.WindowStateClosed {
		t.Fatalf("initial window = %+v, %v", state, err)
	}

	state, err = local.Open(ctx, 30*time.Minute)
	if err != nil {
		t.Fatalf("window.open: %v", err)
	}
	if state.Kind != protocol.WindowStateOpen || state.Opened == nil {
		t.Fatalf("opened window = %+v", state)
	}
	if uint64(state.Opened.OpenedByUID) != uint64(os.Getuid()) {
		t.Fatalf("opened_by = %d, want %d", state.Opened.OpenedByUID, os.Getuid())
	}
	if got := time.Until(time.UnixMilli(int64(state.Opened.UntilMS))); got < 29*time.Minute || got > 31*time.Minute {
		t.Fatalf("window length = %v, want about 30m", got)
	}

	// The open window is pushed to forward connections and appears in the trust summary.
	report := forward.waitSummary(10 * time.Second)
	if report.Kind != protocol.TrustReportOK || report.Summary == nil {
		t.Fatalf("trust.summary = %+v", report)
	}
	if report.Summary.LocalWindow.Kind != protocol.WindowStateOpen ||
		report.Summary.LocalWindow.Opened == nil ||
		report.Summary.LocalWindow.Opened.UntilMS != state.Opened.UntilMS {
		t.Fatalf("summary window = %+v", report.Summary.LocalWindow)
	}
	// The explicit query reports the same window.
	var queried protocol.TrustSummary
	if err := forward.peer.Request(ctx, wire.CmdTrustQuery, protocol.Empty{}, &queried); err != nil {
		t.Fatalf("trust.query: %v", err)
	}
	if queried.LocalWindow.Kind != protocol.WindowStateOpen || queried.LocalWindow.Opened == nil ||
		queried.LocalWindow.Opened.UntilMS != state.Opened.UntilMS {
		t.Fatalf("trust.query window = %+v", queried.LocalWindow)
	}

	// A fresh local connection sees the same state.
	other := dialLocal(t, env.paths.Socket)
	if got, err := other.Window(ctx); err != nil || got.Kind != protocol.WindowStateOpen {
		t.Fatalf("window.status = %+v, %v", got, err)
	}

	state, err = local.CloseWindow(ctx)
	if err != nil || state.Kind != protocol.WindowStateClosed {
		t.Fatalf("window.close = %+v, %v", state, err)
	}
	report = forward.waitSummary(10 * time.Second)
	if report.Summary == nil || report.Summary.LocalWindow.Kind != protocol.WindowStateClosed {
		t.Fatalf("summary after close = %+v", report.Summary)
	}

	events := logEvents(t, env.paths.Log)
	if !hasEvent(events, "window.opened") || !hasEvent(events, "window.closed") {
		t.Fatalf("window events = %v", events)
	}
}

func TestWindowMaxWindowLimit(t *testing.T) {
	keys := newTestKeys(t)
	uid := uint32(os.Getuid())
	env := newTestEnv(t, keys, func(p envPaths) string {
		return baseConfig(p, os.Getuid()) +
			sshTrust("crhs", "crhs", keys.crhsLine, `["execute"]`, "") +
			localTrust("local-admins", []uint32{uid}, "max_window = \"10m\"\n")
	})
	local := dialLocal(t, env.paths.Socket)
	ctx := requestContext(t)

	_, err := local.Open(ctx, 30*time.Minute)
	var remote *protocol.RemoteError
	if !errors.As(err, &remote) || remote.Code != protocol.CodeInvalidSpec {
		t.Fatalf("window longer than max_window = %v, want invalid_spec", err)
	}
	if !strings.Contains(remote.Message, "10m0s") {
		t.Fatalf("refusal %q does not name the limit", remote.Message)
	}
	if state, err := local.Open(ctx, 10*time.Minute); err != nil || state.Kind != protocol.WindowStateOpen {
		t.Fatalf("window at the limit = %+v, %v", state, err)
	}
}

func TestWindowDefaultMaxWindow(t *testing.T) {
	keys := newTestKeys(t)
	env := localEnv(t, keys)
	local := dialLocal(t, env.paths.Socket)
	ctx := requestContext(t)

	if _, err := local.Open(ctx, 59*time.Minute); err != nil {
		t.Fatalf("window under the default limit: %v", err)
	}
	_, err := local.Open(ctx, 61*time.Minute)
	var remote *protocol.RemoteError
	if !errors.As(err, &remote) || !strings.Contains(remote.Message, "1h0m0s") {
		t.Fatalf("window over the default limit = %v, want a 1h limit message", err)
	}
}

func TestWindowReplacesCurrentWindow(t *testing.T) {
	keys := newTestKeys(t)
	env := localEnv(t, keys)
	local := dialLocal(t, env.paths.Socket)
	ctx := requestContext(t)

	first, err := local.Open(ctx, 5*time.Minute)
	if err != nil {
		t.Fatalf("first open: %v", err)
	}
	second, err := local.Open(ctx, 10*time.Minute)
	if err != nil {
		t.Fatalf("second open: %v", err)
	}
	if second.Opened == nil || second.Opened.UntilMS <= first.Opened.UntilMS {
		t.Fatalf("extended window = %+v, first = %+v", second, first)
	}
	// Opening again replaces the window, so a shorter length shortens it.
	third, err := local.Open(ctx, time.Minute)
	if err != nil {
		t.Fatalf("third open: %v", err)
	}
	if third.Opened == nil || third.Opened.UntilMS >= second.Opened.UntilMS {
		t.Fatalf("replaced window = %+v, second = %+v", third, second)
	}
}

func TestWindowExpires(t *testing.T) {
	keys := newTestKeys(t)
	env := localEnv(t, keys)
	forward := dialForward(t, env.paths.Socket)
	local := dialLocal(t, env.paths.Socket)
	ctx := requestContext(t)

	if _, err := local.Open(ctx, 200*time.Millisecond); err != nil {
		t.Fatalf("window.open: %v", err)
	}
	if report := forward.waitSummary(10 * time.Second); report.Summary == nil ||
		report.Summary.LocalWindow.Kind != protocol.WindowStateOpen {
		t.Fatalf("open summary = %+v", report.Summary)
	}
	// The timer closes the window and pushes the closed summary.
	report := forward.waitSummary(10 * time.Second)
	if report.Summary == nil || report.Summary.LocalWindow.Kind != protocol.WindowStateClosed {
		t.Fatalf("expiry summary = %+v", report.Summary)
	}
	if state, err := local.Window(ctx); err != nil || state.Kind != protocol.WindowStateClosed {
		t.Fatalf("window after expiry = %+v, %v", state, err)
	}
	if !hasEvent(logEvents(t, env.paths.Log), "window.expired") {
		t.Fatal("no window.expired log record")
	}
}

func TestWindowRequiresCRHSEntry(t *testing.T) {
	keys := newTestKeys(t)
	uid := uint32(os.Getuid())
	env := newTestEnv(t, keys, func(p envPaths) string {
		return baseConfig(p, os.Getuid()) + localTrust("local-admins", []uint32{uid}, "")
	})
	local := dialLocal(t, env.paths.Socket)
	_, err := local.Open(requestContext(t), time.Minute)
	var remote *protocol.RemoteError
	if !errors.As(err, &remote) || remote.Code != protocol.CodeLocalNotTrusted {
		t.Fatalf("window without a crhs entry = %v, want local_not_trusted", err)
	}
	if !strings.Contains(remote.Message, "no crhs trust entry") {
		t.Fatalf("refusal %q does not explain the missing crhs entry", remote.Message)
	}
}

func TestWindowRefusedForUntrustedUID(t *testing.T) {
	keys := newTestKeys(t)
	// The unprivileged uid is not a local approver, so its local-role handshake is refused.
	env := newTestEnv(t, keys, func(p envPaths) string {
		return baseConfig(p, os.Getuid()) +
			sshTrust("crhs", "crhs", keys.crhsLine, `["execute"]`, "") +
			localTrust("local-admins", []uint32{uint32(os.Getuid()) + 1}, "")
	})
	if _, err := localclient.Dial(requestContext(t), env.paths.Socket, "test"); err == nil {
		t.Fatal("local-role handshake accepted an untrusted uid")
	}
}

func TestTaskThroughWindow(t *testing.T) {
	keys := newTestKeys(t)
	env := localEnv(t, keys)
	forward := dialForward(t, env.paths.Socket)
	local := dialLocal(t, env.paths.Socket)
	ctx := requestContext(t)

	ts := execTask("window-1", 1, "/bin/echo", "via-window")
	payload := payloadFor(ts.TaskID, 1, exactCommand(t, &ts.Spec), nil)
	ts.Authorizations = [][]byte{authorize(t, payload, keys.crhs)}

	// With the window closed, the crhs entry's deny rule refuses the task.
	err := forward.start(ctx, ts)
	var remote *protocol.RemoteError
	if !errors.As(err, &remote) || remote.Code != string(authz.ResultRejected) || !strings.Contains(remote.Message, "step 7") {
		t.Fatalf("task.start with a closed window = %v, want a step 7 rejection", err)
	}

	if _, err := local.Open(ctx, 5*time.Minute); err != nil {
		t.Fatalf("window.open: %v", err)
	}
	if err := forward.start(ctx, ts); err != nil {
		t.Fatalf("task.start through the window: %v", err)
	}
	exit := forward.waitExit(15 * time.Second)
	if exit.Outcome.Kind != protocol.OutcomeCode || exit.Outcome.Code != 0 {
		t.Fatalf("task.exit = %+v", exit)
	}
	if got := forward.output(); got != "via-window\n" {
		t.Fatalf("stdout = %q", got)
	}

	// The acceptance is marked with the window it ran under.
	found := false
	for _, record := range logRecords(t, env.paths.Log) {
		if record["event"] != "task.accepted" || record["task_id"] != ts.TaskID {
			continue
		}
		detail, _ := record["detail"].(string)
		if !strings.Contains(detail, "via local window opened by uid") {
			t.Fatalf("task.accepted detail = %q", detail)
		}
		found = true
	}
	if !found {
		t.Fatal("no task.accepted record for the window task")
	}
}

func TestWindowDoesNotBypassCommandLimit(t *testing.T) {
	keys := newTestKeys(t)
	env := localEnv(t, keys)
	forward := dialForward(t, env.paths.Socket)
	local := dialLocal(t, env.paths.Socket)
	ctx := requestContext(t)

	if _, err := local.Open(ctx, 5*time.Minute); err != nil {
		t.Fatalf("window.open: %v", err)
	}
	ts := execTask("window-2", 1, "/bin/echo", "other")
	// The payload pins another command, so its exact command limit still refuses this task.
	other := execTask("window-2", 1, "/bin/echo", "signed")
	payload := payloadFor(ts.TaskID, 1, exactCommand(t, &other.Spec), nil)
	ts.Authorizations = [][]byte{authorize(t, payload, keys.crhs)}
	err := forward.start(ctx, ts)
	var remote *protocol.RemoteError
	if !errors.As(err, &remote) || remote.Code != string(authz.ResultRejected) || !strings.Contains(remote.Message, "step 6") {
		t.Fatalf("task.start with a mismatched exact command = %v, want a step 6 rejection", err)
	}
}

// logEvents lists the event field of every local log record.
func logEvents(t *testing.T, path string) []string {
	t.Helper()
	records := logRecords(t, path)
	events := make([]string, 0, len(records))
	for _, record := range records {
		if event, ok := record["event"].(string); ok {
			events = append(events, event)
		}
	}
	return events
}

func hasEvent(events []string, want string) bool {
	for _, event := range events {
		if event == want {
			return true
		}
	}
	return false
}
