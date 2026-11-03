package agent

import (
	"bytes"
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"crypto/sha256"
	"crypto/sha512"
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net"
	"os"
	"path/filepath"
	"strings"
	"syscall"
	"testing"
	"time"

	"github.com/fxamacker/cbor/v2"
	"golang.org/x/crypto/ssh"

	"github.com/Kodecable/ClusterRightHand/client/internal/config"
	"github.com/Kodecable/ClusterRightHand/client/internal/noise"
	"github.com/Kodecable/ClusterRightHand/client/internal/privileged/audit"
	"github.com/Kodecable/ClusterRightHand/client/internal/privileged/authz"
	privconfig "github.com/Kodecable/ClusterRightHand/client/internal/privileged/config"
	"github.com/Kodecable/ClusterRightHand/client/internal/privileged/daemon"
	"github.com/Kodecable/ClusterRightHand/client/internal/privileged/localclient"
	"github.com/Kodecable/ClusterRightHand/client/internal/privileged/wire"
	"github.com/Kodecable/ClusterRightHand/client/internal/protocol"
	"github.com/Kodecable/ClusterRightHand/client/internal/version"
)

// errTimeout reports a missing event or reply; the fake crhs returns it instead of failing the
// test from its own goroutine.
var errTimeout = errors.New("timed out")

// ------------------------------- privileged daemon -------------------------------

// privKeys are the signing keys the test daemon trusts.
type privKeys struct {
	crhs     ssh.Signer
	crhsLine string
	user     ssh.Signer
	userLine string
}

func newPrivKeys(t *testing.T) *privKeys {
	t.Helper()
	crhs, user := newSigner(t), newSigner(t)
	return &privKeys{crhs: crhs, crhsLine: authorizedLine(crhs), user: user, userLine: authorizedLine(user)}
}

func newSigner(t *testing.T) ssh.Signer {
	t.Helper()
	_, private, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	signer, err := ssh.NewSignerFromKey(private)
	if err != nil {
		t.Fatal(err)
	}
	return signer
}

func authorizedLine(signer ssh.Signer) string {
	return string(bytes.TrimSpace(ssh.MarshalAuthorizedKey(signer.PublicKey())))
}

// privEnv is a privileged-mode daemon on a temporary socket, as the daemon's own tests start it.
type privEnv struct {
	t        *testing.T
	dir      string
	config   string
	socket   string
	stateDir string
	logPath  string
	keys     *privKeys
	// daemonVersion overrides the version the daemon reports in PrivWelcome; empty means this
	// build's version, like a daemon started from the same binary as the non-privileged mode.
	daemonVersion string

	cancel context.CancelFunc
	done   chan error
	log    *audit.Logger
}

// newPrivEnv writes the configuration built by build (which receives the env for its paths). The
// daemon only runs after start.
func newPrivEnv(t *testing.T, keys *privKeys, build func(*privEnv) string) *privEnv {
	t.Helper()
	dir := t.TempDir()
	env := &privEnv{
		t:        t,
		dir:      dir,
		config:   filepath.Join(dir, "privileged.toml"),
		socket:   filepath.Join(dir, "priv.sock"),
		stateDir: filepath.Join(dir, "state"),
		logPath:  filepath.Join(dir, "privileged.jsonl"),
		keys:     keys,
	}
	t.Cleanup(env.stop)
	env.writeConfig(build)
	return env
}

func (e *privEnv) writeConfig(build func(*privEnv) string) {
	e.t.Helper()
	if err := os.WriteFile(e.config, []byte(build(e)), 0o600); err != nil {
		e.t.Fatal(err)
	}
}

// start loads the configuration and runs the daemon until stop.
func (e *privEnv) start() {
	e.t.Helper()
	cfg, err := privconfig.Load(e.config)
	if err != nil {
		e.t.Fatalf("load privileged config: %v", err)
	}
	log, err := audit.Open(e.logPath, audit.Options{Mirror: io.Discard})
	if err != nil {
		e.t.Fatalf("open privileged log: %v", err)
	}
	reportVersion := e.daemonVersion
	if reportVersion == "" {
		reportVersion = version.Version
	}
	server, err := daemon.New(cfg, daemon.Options{ConfigPath: e.config, Version: reportVersion, Log: log})
	if err != nil {
		log.Close()
		e.t.Fatalf("daemon.New: %v", err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() { done <- server.Run(ctx) }()
	e.cancel, e.done, e.log = cancel, done, log
	e.waitSocket()
}

// stop shuts the daemon down. It is idempotent so a test may kill the daemon itself.
func (e *privEnv) stop() {
	if e.cancel == nil {
		return
	}
	e.cancel()
	select {
	case err := <-e.done:
		if err != nil {
			e.t.Errorf("daemon.Run: %v", err)
		}
	case <-time.After(60 * time.Second):
		e.t.Error("the daemon did not stop")
	}
	if err := e.log.Close(); err != nil {
		e.t.Errorf("close privileged log: %v", err)
	}
	e.cancel, e.done, e.log = nil, nil, nil
}

// waitSocket waits for the daemon's socket to appear.
func (e *privEnv) waitSocket() {
	e.t.Helper()
	deadline := time.Now().Add(10 * time.Second)
	for time.Now().Before(deadline) {
		if fi, err := os.Lstat(e.socket); err == nil && fi.Mode()&os.ModeSocket != 0 {
			return
		}
		time.Sleep(5 * time.Millisecond)
	}
	e.t.Fatalf("socket %s did not appear", e.socket)
}

// baseConfig is the shared top of the test daemon's privileged.toml.
func (e *privEnv) baseConfig() string {
	return fmt.Sprintf(`node_id          = "node-1"
groups           = ["web"]
unprivileged_uid = %d
clock_skew       = "60s"
socket           = %q
state_dir        = %q
log              = %q
`, os.Getuid(), e.socket, e.stateDir, e.logPath)
}

// sshTrust renders one sshsig trust entry.
func sshTrust(name, role, line, kinds string) string {
	return fmt.Sprintf(`
[[trust]]
name   = %q
role   = %q
format = "sshsig"
key    = %q
kinds  = %s
`, name, role, line, kinds)
}

// localTrust renders one local trust entry.
func localTrust(name string, uids []uint32) string {
	return fmt.Sprintf(`
[[trust]]
name  = %q
role  = "local"
uids  = %v
kinds = ["execute"]
`, name, uids)
}

// crhsOnlyConfig trusts only the crhs signing key with execute and cosign.
func (e *privEnv) crhsOnlyConfig() string {
	return e.baseConfig() + sshTrust("crhs", "crhs", e.keys.crhsLine, `["execute", "cosign"]`)
}

// ------------------------------- authorizations -------------------------------

// exactPayload builds a one-shot payload for the complete spec of a task.
func exactPayload(t *testing.T, signer ssh.Signer, taskID string, spec *protocol.TaskSpec) *protocol.AuthorizationPayload {
	t.Helper()
	method, target, err := authz.Target(spec)
	if err != nil {
		t.Fatalf("target: %v", err)
	}
	hash, err := protocol.SpecSHA256(spec)
	if err != nil {
		t.Fatal(err)
	}
	ids := []string{taskID}
	attempt := protocol.Uint(1)
	deadline := protocol.Int(time.Now().Add(5 * time.Minute).UnixMilli())
	return &protocol.AuthorizationPayload{
		V:     protocol.AuthPayloadVersion,
		Nodes: []string{"node-1"},
		Command: &protocol.AuthCommand{Method: protocol.Method(method), Match: protocol.AuthMatch{
			Kind:  protocol.AuthMatchExact,
			Exact: &protocol.AuthExact{Target: target, SpecSHA256: protocol.Hash(hash)},
		}},
		IssuedAtMS: protocol.Int(time.Now().Add(-time.Minute).UnixMilli()),
		DeadlineMS: &deadline,
		TaskIDs:    &ids,
		Attempt:    &attempt,
	}
}

// authorize renders CBOR(Authorization) with one SSHSIG signature by signer.
func authorize(t *testing.T, signer ssh.Signer, payload *protocol.AuthorizationPayload) []byte {
	t.Helper()
	raw, err := protocol.Marshal(payload)
	if err != nil {
		t.Fatal(err)
	}
	authorization, err := protocol.Marshal(&protocol.Authorization{
		Payload: raw,
		Signatures: []protocol.Signature{{
			Kind:   protocol.SignatureSSHSig,
			SSHSig: &protocol.SSHSigSignature{Blob: signSSHSIG(t, signer, raw)},
		}},
	})
	if err != nil {
		t.Fatal(err)
	}
	return authorization
}

// signSSHSIG produces an SSHSIG blob over message, as `ssh-keygen -Y sign -n crh-auth-v1` would.
func signSSHSIG(t *testing.T, signer ssh.Signer, message []byte) []byte {
	t.Helper()
	hash := sha512.Sum512(message)
	var signed bytes.Buffer
	signed.WriteString("SSHSIG")
	writeSSHString(&signed, []byte(protocol.AuthNamespace))
	writeSSHString(&signed, nil)
	writeSSHString(&signed, []byte("sha512"))
	writeSSHString(&signed, hash[:])

	signature, err := signer.Sign(rand.Reader, signed.Bytes())
	if err != nil {
		t.Fatal(err)
	}
	inner := ssh.Marshal(signature)

	var blob bytes.Buffer
	blob.WriteString("SSHSIG")
	_ = binary.Write(&blob, binary.BigEndian, uint32(1))
	writeSSHString(&blob, signer.PublicKey().Marshal())
	writeSSHString(&blob, []byte(protocol.AuthNamespace))
	writeSSHString(&blob, nil)
	writeSSHString(&blob, []byte("sha512"))
	writeSSHString(&blob, inner)
	return blob.Bytes()
}

func writeSSHString(buf *bytes.Buffer, data []byte) {
	_ = binary.Write(buf, binary.BigEndian, uint32(len(data)))
	buf.Write(data)
}

// ------------------------------- fake crhs -------------------------------

// crhsWatch is the fake crhs side of a forward-mode connection.
type crhsWatch struct {
	frames    *frameLog
	outputs   chan protocol.TaskOutput
	exits     chan protocol.TaskExit
	summaries chan protocol.TrustReport
	decisions chan protocol.LocalDecision
}

func newCRHSWatch() *crhsWatch {
	return &crhsWatch{
		frames:    &frameLog{},
		outputs:   make(chan protocol.TaskOutput, 512),
		exits:     make(chan protocol.TaskExit, 16),
		summaries: make(chan protocol.TrustReport, 16),
		decisions: make(chan protocol.LocalDecision, 16),
	}
}

// setup registers the fake crhs's event handlers over registerCore's.
func (w *crhsWatch) setup(p *protocol.Peer) {
	p.HandleEvent(protocol.EventTaskOutput, func(body cbor.RawMessage) error {
		var out protocol.TaskOutput
		if err := protocol.Unmarshal(body, &out); err != nil {
			return err
		}
		w.outputs <- out
		return nil
	})
	p.HandleEvent(protocol.EventTaskExit, func(body cbor.RawMessage) error {
		var exit protocol.TaskExit
		if err := protocol.Unmarshal(body, &exit); err != nil {
			return err
		}
		w.exits <- exit
		return nil
	})
	p.HandleEvent(protocol.EventTrustSummary, func(body cbor.RawMessage) error {
		var report protocol.TrustReport
		if err := protocol.Unmarshal(body, &report); err != nil {
			return err
		}
		w.summaries <- report
		return nil
	})
	p.HandleEvent(protocol.EventLocalDecision, func(body cbor.RawMessage) error {
		var decision protocol.LocalDecision
		if err := protocol.Unmarshal(body, &decision); err != nil {
			return err
		}
		w.decisions <- decision
		return nil
	})
}

// serveForward runs one fake crhs session whose script starts after the facts event. script may be
// nil when the test only observes events.
func serveForward(t *testing.T, a *Agent, w *crhsWatch, script func(context.Context, *protocol.Peer) error) {
	t.Helper()
	serverKey, err := noise.GenerateKeypair()
	if err != nil {
		t.Fatal(err)
	}
	factsReady := make(chan struct{})
	srv := startFake(t, serverKey, fakeConfig{
		log: w.frames,
		setup: func(p *protocol.Peer) {
			p.HandleEvent(protocol.EventFacts, func(body cbor.RawMessage) error {
				var facts protocol.Facts
				if err := protocol.Unmarshal(body, &facts); err != nil {
					return err
				}
				signal(factsReady)
				return nil
			})
			w.setup(p)
		},
		run: func(ctx context.Context, p *protocol.Peer) {
			<-factsReady
			if script == nil {
				return
			}
			if err := script(ctx, p); err != nil {
				t.Errorf("fake crhs: %v", err)
			}
		},
	})
	startSession(t, a, dialTo(t, srv, serverKey))
}

// forwardAgent is an agent in forward mode whose daemon connection runs for the test.
func forwardAgent(t *testing.T, opts Options) *Agent {
	t.Helper()
	if opts.PrivilegedMode == "" {
		opts.PrivilegedMode = config.ModeForward
	}
	a := newTestAgent(t, opts)
	ctx, cancel := context.WithCancel(context.Background())
	t.Cleanup(cancel)
	a.startForward(ctx)
	return a
}

// waitForward waits until the agent holds a connection to the privileged mode.
func waitForward(t *testing.T, a *Agent) {
	t.Helper()
	deadline := time.Now().Add(10 * time.Second)
	for time.Now().Before(deadline) {
		if fc, _ := a.forwardConnection(); fc != nil {
			return
		}
		time.Sleep(5 * time.Millisecond)
	}
	t.Fatal("the agent did not connect to the privileged mode")
}

// waitSummaryWhere waits for a trust.summary event that matches. Reports that do not match (for
// example the initial "not connected yet" one) are skipped.
func waitSummaryWhere(t *testing.T, w *crhsWatch, what string, match func(protocol.TrustReport) bool) protocol.TrustReport {
	t.Helper()
	deadline := time.After(10 * time.Second)
	for {
		select {
		case report := <-w.summaries:
			if match(report) {
				return report
			}
		case <-deadline:
			t.Fatalf("timed out waiting for %s", what)
			return protocol.TrustReport{}
		}
	}
}

// waitExit collects the task's output until its task.exit arrives.
func waitExit(t *testing.T, w *crhsWatch) (stdout, stderr string, exit protocol.TaskExit) {
	t.Helper()
	deadline := time.After(20 * time.Second)
	for {
		select {
		case out := <-w.outputs:
			if out.Stream == protocol.StreamStdout {
				stdout += string(out.Data)
			} else {
				stderr += string(out.Data)
			}
		case exit = <-w.exits:
			// task.exit follows the whole output of the task.
			for {
				select {
				case out := <-w.outputs:
					if out.Stream == protocol.StreamStdout {
						stdout += string(out.Data)
					} else {
						stderr += string(out.Data)
					}
				default:
					return stdout, stderr, exit
				}
			}
		case <-deadline:
			t.Fatal("timed out waiting for task.exit")
			return "", "", protocol.TaskExit{}
		}
	}
}

// requestStart sends ts and returns the response error.
func requestStart(ctx context.Context, p *protocol.Peer, ts protocol.TaskStart) error {
	var empty protocol.Empty
	return p.Request(ctx, protocol.CmdTaskStart, ts, &empty)
}

// forwardedExecTask is a privileged argv exec task.
func forwardedExecTask(id string, argv ...string) protocol.TaskStart {
	return protocol.TaskStart{
		TaskID:     id,
		Attempt:    1,
		Privileged: true,
		Spec: protocol.TaskSpec{Kind: protocol.TaskSpecExec, Exec: &protocol.ExecSpec{
			Command: protocol.Command{Kind: protocol.CommandArgv, Argv: argv},
		}},
		Output: protocol.OutputMode{Kind: protocol.OutputFull, SpillBytes: 1 << 20, SpillLines: 2000},
	}
}

// expectRemoteCode reports whether err is a remote error with the code.
func expectRemoteCode(t *testing.T, err error, code string) *protocol.RemoteError {
	t.Helper()
	var remote *protocol.RemoteError
	if !errors.As(err, &remote) {
		t.Fatalf("got %v, want a remote error with code %s", err, code)
	}
	if remote.Code != code {
		t.Fatalf("error code %q, want %q (%s)", remote.Code, code, remote.Message)
	}
	return remote
}

// ------------------------------- tests -------------------------------

// TestTrustSummaryNotForward covers the report of every mode that does not forward: crha advertises
// M4 and answers its commands with privileged_unsupported.
func TestTrustSummaryNotForward(t *testing.T) {
	for _, mode := range []string{config.ModeNative, config.ModeIgnore, config.ModeReject} {
		t.Run(mode, func(t *testing.T) {
			w := newCRHSWatch()
			a := newTestAgent(t, Options{PrivilegedMode: mode})
			replies := make(chan error, 2)
			serveForward(t, a, w, func(ctx context.Context, p *protocol.Peer) error {
				var empty protocol.Empty
				var state protocol.LocalState
				replies <- p.Request(ctx, protocol.CmdLocalRequest, protocol.LocalRequest{
					TaskID: "t1", Attempt: 1, Spec: forwardedExecTask("t1", "/bin/true").Spec,
				}, &state)
				replies <- p.Request(ctx, protocol.CmdLocalWithdraw, protocol.LocalWithdraw{TaskID: "t1", Attempt: 1}, &empty)
				return nil
			})

			report := waitCh(t, w.summaries, "trust.summary")
			if report.Kind != protocol.TrustReportNotForward {
				t.Fatalf("trust.summary = %+v, want not_forward", report)
			}
			for range 2 {
				remote := expectRemoteCode(t, waitCh(t, replies, "reply"), "privileged_unsupported")
				if want := "privileged mode is " + mode + ", not forward"; remote.Message != want {
					t.Fatalf("message = %q, want %q", remote.Message, want)
				}
			}
		})
	}
}

// TestForwardTrustReports covers the unavailable report while the daemon is down and the ok report
// once it starts: the report change is pushed to crhs without another hello.
func TestForwardTrustReports(t *testing.T) {
	keys := newPrivKeys(t)
	env := newPrivEnv(t, keys, func(e *privEnv) string { return e.crhsOnlyConfig() })
	w := newCRHSWatch()
	a := forwardAgent(t, Options{PrivilegedSocket: env.socket})
	serveForward(t, a, w, nil)

	report := waitSummaryWhere(t, w, "the unavailable report", func(r protocol.TrustReport) bool {
		return r.Kind == protocol.TrustReportUnavailable
	})
	if !strings.Contains(report.Message, "priv.sock") {
		t.Fatalf("unavailable message %q does not name the socket", report.Message)
	}

	env.start()
	report = waitSummaryWhere(t, w, "the ok report", func(r protocol.TrustReport) bool {
		return r.Kind == protocol.TrustReportOK && r.Summary != nil
	})
	if report.Summary.NodeID != "node-1" || len(report.Summary.Trust) != 1 {
		t.Fatalf("summary = %+v", report.Summary)
	}
	if report.Summary.Trust[0].Role != protocol.TrustRoleCRHS {
		t.Fatalf("trust entry = %+v", report.Summary.Trust[0])
	}
}

// TestForwardDaemonVersionMismatch covers a crha binary upgraded without restarting its privileged
// mode: the daemon runs the old binary and reports its crha_version in PrivWelcome. The forward
// connection is refused like an unreachable daemon (doc/protocol.md, crh-priv): privileged tasks
// fail with privileged_unavailable, and the warning names both versions.
func TestForwardDaemonVersionMismatch(t *testing.T) {
	keys := newPrivKeys(t)
	env := newPrivEnv(t, keys, func(e *privEnv) string { return e.crhsOnlyConfig() })
	env.daemonVersion = "0.1.0-old"
	env.start()

	handler := &recordHandler{}
	a := forwardAgent(t, Options{PrivilegedSocket: env.socket, Logger: slog.New(handler)})

	w := newCRHSWatch()
	replies := make(chan error, 1)
	serveForward(t, a, w, func(ctx context.Context, p *protocol.Peer) error {
		replies <- requestStart(ctx, p, privilegedTask("old-daemon", "true"))
		return nil
	})

	remote := expectRemoteCode(t, waitCh(t, replies, "the privileged task.start"), "privileged_unavailable")
	if !strings.Contains(remote.Message, "not reachable") {
		t.Fatalf("message = %q, want the unreachable-daemon refusal", remote.Message)
	}
	// The mismatch is reported like an unreachable daemon: the unavailable report carries the
	// refused handshake and a warning names both versions.
	report := waitSummaryWhere(t, w, "the unavailable report", func(r protocol.TrustReport) bool {
		return r.Kind == protocol.TrustReportUnavailable && strings.Contains(r.Message, env.daemonVersion)
	})
	if !strings.Contains(report.Message, version.Version) {
		t.Fatalf("unavailable message %q does not name both versions", report.Message)
	}
	logDeadline := time.Now().Add(10 * time.Second)
	for {
		var text strings.Builder
		warned := false
		for _, record := range handler.all() {
			if record.Level != slog.LevelWarn || !strings.Contains(record.Message, "not reachable") {
				continue
			}
			warned = true
			text.WriteString(record.Message)
			record.Attrs(func(attr slog.Attr) bool {
				text.WriteString(" " + attr.Value.String())
				return true
			})
		}
		if warned && strings.Contains(text.String(), env.daemonVersion) && strings.Contains(text.String(), version.Version) {
			break
		}
		if time.Now().After(logDeadline) {
			t.Fatalf("no warning naming %q and %q; records = %+v", env.daemonVersion, version.Version, handler.all())
		}
		time.Sleep(10 * time.Millisecond)
	}
}

// TestForwardExactExec runs a crhs-signed exact exec task through the privileged mode: the accepted
// response precedes the output, and the output and the outcome reach crhs.
func TestForwardExactExec(t *testing.T) {
	keys := newPrivKeys(t)
	env := newPrivEnv(t, keys, func(e *privEnv) string { return e.crhsOnlyConfig() })
	env.start()
	a := forwardAgent(t, Options{PrivilegedSocket: env.socket})
	waitForward(t, a)

	w := newCRHSWatch()
	replies := make(chan error, 1)
	serveForward(t, a, w, func(ctx context.Context, p *protocol.Peer) error {
		ts := forwardedExecTask("fwd-exec", "/bin/sh", "-c", "printf out; printf oops >&2; exit 3")
		ts.Authorizations = [][]byte{authorize(t, keys.crhs, exactPayload(t, keys.crhs, ts.TaskID, &ts.Spec))}
		replies <- requestStart(ctx, p, ts)
		return nil
	})

	if report := waitCh(t, w.summaries, "the ok trust.summary"); report.Kind != protocol.TrustReportOK {
		t.Fatalf("trust.summary = %+v", report)
	}
	if err := waitCh(t, replies, "task.start response"); err != nil {
		t.Fatalf("task.start: %v", err)
	}
	stdout, stderr, exit := waitExit(t, w)
	if stdout != "out" || stderr != "oops" {
		t.Fatalf("stdout %q stderr %q", stdout, stderr)
	}
	if exit.Outcome.Kind != protocol.OutcomeCode || exit.Outcome.Code != 3 {
		t.Fatalf("task.exit = %+v", exit)
	}
	if exit.StdoutEnd != 3 || exit.StderrEnd != 4 {
		t.Fatalf("ends = %d/%d, want 3/4", exit.StdoutEnd, exit.StderrEnd)
	}
	frames := w.frames.snapshot()
	accepted := indexOf(frames, "response task.start ok=true")
	output := indexOf(frames, "event task.output")
	if accepted < 0 || output < 0 || accepted > output {
		t.Fatalf("task.output did not follow the accepted response: %v", frames)
	}
}

// TestForwardFileWrite writes a file through the privileged mode, so both the task spec and the
// input relaying work.
func TestForwardFileWrite(t *testing.T) {
	keys := newPrivKeys(t)
	env := newPrivEnv(t, keys, func(e *privEnv) string { return e.crhsOnlyConfig() })
	env.start()
	a := forwardAgent(t, Options{PrivilegedSocket: env.socket})
	waitForward(t, a)

	dir, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(dir, "written.txt")
	content := []byte("written through the privileged mode\n")
	sum := sha256.Sum256(content)
	ts := protocol.TaskStart{
		TaskID: "fwd-write", Attempt: 1, Privileged: true,
		Spec: protocol.TaskSpec{Kind: protocol.TaskSpecFileWrite, FileWrite: &protocol.FileWriteSpec{
			Path:    path,
			Content: protocol.InputRef{Size: protocol.Uint(len(content)), SHA256: protocol.Hash(sum)},
		}},
		Output: protocol.OutputMode{Kind: protocol.OutputText},
	}
	ts.Authorizations = [][]byte{authorize(t, keys.crhs, exactPayload(t, keys.crhs, ts.TaskID, &ts.Spec))}

	w := newCRHSWatch()
	replies := make(chan error, 1)
	serveForward(t, a, w, func(ctx context.Context, p *protocol.Peer) error {
		if err := requestStart(ctx, p, ts); err != nil {
			replies <- err
			return nil
		}
		var empty protocol.Empty
		replies <- p.Request(ctx, protocol.CmdTaskInput, protocol.TaskInput{
			TaskID: ts.TaskID, Offset: 0, Data: content,
		}, &empty)
		return nil
	})

	if err := waitCh(t, replies, "task.input response"); err != nil {
		t.Fatalf("task.input: %v", err)
	}
	_, _, exit := waitExit(t, w)
	if exit.Outcome.Kind != protocol.OutcomeCode || exit.Outcome.Code != 0 {
		t.Fatalf("task.exit = %+v", exit)
	}
	// The daemon's result reaches crhs through the relay unchanged (doc/protocol.md TaskResult).
	if exit.Result == nil || exit.Result.FileWrite == nil {
		t.Fatalf("task.exit result = %+v", exit.Result)
	}
	if got := exit.Result.FileWrite; got.Bytes != protocol.Uint(len(content)) || !got.Created {
		t.Fatalf("file.write result = %+v", got)
	}
	written, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(written, content) {
		t.Fatalf("file = %q, want %q", written, content)
	}
}

// TestForwardAuthorizationOnlyUserSigned covers a node that trusts only a user: crhs cannot
// escalate alone, and the owner's signature runs the task.
func TestForwardAuthorizationOnlyUserSigned(t *testing.T) {
	keys := newPrivKeys(t)
	env := newPrivEnv(t, keys, func(e *privEnv) string {
		return e.baseConfig() + sshTrust("alice", "user", e.keys.userLine, `["execute"]`)
	})
	env.start()
	a := forwardAgent(t, Options{PrivilegedSocket: env.socket})
	waitForward(t, a)

	w := newCRHSWatch()
	replies := make(chan error, 2)
	serveForward(t, a, w, func(ctx context.Context, p *protocol.Peer) error {
		// A crhs signature matches no trust entry: the authorization is invalid.
		denied := forwardedExecTask("fwd-denied", "/bin/true")
		denied.Authorizations = [][]byte{authorize(t, keys.crhs, exactPayload(t, keys.crhs, denied.TaskID, &denied.Spec))}
		replies <- requestStart(ctx, p, denied)

		// The owner's user key may execute.
		allowed := forwardedExecTask("fwd-allowed", "/bin/echo", "owner approved")
		allowed.Authorizations = [][]byte{authorize(t, keys.user, exactPayload(t, keys.user, allowed.TaskID, &allowed.Spec))}
		replies <- requestStart(ctx, p, allowed)
		return nil
	})

	remote := expectRemoteCode(t, waitCh(t, replies, "the crhs-signed task"), "authorization_invalid")
	if !strings.Contains(remote.Message, "step 3") {
		t.Fatalf("refusal = %q, want step 3", remote.Message)
	}
	if err := waitCh(t, replies, "the user-signed task"); err != nil {
		t.Fatalf("user-signed task.start: %v", err)
	}
	stdout, _, exit := waitExit(t, w)
	if stdout != "owner approved\n" || exit.Outcome.Code != 0 {
		t.Fatalf("stdout %q, exit %+v", stdout, exit)
	}
}

// TestForwardAuthorizationLacksExecute covers a crhs key that may only cosign: the signature is
// valid but the trust entry cannot authorize, so the refusal is authorization_rejected.
func TestForwardAuthorizationLacksExecute(t *testing.T) {
	keys := newPrivKeys(t)
	env := newPrivEnv(t, keys, func(e *privEnv) string {
		return e.baseConfig() + sshTrust("crhs", "crhs", e.keys.crhsLine, `["cosign"]`)
	})
	env.start()
	a := forwardAgent(t, Options{PrivilegedSocket: env.socket})
	waitForward(t, a)

	w := newCRHSWatch()
	replies := make(chan error, 1)
	serveForward(t, a, w, func(ctx context.Context, p *protocol.Peer) error {
		ts := forwardedExecTask("fwd-cosign", "/bin/true")
		ts.Authorizations = [][]byte{authorize(t, keys.crhs, exactPayload(t, keys.crhs, ts.TaskID, &ts.Spec))}
		replies <- requestStart(ctx, p, ts)
		return nil
	})
	expectRemoteCode(t, waitCh(t, replies, "task.start response"), "authorization_rejected")
}

// TestForwardRefreshBeforeRefusal covers the ordering rule of doc/protocol.md task.start: before an
// authorization_* refusal is relayed, a changed trust summary goes out first.
func TestForwardRefreshBeforeRefusal(t *testing.T) {
	keys := newPrivKeys(t)
	env := newPrivEnv(t, keys, func(e *privEnv) string { return e.crhsOnlyConfig() })
	env.start()
	a := forwardAgent(t, Options{PrivilegedSocket: env.socket})
	waitForward(t, a)

	w := newCRHSWatch()
	replies := make(chan error, 1)
	reloaded := make(chan struct{})
	serveForward(t, a, w, func(ctx context.Context, p *protocol.Peer) error {
		<-reloaded
		// No authorization: the daemon refuses with authorization_required, and the agent has to
		// report the new trust summary before that response.
		replies <- requestStart(ctx, p, forwardedExecTask("fwd-refresh", "/bin/true"))
		return nil
	})

	first := waitSummaryWhere(t, w, "the ok trust.summary", func(r protocol.TrustReport) bool {
		return r.Kind == protocol.TrustReportOK
	})
	before, err := protocol.TrustDigest(first.Summary)
	if err != nil {
		t.Fatal(err)
	}

	// A user trust entry changes the digest the daemon reports.
	env.writeConfig(func(e *privEnv) string {
		return e.crhsOnlyConfig() + sshTrust("alice", "user", e.keys.userLine, `["execute"]`)
	})
	if err := syscallKillHup(); err != nil {
		t.Fatal(err)
	}
	// Wait until the daemon swapped its configuration, so the refusal below uses the new trust.
	waitLogRecord(t, env.logPath, "config.reloaded", "")
	close(reloaded)

	expectRemoteCode(t, waitCh(t, replies, "task.start response"), "authorization_required")
	report := waitSummaryWhere(t, w, "the reloaded trust.summary", func(r protocol.TrustReport) bool {
		if r.Kind != protocol.TrustReportOK || r.Summary == nil || len(r.Summary.Trust) != 2 {
			return false
		}
		digest, err := protocol.TrustDigest(r.Summary)
		return err == nil && digest != before
	})
	if len(report.Summary.Trust) != 2 {
		t.Fatalf("reloaded trust = %+v", report.Summary.Trust)
	}
	frames := w.frames.snapshot()
	summary := indexOf(frames, "event trust.summary")
	refusal := indexOf(frames, "response task.start ok=false")
	if summary < 0 || refusal < 0 || summary > refusal {
		t.Fatalf("trust.summary did not precede the refusal: %v", frames)
	}
}

// TestForwardLocalApproval covers local.request through the daemon, the local.decision event to
// crhs and the task.start that the approval covers.
func TestForwardLocalApproval(t *testing.T) {
	keys := newPrivKeys(t)
	env := newPrivEnv(t, keys, func(e *privEnv) string {
		return e.baseConfig() + localTrust("local-admins", []uint32{uint32(os.Getuid())})
	})
	env.start()
	a := forwardAgent(t, Options{PrivilegedSocket: env.socket})
	waitForward(t, a)

	ts := forwardedExecTask("fwd-local", "/bin/echo", "approved locally")
	w := newCRHSWatch()
	requested := make(chan error, 1)
	replies := make(chan error, 1)
	serveForward(t, a, w, func(ctx context.Context, p *protocol.Peer) error {
		var state protocol.LocalState
		err := p.Request(ctx, protocol.CmdLocalRequest, protocol.LocalRequest{
			TaskID: ts.TaskID, Attempt: 1, Spec: ts.Spec, Note: "please run",
		}, &state)
		if err != nil {
			requested <- err
			return nil
		}
		if state.Kind != protocol.LocalStatePending {
			requested <- fmt.Errorf("local.request state = %+v, want pending", state)
			return nil
		}
		requested <- nil
		select {
		case decision := <-w.decisions:
			if decision.TaskID != ts.TaskID || decision.State.Kind != protocol.LocalStateApproved {
				return fmt.Errorf("local.decision = %+v", decision)
			}
		case <-time.After(10 * time.Second):
			return fmt.Errorf("local.decision: %w", errTimeout)
		}
		replies <- requestStart(ctx, p, ts)
		return nil
	})

	if err := waitCh(t, requested, "the local.request response"); err != nil {
		t.Fatalf("local.request: %v", err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	client, err := localclient.Dial(ctx, env.socket, version.Version)
	if err != nil {
		t.Fatalf("local client: %v", err)
	}
	defer client.Close()
	entries, err := client.Pending(ctx)
	if err != nil {
		t.Fatalf("pending.list: %v", err)
	}
	if len(entries) != 1 || entries[0].TaskID != ts.TaskID {
		t.Fatalf("pending.list = %+v", entries)
	}
	hash, err := protocol.SpecSHA256(&entries[0].Spec)
	if err != nil {
		t.Fatalf("spec hash: %v", err)
	}
	if err := client.Approve(ctx, ts.TaskID, 1, hash, ""); err != nil {
		t.Fatalf("local.approve: %v", err)
	}
	if err := waitCh(t, replies, "task.start response"); err != nil {
		t.Fatalf("task.start after approval: %v", err)
	}
	stdout, _, exit := waitExit(t, w)
	if stdout != "approved locally\n" {
		t.Fatalf("stdout = %q", stdout)
	}
	if exit.Outcome.Kind != protocol.OutcomeCode || exit.Outcome.Code != 0 {
		t.Fatalf("task.exit = %+v", exit)
	}
}

// TestForwardHelperLost kills the daemon while a task runs: the task ends with helper_lost and is
// not retried.
func TestForwardHelperLost(t *testing.T) {
	keys := newPrivKeys(t)
	env := newPrivEnv(t, keys, func(e *privEnv) string { return e.crhsOnlyConfig() })
	env.start()
	a := forwardAgent(t, Options{PrivilegedSocket: env.socket})
	waitForward(t, a)

	w := newCRHSWatch()
	accepted := make(chan error, 1)
	serveForward(t, a, w, func(ctx context.Context, p *protocol.Peer) error {
		ts := forwardedExecTask("fwd-lost", "/bin/sh", "-c", "sleep 30")
		ts.Authorizations = [][]byte{authorize(t, keys.crhs, exactPayload(t, keys.crhs, ts.TaskID, &ts.Spec))}
		accepted <- requestStart(ctx, p, ts)
		return nil
	})
	if err := waitCh(t, accepted, "task.start response"); err != nil {
		t.Fatalf("task.start: %v", err)
	}
	env.stop()

	stdout, _, exit := waitExit(t, w)
	if stdout != "" {
		t.Fatalf("stdout = %q, want none", stdout)
	}
	if exit.Outcome.Kind != protocol.OutcomeError || exit.Outcome.Error == nil || exit.Outcome.Error.Code != "helper_lost" {
		t.Fatalf("task.exit = %+v, want helper_lost", exit)
	}
	if !strings.Contains(exit.Outcome.Error.Message, "may still be running") {
		t.Fatalf("helper_lost message = %q", exit.Outcome.Error.Message)
	}
}

// TestForwardCancelAndQuery covers the relayed task.query and task.cancel: the daemon reports the
// running task and turns the cancel into a signal.
func TestForwardCancelAndQuery(t *testing.T) {
	keys := newPrivKeys(t)
	env := newPrivEnv(t, keys, func(e *privEnv) string { return e.crhsOnlyConfig() })
	env.start()
	a := forwardAgent(t, Options{PrivilegedSocket: env.socket})
	waitForward(t, a)

	w := newCRHSWatch()
	replies := make(chan error, 3)
	queried := make(chan protocol.TaskStatus, 1)
	serveForward(t, a, w, func(ctx context.Context, p *protocol.Peer) error {
		ts := forwardedExecTask("fwd-cancel", "/bin/sh", "-c", "sleep 30")
		ts.Authorizations = [][]byte{authorize(t, keys.crhs, exactPayload(t, keys.crhs, ts.TaskID, &ts.Spec))}
		if err := requestStart(ctx, p, ts); err != nil {
			replies <- err
			return nil
		}
		replies <- nil
		var status protocol.TaskStatus
		if err := p.Request(ctx, protocol.CmdTaskQuery, protocol.TaskQuery{TaskID: ts.TaskID}, &status); err != nil {
			replies <- err
			replies <- nil
			return nil
		}
		queried <- status
		var empty protocol.Empty
		replies <- p.Request(ctx, protocol.CmdTaskCancel, protocol.TaskCancel{TaskID: ts.TaskID}, &empty)
		return nil
	})

	if err := waitCh(t, replies, "task.start response"); err != nil {
		t.Fatalf("task.start: %v", err)
	}
	status := waitCh(t, queried, "task.query response")
	if status.TaskID != "fwd-cancel" || status.State != protocol.TaskRunning {
		t.Fatalf("task.query = %+v, want a running task", status)
	}
	if err := waitCh(t, replies, "task.cancel response"); err != nil {
		t.Fatalf("task.cancel: %v", err)
	}
	_, _, exit := waitExit(t, w)
	if !exit.Cancelled || exit.Outcome.Kind != protocol.OutcomeSignal || exit.Outcome.Signal != "TERM" {
		t.Fatalf("task.exit = %+v, want a cancelled task", exit)
	}
}

// TestForwardNonPrivilegedUnaffected runs ordinary tasks in forward mode while the privileged mode
// is unreachable, and refuses privileged ones with privileged_unavailable.
func TestForwardNonPrivilegedUnaffected(t *testing.T) {
	dir := t.TempDir()
	socket := filepath.Join(dir, "absent.sock")
	a := forwardAgent(t, Options{PrivilegedSocket: socket})

	w := newCRHSWatch()
	replies := make(chan error, 2)
	serveForward(t, a, w, func(ctx context.Context, p *protocol.Peer) error {
		replies <- requestStart(ctx, p, execTask("plain-1", "printf plain"))
		// The first task.exit is the ordinary one; the privileged task is refused before it runs.
		replies <- requestStart(ctx, p, privilegedTask("denied-1", "true"))
		return nil
	})

	if err := waitCh(t, replies, "the ordinary task.start"); err != nil {
		t.Fatalf("ordinary task.start: %v", err)
	}
	remote := expectRemoteCode(t, waitCh(t, replies, "the privileged task.start"), "privileged_unavailable")
	if !strings.Contains(remote.Message, "not reachable") {
		t.Fatalf("message = %q", remote.Message)
	}
	stdout, _, exit := waitExit(t, w)
	if stdout != "plain" || exit.Outcome.Kind != protocol.OutcomeCode || exit.Outcome.Code != 0 {
		t.Fatalf("stdout %q, exit %+v", stdout, exit)
	}
}

// ------------------------------- daemon log -------------------------------

// waitLogRecord waits for a line of the daemon's local log with the given event.
func waitLogRecord(t *testing.T, path, event, detail string) map[string]any {
	t.Helper()
	deadline := time.Now().Add(10 * time.Second)
	for time.Now().Before(deadline) {
		for _, record := range logRecords(t, path) {
			if record["event"] != event {
				continue
			}
			if detail == "" || record["detail"] == detail {
				return record
			}
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatalf("no %s record in %s", event, path)
	return nil
}

// logRecords reads the local log written so far.
func logRecords(t *testing.T, path string) []map[string]any {
	t.Helper()
	data, err := os.ReadFile(path)
	if err != nil {
		if os.IsNotExist(err) {
			return nil
		}
		t.Fatal(err)
	}
	var out []map[string]any
	lines := bytes.Split(bytes.TrimSpace(data), []byte("\n"))
	for i, line := range lines {
		if len(line) == 0 {
			continue
		}
		var record map[string]any
		if err := json.Unmarshal(line, &record); err != nil {
			// A reader can catch the log in the middle of the last append.
			if i == len(lines)-1 {
				break
			}
			t.Fatalf("bad log line %q: %v", line, err)
		}
		out = append(out, record)
	}
	return out
}

// syscallKillHup asks the daemon in this process to reload its configuration, as the daemon's own
// tests do.
func syscallKillHup() error {
	return syscall.Kill(os.Getpid(), syscall.SIGHUP)
}

// ------------------------------- wedged privileged mode -------------------------------

// sessionPeer returns the peer of the active crhs connection.
func sessionPeer(t *testing.T, a *Agent) *protocol.Peer {
	t.Helper()
	a.mu.Lock()
	defer a.mu.Unlock()
	if a.peer == nil {
		t.Fatal("agent has no session peer")
	}
	return a.peer
}

// forwardTask is a task.start the agent must forward to the privileged mode.
func forwardTask(id string) protocol.TaskStart {
	ts := execTask(id, "true")
	ts.Privileged = true
	return ts
}

// wedgedDaemon is a crh-priv forward daemon that accepts the handshake and answers trust.query, so
// the agent treats the privileged mode as connected, but holds task.start until the test releases
// it: the socket stays open and the request sits unanswered past the forward deadline, like a
// process that is still stuck on it. starts reports the task.start that reached it, cancels the
// task.cancel it answered.
type wedgedDaemon struct {
	starts  chan struct{}
	cancels chan string
	release chan struct{}
}

func newWedgedDaemon(t *testing.T, socket string) *wedgedDaemon {
	t.Helper()
	lis, err := net.Listen("unix", socket)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { lis.Close() })
	d := &wedgedDaemon{
		starts:  make(chan struct{}, 8),
		cancels: make(chan string, 8),
		release: make(chan struct{}),
	}
	// A test that fails before releasing must not leave the handler blocked.
	t.Cleanup(func() { signal(d.release) })
	go func() {
		for {
			conn, err := lis.Accept()
			if err != nil {
				return
			}
			go func() {
				defer conn.Close()
				_, negotiated, err := wire.ServerHandshake(conn, conn, wire.ServerOptions{
					Role:        wire.RoleForward,
					CRHAVersion: version.Version,
				})
				if err != nil {
					return
				}
				stream := wire.NewStreamFor(conn, conn, negotiated, wire.RoleForward)
				defer stream.Close(nil)
				peer := stream.Peer()
				peer.HandleRequest(wire.CmdTrustQuery, func(context.Context, cbor.RawMessage) (any, error) {
					return protocol.TrustSummary{
						NodeID: "node-1",
						Identities: protocol.Identities{
							Unprivileged: protocol.Identity{UID: 1000, GID: 1000, User: "crha"},
							Privileged:   protocol.Identity{UID: 0, GID: 0, User: "root"},
						},
					}, nil
				})
				peer.HandleRequest(protocol.CmdTaskStart, func(context.Context, cbor.RawMessage) (any, error) {
					select {
					case d.starts <- struct{}{}:
					default:
					}
					// Answer only once the test releases the task, so the agent's deadline expires
					// first. The agent's later task.cancel waits behind this handler, exactly like
					// a request queued on a daemon that is still busy with task.start.
					<-d.release
					return protocol.Empty{}, nil
				})
				peer.HandleRequest(protocol.CmdTaskCancel, func(_ context.Context, body cbor.RawMessage) (any, error) {
					var c protocol.TaskCancel
					if err := protocol.Unmarshal(body, &c); err != nil {
						return nil, err
					}
					d.cancels <- c.TaskID
					return protocol.Empty{}, nil
				})
				_ = stream.Run()
			}()
		}
	}()
	return d
}

// TestForwardWedgedStartDoesNotDelayOtherTasks covers the per-task order of the request worker: a
// forwarded task.start waits up to the forward deadline for a wedged daemon, and an ordinary
// non-privileged task on the same crhs connection must still start, take its input and be cancelled
// while it waits (doc/protocol.md task.start, forward).
func TestForwardWedgedStartDoesNotDelayOtherTasks(t *testing.T) {
	socket := filepath.Join(t.TempDir(), "priv.sock")
	daemon := newWedgedDaemon(t, socket)
	a := forwardAgent(t, Options{PrivilegedSocket: socket})
	waitForward(t, a)

	const input = "hello\n"
	sum := sha256.Sum256([]byte(input))
	plain := execTask("plain-1", "cat")
	plain.Spec.Exec.Stdin = &protocol.InputRef{Size: protocol.Uint(len(input)), SHA256: protocol.Hash(sum)}

	w := newCRHSWatch()
	ordinary := make(chan error, 1)
	privileged := make(chan error, 1)
	serveForward(t, a, w, func(_ context.Context, p *protocol.Peer) error {
		go func() { privileged <- requestStart(context.Background(), p, forwardTask("wedged-1")) }()
		select {
		case <-daemon.starts:
		case err := <-privileged:
			return fmt.Errorf("the forwarded start finished before the daemon held it: %v", err)
		case <-time.After(10 * time.Second):
			return errors.New("the task.start never reached the privileged mode")
		}
		go func() {
			var empty protocol.Empty
			if err := requestStart(context.Background(), p, plain); err != nil {
				ordinary <- fmt.Errorf("ordinary task.start: %w", err)
				return
			}
			if err := p.Request(context.Background(), protocol.CmdTaskInput,
				protocol.TaskInput{TaskID: plain.TaskID, Data: []byte(input)}, &empty); err != nil {
				ordinary <- fmt.Errorf("ordinary task.input: %w", err)
				return
			}
			if err := p.Request(context.Background(), protocol.CmdTaskCancel,
				protocol.TaskCancel{TaskID: plain.TaskID}, &empty); err != nil {
				ordinary <- fmt.Errorf("ordinary task.cancel: %w", err)
				return
			}
			ordinary <- nil
		}()
		return nil
	})

	if err := waitCh(t, ordinary, "the ordinary task.start, input and cancel"); err != nil {
		t.Fatalf("%v", err)
	}
	// They were answered while the forwarded start still waits for the daemon, which only a
	// per-task worker allows: the single worker would have kept them behind it.
	select {
	case err := <-privileged:
		t.Fatalf("the forwarded start finished before the ordinary task: %v", err)
	default:
	}
}

// TestForwardRequestTimeout covers the deadline on a forwarded task.start and the receive loop
// staying free while it waits: a privileged mode that does not answer must not stop the session
// from processing crhs's frames (a blocked receive loop never reads the pong of the keepalive, and
// the connection drops after its ping timeout). The task is reported accepted, because the daemon
// may still run it, ends as helper_lost, and the daemon is asked to cancel it (doc/protocol.md
// task.start, forward).
func TestForwardRequestTimeout(t *testing.T) {
	const timeout = 2 * time.Second
	socket := filepath.Join(t.TempDir(), "priv.sock")
	daemon := newWedgedDaemon(t, socket)
	a := forwardAgent(t, Options{
		PrivilegedSocket:      socket,
		ForwardRequestTimeout: timeout,
	})
	waitForward(t, a)

	w := newCRHSWatch()
	startErr := make(chan error, 1)
	serveForward(t, a, w, func(_ context.Context, p *protocol.Peer) error {
		var empty protocol.Empty
		startErr <- p.Request(context.Background(), protocol.CmdTaskStart, forwardTask("fwd-timeout-1"), &empty)
		return nil
	})

	select {
	case <-daemon.starts:
	case err := <-startErr:
		t.Fatalf("task.start failed before reaching the privileged mode: %v", err)
	case <-time.After(10 * time.Second):
		t.Fatal("the task.start never reached the privileged mode")
	}
	// The forwarded request is waiting for the daemon. A ping needs its pong read by the receive
	// loop, exactly like the keepalive, and must be answered before the forward deadline.
	peer := sessionPeer(t, a)
	rctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	var pong protocol.Ping
	if err := peer.Request(rctx, protocol.CmdPing, protocol.Ping{Seq: 7}, &pong); err != nil {
		t.Fatalf("ping while a forwarded request waited: %v", err)
	}
	if pong.Seq != 7 {
		t.Fatalf("pong seq = %d, want 7", pong.Seq)
	}
	select {
	case err := <-startErr:
		t.Fatalf("task.start finished before its deadline: %v", err)
	default:
	}

	select {
	case err := <-startErr:
		// The daemon may still accept and run the task, so the deadline must not read as a
		// refusal: crhs would be free to re-issue it.
		if err != nil {
			t.Fatalf("task.start after the deadline = %v, want accepted", err)
		}
	case <-time.After(15 * time.Second):
		t.Fatal("the forwarded task.start did not finish after its deadline")
	}

	// The outcome is unknowable here, so the task ends the way a lost helper does.
	_, _, exit := waitExit(t, w)
	if exit.TaskID != "fwd-timeout-1" {
		t.Fatalf("task.exit = %+v", exit)
	}
	if exit.Outcome.Kind != protocol.OutcomeError || exit.Outcome.Error == nil || exit.Outcome.Error.Code != "helper_lost" {
		t.Fatalf("task.exit = %+v, want helper_lost", exit)
	}
	if !strings.Contains(exit.Outcome.Error.Message, "may still be running") {
		t.Fatalf("helper_lost message = %q", exit.Outcome.Error.Message)
	}

	// Releasing task.start lets the daemon answer it and then serve the queued task.cancel.
	signal(daemon.release)
	select {
	case taskID := <-daemon.cancels:
		if taskID != "fwd-timeout-1" {
			t.Fatalf("task.cancel for %q, want fwd-timeout-1", taskID)
		}
	case <-time.After(10 * time.Second):
		t.Fatal("the privileged mode was not asked to cancel the timed-out task")
	}

	// The session survived the timeout and still answers.
	rctx, cancel = context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	pong = protocol.Ping{}
	if err := peer.Request(rctx, protocol.CmdPing, protocol.Ping{Seq: 8}, &pong); err != nil {
		t.Fatalf("ping after the timeout: %v", err)
	}
	if pong.Seq != 8 {
		t.Fatalf("pong seq = %d, want 8", pong.Seq)
	}
}
