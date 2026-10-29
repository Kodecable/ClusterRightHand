package agent

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/Kodecable/ClusterRightHand/client/internal/noise"
	"github.com/Kodecable/ClusterRightHand/client/internal/protocol"
	"github.com/Kodecable/ClusterRightHand/client/internal/transport"
	"github.com/coder/websocket"
	"github.com/fxamacker/cbor/v2"
)

// frameLog records the frames crhs received, in wire order.
type frameLog struct {
	mu     sync.Mutex
	frames []string
}

func (l *frameLog) add(f *protocol.Frame) {
	var entry string
	switch f.Kind {
	case protocol.FrameRequest:
		entry = "request " + f.Name
	case protocol.FrameResponse:
		entry = fmt.Sprintf("response %s ok=%v", f.Name, f.OK)
	case protocol.FrameEvent:
		entry = "event " + f.Name
	}
	l.mu.Lock()
	l.frames = append(l.frames, entry)
	l.mu.Unlock()
}

func (l *frameLog) snapshot() []string {
	l.mu.Lock()
	defer l.mu.Unlock()
	return append([]string(nil), l.frames...)
}

func indexOf(frames []string, want string) int {
	for i, frame := range frames {
		if frame == want {
			return i
		}
	}
	return -1
}

// fakeConfig scripts one fake crhs connection.
type fakeConfig struct {
	nodeState protocol.NodeState
	setup     func(*protocol.Peer)
	run       func(context.Context, *protocol.Peer)
	log       *frameLog
	// sent, when non-nil, sees every frame crhs sends to the agent, in wire order.
	sent func(*protocol.Frame)
}

// startFake serves a fake crhs over WebSocket + Noise. setup registers request and event handlers
// before frames are read; run is a script that runs concurrently with the receive loop.
func startFake(t *testing.T, serverKey noise.Keypair, cfg fakeConfig) *httptest.Server {
	t.Helper()
	if cfg.setup == nil {
		cfg.setup = func(*protocol.Peer) {}
	}
	if cfg.nodeState == "" {
		cfg.nodeState = protocol.NodeActive
	}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		ws, err := websocket.Accept(w, r, nil)
		if err != nil {
			return
		}
		defer ws.CloseNow()
		ctx := r.Context()
		challenge := make([]byte, noise.ChallengeLen)
		_, _ = rand.Read(challenge)
		if err := ws.Write(ctx, websocket.MessageBinary, challenge); err != nil {
			return
		}
		res, err := noise.NewResponder(serverKey, challenge)
		if err != nil {
			return
		}
		_, m1, err := ws.Read(ctx)
		if err != nil {
			return
		}
		payload, _, err := res.ReadInit(m1)
		if err != nil {
			return
		}
		var init protocol.HandshakeInit
		if err := protocol.Unmarshal(payload, &init); err != nil {
			return
		}
		resp := &protocol.HandshakeResponse{
			ProtocolMajor: protocol.ProtocolMajor,
			ProtocolMinor: protocol.ProtocolMinor,
			Commands:      protocol.SupportedNames(),
			ConnectionID:  "conn-1",
			ServerTimeMS:  protocol.Int(time.Now().UnixMilli()),
			NodeState:     cfg.nodeState,
			NodeID:        "node-1",
		}
		respPayload, err := protocol.Marshal(resp)
		if err != nil {
			return
		}
		m2, session, err := res.WriteResponse(respPayload)
		if err != nil {
			return
		}
		if err := ws.Write(ctx, websocket.MessageBinary, m2); err != nil {
			return
		}

		peer := protocol.NewPeer(func(frame []byte) error {
			if cfg.sent != nil {
				if f, err := protocol.DecodeFrame(frame); err == nil {
					cfg.sent(f)
				}
			}
			ct, err := session.Encrypt(frame)
			if err != nil {
				return err
			}
			return ws.Write(ctx, websocket.MessageBinary, ct)
		}, protocol.SupportedSet().Intersect(protocol.NewSet(init.Commands...)))
		registerCore(peer)
		cfg.setup(peer)
		if cfg.run != nil {
			go cfg.run(ctx, peer)
		}
		for {
			_, ct, err := ws.Read(ctx)
			if err != nil {
				return
			}
			pt, err := session.Decrypt(ct)
			if err != nil {
				return
			}
			frame, err := protocol.DecodeFrame(pt)
			if err != nil {
				return
			}
			if cfg.log != nil {
				cfg.log.add(frame)
			}
			if err := peer.Receive(pt); err != nil {
				return
			}
		}
	}))
	t.Cleanup(srv.Close)
	return srv
}

// registerCore answers the commands and consumes the events every test may see.
func registerCore(peer *protocol.Peer) {
	peer.HandleRequest(protocol.CmdHello, func(context.Context, cbor.RawMessage) (any, error) {
		return protocol.Welcome{}, nil
	})
	peer.HandleRequest(protocol.CmdPing, func(_ context.Context, body cbor.RawMessage) (any, error) {
		var ping protocol.Ping
		if err := protocol.Unmarshal(body, &ping); err != nil {
			return nil, err
		}
		return ping, nil
	})
	peer.HandleEvent(protocol.EventTaskOutput, func(body cbor.RawMessage) error {
		var out protocol.TaskOutput
		return protocol.Unmarshal(body, &out)
	})
	peer.HandleEvent(protocol.EventTaskExit, func(body cbor.RawMessage) error {
		var exit protocol.TaskExit
		return protocol.Unmarshal(body, &exit)
	})
}

func signal(ch chan struct{}) {
	select {
	case <-ch:
	default:
		close(ch)
	}
}

func waitCh[T any](t *testing.T, ch <-chan T, what string) T {
	t.Helper()
	select {
	case v := <-ch:
		return v
	case <-time.After(10 * time.Second):
		t.Fatalf("timed out waiting for %s", what)
		var zero T
		return zero
	}
}

func wsURL(srv *httptest.Server) string {
	return "ws" + strings.TrimPrefix(srv.URL, "http") + "/agent"
}

func dialTo(t *testing.T, srv *httptest.Server, serverKey noise.Keypair) *transport.Conn {
	t.Helper()
	clientKey, err := noise.GenerateKeypair()
	if err != nil {
		t.Fatal(err)
	}
	conn, err := transport.Dial(context.Background(), transport.DialOptions{
		URL:          wsURL(srv),
		Identity:     clientKey,
		ServerPublic: serverKey.Public,
		Init:         &protocol.HandshakeInit{CRHAVersion: "test"},
	})
	if err != nil {
		t.Fatal(err)
	}
	return conn
}

func newTestAgent(t *testing.T, opts Options) *Agent {
	t.Helper()
	if opts.Facts == nil {
		opts.Facts = func() protocol.Facts { return protocol.Facts{Hostname: "test-node"} }
	}
	if opts.OutputDir == "" {
		opts.OutputDir = t.TempDir()
	}
	if opts.Logger == nil {
		opts.Logger = slog.New(slog.NewTextHandler(io.Discard, nil))
	}
	return New(opts)
}

// startSession runs a.session in the background until the test stops it, and reports when it has
// returned (its deferred work, such as launching accepted tasks, has run by then). The cleanup
// stops the session if the test did not.
func startSession(t *testing.T, a *Agent, conn *transport.Conn) (stop context.CancelFunc, finished <-chan struct{}) {
	t.Helper()
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() {
		_ = a.session(ctx, conn)
		close(done)
	}()
	t.Cleanup(func() {
		cancel()
		select {
		case <-done:
		case <-time.After(10 * time.Second):
			t.Error("session did not stop")
		}
	})
	return cancel, done
}

// taskProgress reports whether the agent still holds a task and whether it was launched.
func taskProgress(a *Agent, id string) (present, started bool) {
	a.mu.Lock()
	defer a.mu.Unlock()
	t, ok := a.tasks[id]
	if !ok {
		return false, false
	}
	return true, t.started
}

func helloHasTask(h protocol.Hello, id string) bool {
	for _, st := range h.Tasks {
		if st.TaskID == id {
			return true
		}
	}
	return false
}

// countLines counts the lines of path, treating a missing file as empty.
func countLines(t *testing.T, path string) int {
	t.Helper()
	data, err := os.ReadFile(path)
	if err != nil {
		if os.IsNotExist(err) {
			return 0
		}
		t.Fatal(err)
	}
	return strings.Count(string(data), "\n")
}

func execTask(id, shell string) protocol.TaskStart {
	return protocol.TaskStart{
		TaskID:  id,
		Attempt: 1,
		Spec: protocol.TaskSpec{Kind: protocol.TaskSpecExec, Exec: &protocol.ExecSpec{
			Command: protocol.Command{Kind: protocol.CommandShell, Shell: shell},
		}},
		Output: protocol.OutputMode{Kind: protocol.OutputFull, SpillBytes: 1 << 20, SpillLines: 2000},
	}
}

// execTaskMode is execTask with a different output mode.
func execTaskMode(id, shell string, mode protocol.OutputMode) protocol.TaskStart {
	t := execTask(id, shell)
	t.Output = mode
	return t
}

// TestBatchOutputModes covers the batch output rules from doc/execution-plane.md#输出: "text" and
// "status" always create the node output file, "status" never sends task.output, and single-task
// "full" keeps small output in memory.
func TestBatchOutputModes(t *testing.T) {
	for _, tc := range []struct {
		name       string
		mode       protocol.OutputMode
		wantOutput bool
		wantFile   bool
	}{
		{"full", protocol.OutputMode{Kind: protocol.OutputFull, SpillBytes: 1 << 20, SpillLines: 2000}, true, false},
		{"text", protocol.OutputMode{Kind: protocol.OutputText}, true, true},
		{"status", protocol.OutputMode{Kind: protocol.OutputStatus}, false, true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			serverKey, err := noise.GenerateKeypair()
			if err != nil {
				t.Fatal(err)
			}
			dir := t.TempDir()
			id := "batch-" + tc.name
			log := &frameLog{}
			exitCh := make(chan protocol.TaskExit, 1)
			factsReady := make(chan struct{})
			srv := startFake(t, serverKey, fakeConfig{
				log: log,
				setup: func(p *protocol.Peer) {
					p.HandleEvent(protocol.EventFacts, func(body cbor.RawMessage) error {
						var f protocol.Facts
						if err := protocol.Unmarshal(body, &f); err != nil {
							return err
						}
						signal(factsReady)
						return nil
					})
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
				run: func(ctx context.Context, p *protocol.Peer) {
					<-factsReady
					var empty protocol.Empty
					if err := p.Request(ctx, protocol.CmdTaskStart,
						execTaskMode(id, "printf out; printf oops >&2", tc.mode), &empty); err != nil {
						t.Errorf("task.start: %v", err)
					}
				},
			})
			a := newTestAgent(t, Options{OutputDir: dir})
			startSession(t, a, dialTo(t, srv, serverKey))

			exit := waitCh(t, exitCh, "task.exit")
			if exit.TaskID != id {
				t.Fatalf("task.exit = %+v", exit)
			}
			if exit.Outcome.Kind != protocol.OutcomeCode || exit.Outcome.Code != 0 {
				t.Fatalf("task.exit outcome = %+v, want code 0", exit.Outcome)
			}
			if exit.StdoutEnd != 3 || exit.StderrEnd != 4 {
				t.Fatalf("ends = %d/%d, want 3/4", exit.StdoutEnd, exit.StderrEnd)
			}
			wantPath := filepath.Join(dir, id+".log")
			if !tc.wantFile {
				if exit.OutputFile != "" {
					t.Fatalf("output_file = %q, want empty for small in-memory output", exit.OutputFile)
				}
			} else {
				if exit.OutputFile != wantPath {
					t.Fatalf("output_file = %q, want %q", exit.OutputFile, wantPath)
				}
				data, err := os.ReadFile(wantPath)
				if err != nil {
					t.Fatal(err)
				}
				if len(data) != 7 || !strings.Contains(string(data), "out") || !strings.Contains(string(data), "oops") {
					t.Fatalf("output file = %q, want stdout and stderr interleaved", data)
				}
			}
			entries, err := os.ReadDir(dir)
			if err != nil {
				t.Fatal(err)
			}
			files := 0
			for _, e := range entries {
				if strings.HasSuffix(e.Name(), ".log") {
					files++
				}
			}
			wantFiles := 0
			if tc.wantFile {
				wantFiles = 1
			}
			if files != wantFiles {
				t.Fatalf("%d output files, want %d", files, wantFiles)
			}
			frames := log.snapshot()
			if sent := indexOf(frames, "event task.output") >= 0; sent != tc.wantOutput {
				t.Fatalf("task.output sent = %v, want %v (frames: %v)", sent, tc.wantOutput, frames)
			}

			// Hello keeps reporting the real stream ends in every mode, including "status".
			hello := a.hello()
			found := false
			for _, st := range hello.Tasks {
				if st.TaskID == id {
					found = true
					if st.StdoutEnd != 3 || st.StderrEnd != 4 {
						t.Fatalf("hello ends = %d/%d, want 3/4", st.StdoutEnd, st.StderrEnd)
					}
				}
			}
			if !found {
				t.Fatalf("hello does not list %s: %+v", id, hello.Tasks)
			}
		})
	}
}

func TestTaskStartResponsePrecedesEvents(t *testing.T) {
	serverKey, err := noise.GenerateKeypair()
	if err != nil {
		t.Fatal(err)
	}
	factsReady := make(chan struct{})
	exitCh := make(chan protocol.TaskExit, 1)
	log := &frameLog{}
	srv := startFake(t, serverKey, fakeConfig{
		log: log,
		setup: func(p *protocol.Peer) {
			p.HandleEvent(protocol.EventFacts, func(body cbor.RawMessage) error {
				var f protocol.Facts
				if err := protocol.Unmarshal(body, &f); err != nil {
					return err
				}
				signal(factsReady)
				return nil
			})
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
		run: func(ctx context.Context, p *protocol.Peer) {
			<-factsReady
			var empty protocol.Empty
			if err := p.Request(ctx, protocol.CmdTaskStart, execTask("order-1", "echo hello"), &empty); err != nil {
				t.Errorf("task.start: %v", err)
			}
		},
	})
	a := newTestAgent(t, Options{})
	startSession(t, a, dialTo(t, srv, serverKey))

	if exit := waitCh(t, exitCh, "task.exit"); exit.TaskID != "order-1" {
		t.Fatalf("task.exit = %+v", exit)
	}
	frames := log.snapshot()
	start := indexOf(frames, "response task.start ok=true")
	output := indexOf(frames, "event task.output")
	exit := indexOf(frames, "event task.exit")
	if start < 0 || output < 0 || exit < 0 {
		t.Fatalf("frames = %v", frames)
	}
	if start > output || start > exit {
		t.Fatalf("task events preceded the accepted response: %v", frames)
	}
}

// TestTaskStartWithLostResponseIsExecuted covers the task.start rule in doc/protocol.md: a task
// recorded in the accepted set whose success response could not be sent (the connection dropped at
// that instant) is still executed. crhs does not resend it; it sees the task in the next hello and
// receives its output and task.exit there.
func TestTaskStartWithLostResponseIsExecuted(t *testing.T) {
	serverKey, err := noise.GenerateKeypair()
	if err != nil {
		t.Fatal(err)
	}
	a := newTestAgent(t, Options{})

	// Reproduce the lost response with the peer a session builds: hand it a task.start request
	// whose response cannot be delivered because its connection is already closed. Peer accepts the
	// task but never calls Deferred.After, leaving exactly the state of a send failure on a live
	// session: the task is in a.tasks, unstarted, and in the accepted set.
	deadServer := startFake(t, serverKey, fakeConfig{})
	dead := dialTo(t, deadServer, serverKey)
	if err := dead.Close("response lost"); err != nil {
		t.Fatalf("close dead connection: %v", err)
	}
	peer := a.newPeer(context.Background(), dead, &nodeStatus{}, true)
	body, err := protocol.Marshal(execTask("lost-1", "echo hello"))
	if err != nil {
		t.Fatal(err)
	}
	frame, err := (&protocol.Frame{
		Kind: protocol.FrameRequest,
		ID:   1,
		Name: protocol.CmdTaskStart,
		Body: body,
	}).Encode()
	if err != nil {
		t.Fatal(err)
	}
	if err := peer.Receive(frame); err == nil {
		t.Fatal("task.start response was delivered on a closed connection")
	}
	if present, started := taskProgress(a, "lost-1"); !present || started {
		t.Fatalf("task after the lost response: present = %v, started = %v, want present and not started", present, started)
	}

	// The accepting connection is gone, so nothing will ever call After for this task. A session
	// that ends runs the deferred sweep, which must start it; crhs then sees it in the next hello.
	seedHello := make(chan protocol.Hello, 1)
	seedServer := startFake(t, serverKey, fakeConfig{
		setup: func(p *protocol.Peer) {
			p.HandleEvent(protocol.EventFacts, func(cbor.RawMessage) error { return nil })
			p.HandleRequest(protocol.CmdHello, func(_ context.Context, body cbor.RawMessage) (any, error) {
				var h protocol.Hello
				if err := protocol.Unmarshal(body, &h); err != nil {
					return nil, err
				}
				seedHello <- h
				return protocol.Welcome{}, nil
			})
		},
	})
	stopSeed, seedDone := startSession(t, a, dialTo(t, seedServer, serverKey))
	hello := waitCh(t, seedHello, "hello after the lost response")
	if !helloHasTask(hello, "lost-1") {
		t.Fatalf("hello after the lost response does not list the task: %+v", hello)
	}
	stopSeed()
	<-seedDone
	if _, started := taskProgress(a, "lost-1"); !started {
		t.Fatal("accepted task was not started when its session ended")
	}

	// The next connection is the reconnect in which crhs learns about the task from hello and
	// receives what it missed: the output and task.exit.
	nextHello := make(chan protocol.Hello, 1)
	outputCh := make(chan string, 8)
	exitCh := make(chan protocol.TaskExit, 1)
	log := &frameLog{}
	nextServer := startFake(t, serverKey, fakeConfig{
		log:  log,
		sent: log.add,
		setup: func(p *protocol.Peer) {
			p.HandleEvent(protocol.EventFacts, func(cbor.RawMessage) error { return nil })
			p.HandleRequest(protocol.CmdHello, func(_ context.Context, body cbor.RawMessage) (any, error) {
				var h protocol.Hello
				if err := protocol.Unmarshal(body, &h); err != nil {
					return nil, err
				}
				nextHello <- h
				return protocol.Welcome{}, nil
			})
			p.HandleEvent(protocol.EventTaskOutput, func(body cbor.RawMessage) error {
				var out protocol.TaskOutput
				if err := protocol.Unmarshal(body, &out); err != nil {
					return err
				}
				if out.TaskID == "lost-1" {
					select {
					case outputCh <- string(out.Data):
					default:
					}
				}
				return nil
			})
			p.HandleEvent(protocol.EventTaskExit, func(body cbor.RawMessage) error {
				var exit protocol.TaskExit
				if err := protocol.Unmarshal(body, &exit); err != nil {
					return err
				}
				if exit.TaskID == "lost-1" {
					select {
					case exitCh <- exit:
					default:
					}
				}
				return nil
			})
		},
	})
	startSession(t, a, dialTo(t, nextServer, serverKey))

	hello = waitCh(t, nextHello, "hello on the connection after the drop")
	if !helloHasTask(hello, "lost-1") {
		t.Fatalf("hello on the next connection does not list the task: %+v", hello)
	}
	var stdout strings.Builder
	for !strings.Contains(stdout.String(), "hello") {
		stdout.WriteString(waitCh(t, outputCh, "task.output"))
	}
	exit := waitCh(t, exitCh, "task.exit")
	if exit.TaskID != "lost-1" {
		t.Fatalf("task.exit = %+v", exit)
	}
	if exit.Outcome.Kind != protocol.OutcomeCode || exit.Outcome.Code != 0 {
		t.Fatalf("task.exit outcome = %+v, want code 0", exit.Outcome)
	}
	frames := log.snapshot()
	helloAt := indexOf(frames, "response hello ok=true")
	outputAt := indexOf(frames, "event task.output")
	exitAt := indexOf(frames, "event task.exit")
	if helloAt < 0 || outputAt < 0 || exitAt < 0 || helloAt > outputAt || helloAt > exitAt {
		t.Fatalf("task events are not after the hello response: %v", frames)
	}
}

// TestTaskStartRunsOnce covers the other side of starting tasks: Deferred.After starts a normally
// accepted task, and the session-end sweep must not start it a second time.
func TestTaskStartRunsOnce(t *testing.T) {
	serverKey, err := noise.GenerateKeypair()
	if err != nil {
		t.Fatal(err)
	}
	runs := filepath.Join(t.TempDir(), "runs")
	task := execTask("once-1", "echo run >> '"+runs+"'")
	factsReady := make(chan struct{})
	startResult := make(chan error, 1)
	exitCh := make(chan protocol.TaskExit, 1)
	srv := startFake(t, serverKey, fakeConfig{
		setup: func(p *protocol.Peer) {
			p.HandleEvent(protocol.EventFacts, func(body cbor.RawMessage) error {
				var f protocol.Facts
				if err := protocol.Unmarshal(body, &f); err != nil {
					return err
				}
				signal(factsReady)
				return nil
			})
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
		run: func(ctx context.Context, p *protocol.Peer) {
			<-factsReady
			var empty protocol.Empty
			startResult <- p.Request(ctx, protocol.CmdTaskStart, task, &empty)
		},
	})
	a := newTestAgent(t, Options{})
	stop, finished := startSession(t, a, dialTo(t, srv, serverKey))

	if err := waitCh(t, startResult, "task.start"); err != nil {
		t.Fatalf("task.start: %v", err)
	}
	if exit := waitCh(t, exitCh, "task.exit"); exit.TaskID != "once-1" {
		t.Fatalf("task.exit = %+v", exit)
	}
	if got := countLines(t, runs); got != 1 {
		t.Fatalf("task ran %d times, want 1", got)
	}
	// End the session: the deferred sweep must skip the task After already started. A second
	// execution would append another line to runs; give such a goroutine time to do it.
	stop()
	<-finished
	if _, started := taskProgress(a, "once-1"); !started {
		t.Fatal("task is not marked as started")
	}
	deadline := time.Now().Add(500 * time.Millisecond)
	for time.Now().Before(deadline) {
		if got := countLines(t, runs); got != 1 {
			t.Fatalf("task ran %d times after its session ended, want 1", got)
		}
		time.Sleep(10 * time.Millisecond)
	}
}

func TestAlreadyAcceptedAfterExitAck(t *testing.T) {
	serverKey, err := noise.GenerateKeypair()
	if err != nil {
		t.Fatal(err)
	}
	factsReady := make(chan struct{})
	exitCh := make(chan struct{}, 1)
	results := make(chan error, 1)
	srv := startFake(t, serverKey, fakeConfig{
		setup: func(p *protocol.Peer) {
			p.HandleEvent(protocol.EventFacts, func(body cbor.RawMessage) error {
				var f protocol.Facts
				if err := protocol.Unmarshal(body, &f); err != nil {
					return err
				}
				signal(factsReady)
				return nil
			})
			p.HandleEvent(protocol.EventTaskExit, func(body cbor.RawMessage) error {
				var exit protocol.TaskExit
				if err := protocol.Unmarshal(body, &exit); err != nil {
					return err
				}
				select {
				case exitCh <- struct{}{}:
				default:
				}
				return nil
			})
		},
		run: func(ctx context.Context, p *protocol.Peer) {
			<-factsReady
			task := execTask("dup-1", "true")
			var empty protocol.Empty
			if err := p.Request(ctx, protocol.CmdTaskStart, task, &empty); err != nil {
				results <- err
				return
			}
			select {
			case <-exitCh:
			case <-ctx.Done():
				results <- ctx.Err()
				return
			}
			if err := p.Emit(protocol.EventTaskExitAck, protocol.TaskExitAck{TaskID: "dup-1"}); err != nil {
				results <- err
				return
			}
			results <- p.Request(ctx, protocol.CmdTaskStart, task, &empty)
		},
	})
	a := newTestAgent(t, Options{})
	startSession(t, a, dialTo(t, srv, serverKey))

	err = waitCh(t, results, "second task.start")
	var remote *protocol.RemoteError
	if !errors.As(err, &remote) || remote.Code != "already_accepted" {
		t.Fatalf("second task.start = %v, want already_accepted", err)
	}
}

func TestTaskStartRejections(t *testing.T) {
	serverKey, err := noise.GenerateKeypair()
	if err != nil {
		t.Fatal(err)
	}
	factsReady := make(chan struct{})
	results := make(chan error, 2)
	srv := startFake(t, serverKey, fakeConfig{
		setup: func(p *protocol.Peer) {
			p.HandleEvent(protocol.EventFacts, func(body cbor.RawMessage) error {
				var f protocol.Facts
				if err := protocol.Unmarshal(body, &f); err != nil {
					return err
				}
				signal(factsReady)
				return nil
			})
		},
		run: func(ctx context.Context, p *protocol.Peer) {
			<-factsReady
			var empty protocol.Empty
			invalid := execTask("", "true")
			results <- p.Request(ctx, protocol.CmdTaskStart, invalid, &empty)
			privileged := execTask("priv-1", "true")
			privileged.Privileged = true
			results <- p.Request(ctx, protocol.CmdTaskStart, privileged, &empty)
		},
	})
	a := newTestAgent(t, Options{})
	startSession(t, a, dialTo(t, srv, serverKey))

	for _, tc := range []struct {
		want string
		name string
	}{
		{"invalid_spec", "empty task id"},
		{"privileged_unsupported", "privileged"},
	} {
		err := waitCh(t, results, tc.name)
		var remote *protocol.RemoteError
		if !errors.As(err, &remote) || remote.Code != tc.want {
			t.Fatalf("%s: task.start = %v, want %s", tc.name, err, tc.want)
		}
	}
}

func TestTaskInputErrorCodes(t *testing.T) {
	serverKey, err := noise.GenerateKeypair()
	if err != nil {
		t.Fatal(err)
	}
	factsReady := make(chan struct{})
	results := make(chan error, 3)
	srv := startFake(t, serverKey, fakeConfig{
		setup: func(p *protocol.Peer) {
			p.HandleEvent(protocol.EventFacts, func(body cbor.RawMessage) error {
				var f protocol.Facts
				if err := protocol.Unmarshal(body, &f); err != nil {
					return err
				}
				signal(factsReady)
				return nil
			})
		},
		run: func(ctx context.Context, p *protocol.Peer) {
			<-factsReady
			data := []byte("abcd")
			sum := sha256.Sum256(data)
			task := execTask("input-1", "cat")
			task.Spec.Exec.Stdin = &protocol.InputRef{Size: protocol.Uint(len(data)), SHA256: protocol.Hash(sum)}
			var empty protocol.Empty
			if err := p.Request(ctx, protocol.CmdTaskStart, task, &empty); err != nil {
				results <- err
				return
			}
			results <- p.Request(ctx, protocol.CmdTaskInput, protocol.TaskInput{
				TaskID: "nope", Offset: 0, Data: []byte("x"),
			}, &empty)
			results <- p.Request(ctx, protocol.CmdTaskInput, protocol.TaskInput{
				TaskID: "input-1", Offset: 2, Data: []byte("x"),
			}, &empty)
			results <- p.Request(ctx, protocol.CmdTaskInput, protocol.TaskInput{
				TaskID: "input-1", Offset: 0, Data: []byte("abcde"),
			}, &empty)
		},
	})
	a := newTestAgent(t, Options{})
	startSession(t, a, dialTo(t, srv, serverKey))

	for _, want := range []string{"unknown_task", "input_out_of_order", "input_too_large"} {
		err := waitCh(t, results, want)
		var remote *protocol.RemoteError
		if !errors.As(err, &remote) || remote.Code != want {
			t.Fatalf("task.input = %v, want %s", err, want)
		}
	}
}

func TestCheckTaskKindUnknown(t *testing.T) {
	err := checkTaskKind(protocol.TaskSpec{Kind: "future"})
	if err == nil || err.Code != "unsupported_kind" {
		t.Fatalf("checkTaskKind = %v", err)
	}
}

func TestAcceptedSetEviction(t *testing.T) {
	old := maxAcceptedTasks
	maxAcceptedTasks = 3
	defer func() { maxAcceptedTasks = old }()

	a := newTestAgent(t, Options{})
	a.mu.Lock()
	for _, id := range []string{"t1", "t2", "t3", "t4"} {
		a.acceptLocked(id)
	}
	_, hasT1 := a.accepted["t1"]
	_, hasT4 := a.accepted["t4"]
	size := len(a.accepted)
	a.mu.Unlock()
	if hasT1 {
		t.Fatal("oldest accepted id was not evicted")
	}
	if !hasT4 || size != maxAcceptedTasks {
		t.Fatalf("accepted = %v, hasT4 = %v", size, hasT4)
	}
}

func TestRunReturnsNodeRejected(t *testing.T) {
	for _, state := range []protocol.NodeState{protocol.NodePending, protocol.NodeActive} {
		t.Run(string(state), func(t *testing.T) {
			serverKey, err := noise.GenerateKeypair()
			if err != nil {
				t.Fatal(err)
			}
			clientKey, err := noise.GenerateKeypair()
			if err != nil {
				t.Fatal(err)
			}
			factsReady := make(chan struct{})
			srv := startFake(t, serverKey, fakeConfig{
				nodeState: state,
				setup: func(p *protocol.Peer) {
					p.HandleEvent(protocol.EventFacts, func(body cbor.RawMessage) error {
						var f protocol.Facts
						if err := protocol.Unmarshal(body, &f); err != nil {
							return err
						}
						signal(factsReady)
						return nil
					})
				},
				run: func(ctx context.Context, p *protocol.Peer) {
					<-factsReady
					_ = p.Emit(protocol.EventNodeStatus, protocol.NodeStatus{
						NodeID: "node-1", State: protocol.NodeStatusRejected, Message: "denied by admin",
					})
				},
			})
			a := newTestAgent(t, Options{
				Dial: func(ctx context.Context) (*transport.Conn, error) {
					return transport.Dial(ctx, transport.DialOptions{
						URL:          wsURL(srv),
						Identity:     clientKey,
						ServerPublic: serverKey.Public,
						Init:         &protocol.HandshakeInit{CRHAVersion: "test"},
					})
				},
			})
			ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
			defer cancel()
			err = a.Run(ctx)
			if !errors.Is(err, ErrNodeRejected) {
				t.Fatalf("Run = %v, want ErrNodeRejected", err)
			}
			if !strings.Contains(err.Error(), "denied by admin") {
				t.Fatalf("Run error %q does not carry crhs's reason", err)
			}
		})
	}
}
