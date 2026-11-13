package agent

import (
	"bytes"
	"context"
	"crypto/sha256"
	"errors"
	"io"
	"net/http/httptest"
	"os"
	"path/filepath"
	"sync"
	"testing"
	"time"

	"github.com/fxamacker/cbor/v2"

	"github.com/Kodecable/ClusterRightHand/client/internal/noise"
	"github.com/Kodecable/ClusterRightHand/client/internal/protocol"
)

// fakeDataConn is an in-memory data connection: toAgent holds the frames the agent receives and
// fromAgent records what it sends.
type fakeDataConn struct {
	mu        sync.Mutex
	toAgent   [][]byte
	fromAgent [][]byte
	closed    chan struct{}
	once      sync.Once
}

func newFakeDataConn(toAgent ...[]byte) *fakeDataConn {
	return &fakeDataConn{toAgent: toAgent, closed: make(chan struct{})}
}

func (c *fakeDataConn) Send(_ context.Context, frame []byte) error {
	c.mu.Lock()
	c.fromAgent = append(c.fromAgent, append([]byte(nil), frame...))
	c.mu.Unlock()
	return nil
}

func (c *fakeDataConn) Recv(ctx context.Context) ([]byte, error) {
	c.mu.Lock()
	if len(c.toAgent) > 0 {
		frame := c.toAgent[0]
		c.toAgent = c.toAgent[1:]
		c.mu.Unlock()
		return frame, nil
	}
	c.mu.Unlock()
	select {
	case <-c.closed:
		return nil, io.EOF
	case <-ctx.Done():
		return nil, ctx.Err()
	}
}

func (c *fakeDataConn) Close(string) error {
	c.once.Do(func() { close(c.closed) })
	return nil
}

func (c *fakeDataConn) sent(t *testing.T) []protocol.DataFrame {
	t.Helper()
	c.mu.Lock()
	defer c.mu.Unlock()
	frames := make([]protocol.DataFrame, 0, len(c.fromAgent))
	for _, raw := range c.fromAgent {
		var frame protocol.DataFrame
		if err := protocol.Unmarshal(raw, &frame); err != nil {
			t.Fatalf("sent frame does not decode: %v", err)
		}
		frames = append(frames, frame)
	}
	return frames
}

func mustDataFrame(t *testing.T, frame protocol.DataFrame) []byte {
	t.Helper()
	raw, err := protocol.Marshal(frame)
	if err != nil {
		t.Fatal(err)
	}
	return raw
}

func hashOf(data []byte) protocol.Hash { return protocol.Hash(sha256.Sum256(data)) }

func transferTaskStart(id string, spec *protocol.TaskSpec) protocol.TaskStart {
	return protocol.TaskStart{
		TaskID: id, Attempt: 1,
		Spec:   *spec,
		Output: protocol.OutputMode{Kind: protocol.OutputStatus},
	}
}

func TestPushTransferWritesFile(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "out.txt")
	data := []byte("hello data connection")
	conn := newFakeDataConn(
		mustDataFrame(t, protocol.DataFrame{Kind: protocol.DataFrameData, Bytes: data[:5]}),
		mustDataFrame(t, protocol.DataFrame{Kind: protocol.DataFrameData, Bytes: data[5:]}),
		mustDataFrame(t, protocol.DataFrame{Kind: protocol.DataFrameEnd}),
	)
	exitCh := make(chan protocol.TaskExit, 1)
	srv, serverKey := fakeServer(t, exitCh, func(ctx context.Context, p *protocol.Peer) {
		ts := transferTaskStart("push-1", &protocol.TaskSpec{
			Kind: protocol.TaskSpecFilePush,
			FilePush: &protocol.FilePushSpec{
				Path: path, Size: protocol.Uint(len(data)), SHA256: hashOf(data),
				Endpoint: protocol.TransferEndpoint{Kind: protocol.TransferEndpointCRHS, TransferID: "tr-1"},
			},
		})
		var empty protocol.Empty
		if err := p.Request(ctx, protocol.CmdTaskStart, ts, &empty); err != nil {
			t.Errorf("task.start: %v", err)
		}
	})
	a := newTestAgent(t, Options{DataDial: func(_ context.Context, taskID, transferID string) (DataConn, error) {
		if taskID != "push-1" || transferID != "tr-1" {
			t.Errorf("DataDial(%q, %q), want (push-1, tr-1)", taskID, transferID)
		}
		return conn, nil
	}})
	startSession(t, a, dialTo(t, srv, serverKey))
	exit := waitCh(t, exitCh, "task.exit")
	if exit.Outcome.Kind != protocol.OutcomeCode || exit.Outcome.Code != 0 {
		t.Fatalf("task.exit = %+v", exit)
	}
	if exit.Result != nil {
		t.Fatalf("a push reported a result: %+v", exit.Result)
	}
	got, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(got, data) {
		t.Fatalf("file content = %q, want %q", got, data)
	}
}

func TestPullTransferSendsFileAndResult(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "in.txt")
	// More than one data frame holds, so the sender must split it (docs: 32 KiB per frame).
	data := bytes.Repeat([]byte("pull these bytes "), 10000)
	if err := os.WriteFile(path, data, 0o644); err != nil {
		t.Fatal(err)
	}
	conn := newFakeDataConn()
	exitCh := make(chan protocol.TaskExit, 1)
	srv, serverKey := fakeServer(t, exitCh, func(ctx context.Context, p *protocol.Peer) {
		ts := transferTaskStart("pull-1", &protocol.TaskSpec{
			Kind: protocol.TaskSpecFilePull,
			FilePull: &protocol.FilePullSpec{
				Path: path, MaxBytes: 1 << 20,
				Endpoint: protocol.TransferEndpoint{Kind: protocol.TransferEndpointCRHS, TransferID: "tr-2"},
			},
		})
		var empty protocol.Empty
		if err := p.Request(ctx, protocol.CmdTaskStart, ts, &empty); err != nil {
			t.Errorf("task.start: %v", err)
		}
	})
	a := newTestAgent(t, Options{DataDial: func(context.Context, string, string) (DataConn, error) { return conn, nil }})
	startSession(t, a, dialTo(t, srv, serverKey))
	exit := waitCh(t, exitCh, "task.exit")
	if exit.Outcome.Kind != protocol.OutcomeCode || exit.Outcome.Code != 0 {
		if exit.Outcome.Error != nil {
			t.Fatalf("task.exit = %+v error=%s", exit, exit.Outcome.Error.Message)
		}
		t.Fatalf("task.exit = %+v", exit)
	}
	if exit.Result == nil || exit.Result.Kind != protocol.TaskResultFilePull || exit.Result.FilePull == nil {
		t.Fatalf("task.exit result = %+v", exit.Result)
	}
	if r := exit.Result.FilePull; uint64(r.Size) != uint64(len(data)) || r.SHA256 != hashOf(data) {
		t.Fatalf("file.pull result = %+v", r)
	}
	var sent []byte
	var ended bool
	for _, frame := range conn.sent(t) {
		switch frame.Kind {
		case protocol.DataFrameData:
			sent = append(sent, frame.Bytes...)
		case protocol.DataFrameEnd:
			ended = true
		case protocol.DataFrameAbort:
			t.Fatalf("unexpected abort %q", frame.Code)
		}
	}
	if !bytes.Equal(sent, data) {
		t.Fatalf("sent bytes = %q, want %q", sent, data)
	}
	if !ended {
		t.Fatal("the pull did not send [end]")
	}
}

func TestPullTooLargeSendsAbortBeforeAnyData(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "big.txt")
	if err := os.WriteFile(path, []byte("12345"), 0o644); err != nil {
		t.Fatal(err)
	}
	conn := newFakeDataConn()
	exitCh := make(chan protocol.TaskExit, 1)
	srv, serverKey := fakeServer(t, exitCh, func(ctx context.Context, p *protocol.Peer) {
		ts := transferTaskStart("pull-big", &protocol.TaskSpec{
			Kind: protocol.TaskSpecFilePull,
			FilePull: &protocol.FilePullSpec{
				Path: path, MaxBytes: 1,
				Endpoint: protocol.TransferEndpoint{Kind: protocol.TransferEndpointCRHS, TransferID: "tr-3"},
			},
		})
		var empty protocol.Empty
		if err := p.Request(ctx, protocol.CmdTaskStart, ts, &empty); err != nil {
			t.Errorf("task.start: %v", err)
		}
	})
	a := newTestAgent(t, Options{DataDial: func(context.Context, string, string) (DataConn, error) { return conn, nil }})
	startSession(t, a, dialTo(t, srv, serverKey))
	exit := waitCh(t, exitCh, "task.exit")
	if exit.Outcome.Kind != protocol.OutcomeError || exit.Outcome.Error == nil || exit.Outcome.Error.Code != protocol.CodeTooLarge {
		t.Fatalf("task.exit = %+v", exit)
	}
	frames := conn.sent(t)
	if len(frames) != 1 || frames[0].Kind != protocol.DataFrameAbort || frames[0].Code != protocol.CodeTooLarge {
		t.Fatalf("sent frames = %+v, want one too_large abort", frames)
	}
}

func TestTransferBusyBackstop(t *testing.T) {
	a := newTestAgent(t, Options{})
	if !a.claimTransfer() {
		t.Fatal("the first transfer claim failed")
	}
	ts := transferTaskStart("push-busy", &protocol.TaskSpec{
		Kind: protocol.TaskSpecFilePush,
		FilePush: &protocol.FilePushSpec{
			Path: "/tmp/x", Size: 0, SHA256: hashOf(nil),
			Endpoint: protocol.TransferEndpoint{Kind: protocol.TransferEndpointCRHS, TransferID: "tr-x"},
		},
	})
	if _, err := a.start(context.Background(), &ts); err == nil {
		t.Fatal("a second transfer was accepted")
	} else {
		var remote *protocol.RemoteError
		if !errors.As(err, &remote) || remote.Code != protocol.CodeBusy {
			t.Fatalf("start error = %v, want busy", err)
		}
	}
	a.releaseTransfer()
	if !a.claimTransfer() {
		t.Fatal("the transfer slot was not released")
	}
	a.releaseTransfer()
}

func TestTransferIdleTimeoutFailsTask(t *testing.T) {
	old := transferIdleTimeout
	transferIdleTimeout = 50 * time.Millisecond
	defer func() { transferIdleTimeout = old }()

	dir := t.TempDir()
	path := filepath.Join(dir, "idle.txt")
	data := []byte("never arrives")
	conn := newFakeDataConn() // blocks in Recv
	exitCh := make(chan protocol.TaskExit, 1)
	srv, serverKey := fakeServer(t, exitCh, func(ctx context.Context, p *protocol.Peer) {
		ts := transferTaskStart("push-idle", &protocol.TaskSpec{
			Kind: protocol.TaskSpecFilePush,
			FilePush: &protocol.FilePushSpec{
				Path: path, Size: protocol.Uint(len(data)), SHA256: hashOf(data),
				Endpoint: protocol.TransferEndpoint{Kind: protocol.TransferEndpointCRHS, TransferID: "tr-4"},
			},
		})
		var empty protocol.Empty
		if err := p.Request(ctx, protocol.CmdTaskStart, ts, &empty); err != nil {
			t.Errorf("task.start: %v", err)
		}
	})
	a := newTestAgent(t, Options{DataDial: func(context.Context, string, string) (DataConn, error) { return conn, nil }})
	startSession(t, a, dialTo(t, srv, serverKey))
	exit := waitCh(t, exitCh, "task.exit")
	if exit.Outcome.Kind != protocol.OutcomeError || exit.Outcome.Error == nil {
		t.Fatalf("task.exit = %+v, want a transfer failure", exit)
	}
	if _, err := os.Stat(path); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("%s exists after a failed transfer", path)
	}
}

// fakeServer starts the fake crhs with the exit collector and the task.start script.
func fakeServer(t *testing.T, exitCh chan<- protocol.TaskExit, run func(context.Context, *protocol.Peer)) (*httptest.Server, noise.Keypair) {
	t.Helper()
	serverKey, err := noise.GenerateKeypair()
	if err != nil {
		t.Fatal(err)
	}
	srv := startFake(t, serverKey, fakeConfig{
		setup: func(p *protocol.Peer) {
			p.HandleEvent(protocol.EventFacts, func(cbor.RawMessage) error { return nil })
			p.HandleEvent(protocol.EventTaskExit, func(body cbor.RawMessage) error {
				var exit protocol.TaskExit
				if err := protocol.Unmarshal(body, &exit); err != nil {
					return err
				}
				select {
				case exitCh <- exit:
				default:
				}
				return nil
			})
		},
		run: run,
	})
	return srv, serverKey
}
