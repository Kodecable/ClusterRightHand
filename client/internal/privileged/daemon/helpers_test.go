package daemon

import (
	"bytes"
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"crypto/sha256"
	"crypto/sha512"
	"encoding/binary"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/fxamacker/cbor/v2"
	"golang.org/x/crypto/ssh"

	"github.com/Kodecable/ClusterRightHand/client/internal/privileged/audit"
	"github.com/Kodecable/ClusterRightHand/client/internal/privileged/authz"
	"github.com/Kodecable/ClusterRightHand/client/internal/privileged/config"
	"github.com/Kodecable/ClusterRightHand/client/internal/privileged/wire"
	"github.com/Kodecable/ClusterRightHand/client/internal/protocol"
)

// testKeys are the signing keys of a daemon test.
type testKeys struct {
	crhs     ssh.Signer
	crhsLine string
	user     ssh.Signer
	userLine string
}

func newTestKeys(t *testing.T) *testKeys {
	t.Helper()
	crhs := newSSHSigner(t)
	user := newSSHSigner(t)
	return &testKeys{
		crhs: crhs, crhsLine: authorizedLine(crhs),
		user: user, userLine: authorizedLine(user),
	}
}

func newSSHSigner(t *testing.T) ssh.Signer {
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

// envPaths is where one test daemon keeps its files.
type envPaths struct {
	Dir      string
	Config   string
	Socket   string
	StateDir string
	Log      string
}

// testEnv is a running privileged daemon on a temporary socket.
type testEnv struct {
	t      *testing.T
	paths  envPaths
	keys   *testKeys
	cfg    *config.Config
	log    *audit.Logger
	server *Server

	cancel context.CancelFunc
	done   chan error
}

// newTestEnv writes the configuration built by build (which receives the temporary paths),
// starts the daemon and stops it at the end of the test.
func newTestEnv(t *testing.T, keys *testKeys, build func(envPaths) string) *testEnv {
	t.Helper()
	dir, err := os.MkdirTemp("", "crh-daemon-")
	if err != nil {
		t.Fatal(err)
	}
	e := &testEnv{
		t:    t,
		keys: keys,
		paths: envPaths{
			Dir:      dir,
			Config:   filepath.Join(dir, "privileged.toml"),
			Socket:   filepath.Join(dir, "priv.sock"),
			StateDir: filepath.Join(dir, "state"),
			Log:      filepath.Join(dir, "privileged.jsonl"),
		},
	}
	t.Cleanup(func() {
		e.stop()
		os.RemoveAll(dir)
	})
	e.writeConfig(build)
	e.start()
	return e
}

// writeConfig writes a new configuration file with mode 0600.
func (e *testEnv) writeConfig(build func(envPaths) string) {
	e.t.Helper()
	if err := os.WriteFile(e.paths.Config, []byte(build(e.paths)), 0o600); err != nil {
		e.t.Fatal(err)
	}
}

// start loads the configuration and runs the daemon until stop.
func (e *testEnv) start() {
	e.t.Helper()
	cfg, err := config.Load(e.paths.Config)
	if err != nil {
		e.t.Fatalf("load config: %v", err)
	}
	e.cfg = cfg
	log, err := audit.Open(e.paths.Log, audit.Options{Mirror: io.Discard})
	if err != nil {
		e.t.Fatalf("open log: %v", err)
	}
	server, err := New(cfg, Options{ConfigPath: e.paths.Config, Version: "test", Log: log})
	if err != nil {
		log.Close()
		e.t.Fatalf("New: %v", err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() { done <- server.Run(ctx) }()
	e.log = log
	e.server = server
	e.cancel = cancel
	e.done = done
	waitForSocket(e.t, e.paths.Socket)
}

// stop shuts the daemon down and waits for it.
func (e *testEnv) stop() {
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
		e.t.Error("daemon did not stop")
	}
	if err := e.log.Close(); err != nil {
		e.t.Errorf("close log: %v", err)
	}
	e.cancel = nil
	e.done = nil
	e.server = nil
}

// restart stops and starts the daemon with the current configuration and state directory.
func (e *testEnv) restart() {
	e.t.Helper()
	e.stop()
	e.start()
}

func waitForSocket(t *testing.T, path string) {
	t.Helper()
	deadline := time.Now().Add(10 * time.Second)
	for time.Now().Before(deadline) {
		fi, err := os.Lstat(path)
		if err == nil && fi.Mode()&os.ModeSocket != 0 {
			return
		}
		time.Sleep(5 * time.Millisecond)
	}
	t.Fatalf("socket %s did not appear", path)
}

// baseConfig is the shared top of a privileged.toml for a test daemon.
func baseConfig(p envPaths, uid int) string {
	return fmt.Sprintf(`node_id          = "0192f000-0000-7000-8000-000000000001"
aliases          = ["0192f000-0000-7000-8000-0000000000a1"]
unprivileged_uid = %d
clock_skew       = "60s"
socket           = %q
state_dir        = %q
log              = %q
`, uid, p.Socket, p.StateDir, p.Log)
}

// sshTrust renders one sshsig trust entry.
func sshTrust(name, role, line, kinds string, extra string) string {
	return fmt.Sprintf(`
[[trust]]
name   = %q
role   = %q
format = "sshsig"
key    = %q
kinds  = %s
%s
`, name, role, line, kinds, extra)
}

// localTrust renders one local trust entry.
func localTrust(name string, uids []uint32, extra string) string {
	return fmt.Sprintf(`
[[trust]]
name  = %q
role  = "local"
uids  = %v
kinds = ["execute"]
%s
`, name, uids, extra)
}

// execTask is an argv exec task.
func execTask(id string, attempt uint64, argv ...string) protocol.TaskStart {
	return protocol.TaskStart{
		TaskID:  id,
		Attempt: protocol.Uint(attempt),
		Spec: protocol.TaskSpec{Kind: protocol.TaskSpecExec, Exec: &protocol.ExecSpec{
			Command: protocol.Command{Kind: protocol.CommandArgv, Argv: argv},
		}},
		Privileged: true,
		Output:     protocol.OutputMode{Kind: protocol.OutputFull, SpillBytes: 1 << 20, SpillLines: 2000},
	}
}

// fileWriteTask is a file.write task with empty content.
func fileWriteTask(id string, attempt uint64, path string) protocol.TaskStart {
	return protocol.TaskStart{
		TaskID:  id,
		Attempt: protocol.Uint(attempt),
		Spec: protocol.TaskSpec{Kind: protocol.TaskSpecFileWrite, FileWrite: &protocol.FileWriteSpec{
			Path:    path,
			Content: protocol.InputRef{Size: 0, SHA256: protocol.Hash(sha256.Sum256(nil))},
		}},
		Privileged: true,
		Output:     protocol.OutputMode{Kind: protocol.OutputStatus},
	}
}

// payload builds an AuthorizationPayload with sensible times.
func payloadFor(taskID string, attempt uint64, command *protocol.AuthCommand, deadline *time.Time) *protocol.AuthorizationPayload {
	issued := time.Now().Add(-time.Minute).UnixMilli()
	ids := []string{taskID}
	att := protocol.Uint(attempt)
	p := &protocol.AuthorizationPayload{
		V:          protocol.AuthPayloadVersion,
		Nodes:      []string{"0192f000-0000-7000-8000-000000000001"},
		Command:    command,
		IssuedAtMS: protocol.Int(issued),
		TaskIDs:    &ids,
		Attempt:    &att,
	}
	if deadline != nil {
		value := protocol.Int(deadline.UnixMilli())
		p.DeadlineMS = &value
	} else {
		inFive := protocol.Int(time.Now().Add(5 * time.Minute).UnixMilli())
		p.DeadlineMS = &inFive
	}
	return p
}

// exactCommand builds an exact command restriction for spec.
func exactCommand(t *testing.T, spec *protocol.TaskSpec) *protocol.AuthCommand {
	t.Helper()
	return exactCommandFor(t, protocol.MethodExec, spec)
}

// exactCommandFor builds an exact command restriction with the given method.
func exactCommandFor(t *testing.T, method protocol.Method, spec *protocol.TaskSpec) *protocol.AuthCommand {
	t.Helper()
	target, err := targetOf(spec)
	if err != nil {
		t.Fatalf("target: %v", err)
	}
	hash, err := protocol.SpecSHA256(spec)
	if err != nil {
		t.Fatal(err)
	}
	return &protocol.AuthCommand{Method: method, Match: protocol.AuthMatch{
		Kind: protocol.AuthMatchExact, Exact: &protocol.AuthExact{Target: target, SpecSHA256: protocol.Hash(hash)},
	}}
}

// marshalPayload returns the payload bytes that are signed and hashed.
func marshalPayload(t *testing.T, payload *protocol.AuthorizationPayload) []byte {
	t.Helper()
	raw, err := protocol.Marshal(payload)
	if err != nil {
		t.Fatalf("encode payload: %v", err)
	}
	return raw
}

// prefixCommand builds a prefix command restriction.
func prefixCommand(method protocol.Method, target string) *protocol.AuthCommand {
	return &protocol.AuthCommand{Method: method, Match: protocol.AuthMatch{
		Kind: protocol.AuthMatchPrefix, Prefix: &protocol.AuthPrefix{Target: target},
	}}
}

// authorize signs payload with every signer and returns CBOR(Authorization).
func authorize(t *testing.T, payload *protocol.AuthorizationPayload, signers ...ssh.Signer) []byte {
	t.Helper()
	raw, err := protocol.Marshal(payload)
	if err != nil {
		t.Fatalf("encode payload: %v", err)
	}
	signatures := make([]protocol.Signature, 0, len(signers))
	for _, signer := range signers {
		signatures = append(signatures, protocol.Signature{
			Kind:   protocol.SignatureSSHSig,
			SSHSig: &protocol.SSHSigSignature{Blob: signSSHSIG(t, signer, raw)},
		})
	}
	authorization, err := protocol.Marshal(&protocol.Authorization{Payload: raw, Signatures: signatures})
	if err != nil {
		t.Fatalf("encode authorization: %v", err)
	}
	return authorization
}

// signSSHSIG produces an OpenSSH SSHSIG blob over message, as `ssh-keygen -Y sign -n
// crh-auth-v1` would (SHA-512, non-FIDO key).
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
		t.Fatalf("sign: %v", err)
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

// forwardClient is a crh-priv forward-role client of a test daemon.
type forwardClient struct {
	t         *testing.T
	conn      net.Conn
	stream    *wire.Stream
	peer      *protocol.Peer
	outputs   chan protocol.TaskOutput
	exits     chan protocol.TaskExit
	summaries chan protocol.TrustReport
	decisions chan protocol.LocalDecision
	done      chan struct{}
}

func dialForward(t *testing.T, socket string) *forwardClient {
	t.Helper()
	conn, err := net.Dial("unix", socket)
	if err != nil {
		t.Fatalf("dial %s: %v", socket, err)
	}
	_, negotiated, err := wire.ClientHandshake(conn, conn, wire.ClientOptions{
		Role: wire.RoleForward, CRHAVersion: "test",
	})
	if err != nil {
		conn.Close()
		t.Fatalf("handshake: %v", err)
	}
	c := &forwardClient{
		t:         t,
		conn:      conn,
		stream:    wire.NewStreamFor(conn, conn, negotiated, wire.RoleForward),
		outputs:   make(chan protocol.TaskOutput, 512),
		exits:     make(chan protocol.TaskExit, 64),
		summaries: make(chan protocol.TrustReport, 16),
		decisions: make(chan protocol.LocalDecision, 16),
		done:      make(chan struct{}),
	}
	c.peer = c.stream.Peer()
	c.peer.HandleEvent(protocol.EventTaskOutput, func(body cbor.RawMessage) error {
		var out protocol.TaskOutput
		if err := protocol.Unmarshal(body, &out); err != nil {
			return err
		}
		c.outputs <- out
		return nil
	})
	c.peer.HandleEvent(protocol.EventTaskExit, func(body cbor.RawMessage) error {
		var exit protocol.TaskExit
		if err := protocol.Unmarshal(body, &exit); err != nil {
			return err
		}
		c.exits <- exit
		return nil
	})
	c.peer.HandleEvent(protocol.EventTrustSummary, func(body cbor.RawMessage) error {
		var report protocol.TrustReport
		if err := protocol.Unmarshal(body, &report); err != nil {
			return err
		}
		c.summaries <- report
		return nil
	})
	c.peer.HandleEvent(protocol.EventLocalDecision, func(body cbor.RawMessage) error {
		var decision protocol.LocalDecision
		if err := protocol.Unmarshal(body, &decision); err != nil {
			return err
		}
		c.decisions <- decision
		return nil
	})
	go func() {
		_ = c.stream.Run()
		close(c.done)
	}()
	t.Cleanup(c.close)
	return c
}

func (c *forwardClient) close() {
	c.peer.Close(nil)
	_ = c.conn.Close()
	<-c.done
}

func (c *forwardClient) start(ctx context.Context, ts protocol.TaskStart) error {
	var empty protocol.Empty
	return c.peer.Request(ctx, protocol.CmdTaskStart, ts, &empty)
}

func (c *forwardClient) localRequest(ctx context.Context, req protocol.LocalRequest) (protocol.LocalState, error) {
	var state protocol.LocalState
	err := c.peer.Request(ctx, protocol.CmdLocalRequest, req, &state)
	return state, err
}

func (c *forwardClient) withdrawLocal(ctx context.Context, taskID string, attempt uint64) error {
	var empty protocol.Empty
	return c.peer.Request(ctx, protocol.CmdLocalWithdraw, protocol.LocalWithdraw{TaskID: taskID, Attempt: protocol.Uint(attempt)}, &empty)
}

func (c *forwardClient) waitExit(timeout time.Duration) protocol.TaskExit {
	c.t.Helper()
	select {
	case exit := <-c.exits:
		return exit
	case <-time.After(timeout):
		c.t.Fatal("timed out waiting for task.exit")
		return protocol.TaskExit{}
	}
}

func (c *forwardClient) output() string {
	var buf bytes.Buffer
	for {
		select {
		case out := <-c.outputs:
			buf.Write(out.Data)
		default:
			return buf.String()
		}
	}
}

func (c *forwardClient) waitSummary(timeout time.Duration) protocol.TrustReport {
	c.t.Helper()
	select {
	case report := <-c.summaries:
		return report
	case <-time.After(timeout):
		c.t.Fatal("timed out waiting for trust.summary")
		return protocol.TrustReport{}
	}
}

func (c *forwardClient) waitDecision(timeout time.Duration) protocol.LocalDecision {
	c.t.Helper()
	select {
	case decision := <-c.decisions:
		return decision
	case <-time.After(timeout):
		c.t.Fatal("timed out waiting for local.decision")
		return protocol.LocalDecision{}
	}
}

// targetOf renders the method and target of a task spec with authz.Target.
func targetOf(spec *protocol.TaskSpec) (string, error) {
	_, target, err := authz.Target(spec)
	return target, err
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
	lines := bytes.Split(bytes.TrimSpace(data), []byte("\n"))
	var out []map[string]any
	for i, line := range lines {
		if len(line) == 0 {
			continue
		}
		var record map[string]any
		if err := json.Unmarshal(line, &record); err != nil {
			// A reader can catch the log in the middle of the last append; it is not a
			// corrupt log, just an unfinished line.
			if i == len(lines)-1 {
				break
			}
			t.Fatalf("bad log line %q: %v", line, err)
		}
		out = append(out, record)
	}
	return out
}

// waitLogRecord waits for a line with the given event and task id.
func waitLogRecord(t *testing.T, path, event, taskID string, timeout time.Duration) map[string]any {
	t.Helper()
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		for _, record := range logRecords(t, path) {
			if record["event"] != event {
				continue
			}
			if taskID == "" || record["task_id"] == taskID {
				return record
			}
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatalf("no %s record for task %s in %s", event, taskID, path)
	return nil
}
