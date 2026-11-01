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
	"unicode/utf8"

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
	// crha reports its trust summary after every hello response and relays the privileged mode's
	// local decisions; a fake crhs must consume them like the real one.
	peer.HandleEvent(protocol.EventTrustSummary, func(body cbor.RawMessage) error {
		var report protocol.TrustReport
		return protocol.Unmarshal(body, &report)
	})
	peer.HandleEvent(protocol.EventLocalDecision, func(body cbor.RawMessage) error {
		var decision protocol.LocalDecision
		return protocol.Unmarshal(body, &decision)
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

// TestTaskExitCarriesFileResult covers a file task that runs on the crha itself: its structured
// result travels in task.exit, and its output streams stay empty (doc/protocol.md TaskResult).
func TestTaskExitCarriesFileResult(t *testing.T) {
	path := filepath.Join(t.TempDir(), "f.txt")
	if err := os.WriteFile(path, []byte("abc"), 0o644); err != nil {
		t.Fatal(err)
	}
	serverKey, err := noise.GenerateKeypair()
	if err != nil {
		t.Fatal(err)
	}
	const id = "stat-1"
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
			ts := protocol.TaskStart{
				TaskID: id, Attempt: 1,
				Spec:   protocol.TaskSpec{Kind: protocol.TaskSpecFileStat, FileStat: &protocol.FileStatSpec{Path: path}},
				Output: protocol.OutputMode{Kind: protocol.OutputFull, SpillBytes: 1 << 20, SpillLines: 2000},
			}
			if err := p.Request(ctx, protocol.CmdTaskStart, ts, &empty); err != nil {
				t.Errorf("task.start: %v", err)
			}
		},
	})
	a := newTestAgent(t, Options{})
	startSession(t, a, dialTo(t, srv, serverKey))

	exit := waitCh(t, exitCh, "task.exit")
	if exit.TaskID != id || exit.Outcome.Kind != protocol.OutcomeCode || exit.Outcome.Code != 0 {
		t.Fatalf("task.exit = %+v", exit)
	}
	if exit.Result == nil || exit.Result.Kind != protocol.TaskResultFileStat || exit.Result.FileStat == nil {
		t.Fatalf("task.exit result = %+v", exit.Result)
	}
	if st := exit.Result.FileStat; st.Path != path || st.Size != 3 || st.Type != "file" {
		t.Fatalf("file.stat result = %+v", st)
	}
	// The stat carries no stdout, and nothing at all was written to stderr.
	if exit.StdoutEnd != 0 || exit.StderrEnd != 0 {
		t.Fatalf("ends = %d/%d, want 0/0", exit.StdoutEnd, exit.StderrEnd)
	}
	for _, frame := range log.snapshot() {
		if frame == "event task.output" {
			t.Fatalf("a file.stat task sent task.output: %v", log.snapshot())
		}
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
	// whose response cannot be delivered because its connection is already closed. The peer
	// accepts the task but never calls Deferred.After, leaving exactly the state of a send failure
	// on a live session: the task is in a.tasks, unstarted, and in the accepted set.
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
	// The request worker handles the request; the response send fails there and the peer closes,
	// so Receive returns before the handler ran.
	if err := peer.Receive(frame); err != nil {
		t.Fatalf("Receive: %v", err)
	}
	deadline := time.Now().Add(5 * time.Second)
	for {
		present, started := taskProgress(a, "lost-1")
		if present {
			if started {
				t.Fatal("task was started although its response could not be sent")
			}
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("task after the lost response was not accepted")
		}
		time.Sleep(5 * time.Millisecond)
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

// TestExecInputMismatchFailsTask covers an exec task whose input does not match its InputRef. The
// process may already have consumed the truncated stdin and exited successfully; the task must fail
// as input_mismatch instead of reporting that exit code.
func TestExecInputMismatchFailsTask(t *testing.T) {
	serverKey, err := noise.GenerateKeypair()
	if err != nil {
		t.Fatal(err)
	}
	factsReady := make(chan struct{})
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
			// The declared hash belongs to different bytes, so "abcd" + "efgh" complete the
			// declared size and fail the check.
			wrong := sha256.Sum256([]byte("01234567"))
			task := execTask("mismatch-1", "wc -c")
			task.Spec.Exec.Stdin = &protocol.InputRef{Size: 8, SHA256: protocol.Hash(wrong)}
			var empty protocol.Empty
			if err := p.Request(ctx, protocol.CmdTaskStart, task, &empty); err != nil {
				t.Errorf("task.start: %v", err)
				return
			}
			for i, chunk := range []string{"abcd", "efgh"} {
				err := p.Request(ctx, protocol.CmdTaskInput, protocol.TaskInput{
					TaskID: "mismatch-1", Offset: protocol.Uint(i * 4), Data: []byte(chunk),
				}, &empty)
				if err != nil {
					t.Errorf("task.input %q: %v", chunk, err)
					return
				}
			}
		},
	})
	a := newTestAgent(t, Options{})
	startSession(t, a, dialTo(t, srv, serverKey))

	exit := waitCh(t, exitCh, "task.exit")
	if exit.Outcome.Kind != protocol.OutcomeError || exit.Outcome.Error == nil {
		t.Fatalf("task.exit outcome = %+v, want an error outcome", exit.Outcome)
	}
	if exit.Outcome.Error.Code != "input_mismatch" {
		t.Fatalf("task.exit error code = %q, want input_mismatch", exit.Outcome.Error.Code)
	}
	if exit.Cancelled {
		t.Fatal("input_mismatch task.exit is marked cancelled")
	}
}

// TestExecInputIncompleteOnDisconnect covers a connection that drops while task.input chunks are
// still to come: the input cannot be resumed, so the running task is killed and exits with
// input_incomplete instead of waiting forever for a reader to finish.
func TestExecInputIncompleteOnDisconnect(t *testing.T) {
	serverKey, err := noise.GenerateKeypair()
	if err != nil {
		t.Fatal(err)
	}
	content := []byte("0123456789")
	sum := sha256.Sum256(content)
	factsReady := make(chan struct{})
	halfSent := make(chan struct{})
	firstSrv := startFake(t, serverKey, fakeConfig{
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
			task := execTask("incomplete-1", "cat")
			task.Spec.Exec.Stdin = &protocol.InputRef{Size: protocol.Uint(len(content)), SHA256: protocol.Hash(sum)}
			var empty protocol.Empty
			if err := p.Request(ctx, protocol.CmdTaskStart, task, &empty); err != nil {
				t.Errorf("task.start: %v", err)
				return
			}
			if err := p.Request(ctx, protocol.CmdTaskInput, protocol.TaskInput{
				TaskID: "incomplete-1", Offset: 0, Data: content[:5],
			}, &empty); err != nil {
				t.Errorf("task.input: %v", err)
				return
			}
			signal(halfSent)
		},
	})
	a := newTestAgent(t, Options{})
	firstConn := dialTo(t, firstSrv, serverKey)
	_, firstDone := startSession(t, a, firstConn)
	waitCh(t, halfSent, "the first half of the input")

	// Drop the connection with five bytes still missing. crhs sends the start only once, so the
	// input cannot be resumed; the task must fail rather than wait for chunks that never come.
	if err := firstConn.Close("input dropped"); err != nil {
		t.Fatalf("close: %v", err)
	}
	<-firstDone // the session's deferred sweep has run
	if st := a.hello(); !helloHasTask(st, "incomplete-1") {
		t.Fatalf("hello after the drop does not list the task: %+v", st)
	}

	// task.exit can only be delivered on the next connection, where crhs learns about the task from
	// hello and receives its output and exit.
	helloCh := make(chan protocol.Hello, 1)
	exitCh := make(chan protocol.TaskExit, 1)
	nextSrv := startFake(t, serverKey, fakeConfig{
		setup: func(p *protocol.Peer) {
			p.HandleEvent(protocol.EventFacts, func(cbor.RawMessage) error { return nil })
			p.HandleRequest(protocol.CmdHello, func(_ context.Context, body cbor.RawMessage) (any, error) {
				var h protocol.Hello
				if err := protocol.Unmarshal(body, &h); err != nil {
					return nil, err
				}
				helloCh <- h
				return protocol.Welcome{}, nil
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
	})
	startSession(t, a, dialTo(t, nextSrv, serverKey))

	hello := waitCh(t, helloCh, "hello after the input drop")
	if !helloHasTask(hello, "incomplete-1") {
		t.Fatalf("hello after the input drop does not list the task: %+v", hello)
	}
	exit := waitCh(t, exitCh, "task.exit")
	if exit.TaskID != "incomplete-1" {
		t.Fatalf("task.exit = %+v", exit)
	}
	if exit.Outcome.Kind != protocol.OutcomeError || exit.Outcome.Error == nil {
		t.Fatalf("task.exit outcome = %+v, want an error outcome", exit.Outcome)
	}
	if exit.Outcome.Error.Code != "input_incomplete" {
		t.Fatalf("task.exit error code = %q, want input_incomplete", exit.Outcome.Error.Code)
	}
}

// TestFileWriteCancelUnblocksInput covers task.cancel while a file.write waits for the rest of its
// content: the cancellation must reach the blocked reader, and the task must still exit as
// cancelled.
func TestFileWriteCancelUnblocksInput(t *testing.T) {
	serverKey, err := noise.GenerateKeypair()
	if err != nil {
		t.Fatal(err)
	}
	content := []byte("hello, world")
	sum := sha256.Sum256(content)
	path := filepath.Join(t.TempDir(), "out.txt")
	factsReady := make(chan struct{})
	halfSent := make(chan struct{})
	cancelResult := make(chan error, 1)
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
			task := protocol.TaskStart{
				TaskID:  "write-1",
				Attempt: 1,
				Spec: protocol.TaskSpec{Kind: protocol.TaskSpecFileWrite, FileWrite: &protocol.FileWriteSpec{
					Path:    path,
					Content: protocol.InputRef{Size: protocol.Uint(len(content)), SHA256: protocol.Hash(sum)},
				}},
				Output: protocol.OutputMode{Kind: protocol.OutputFull, SpillBytes: 1 << 20, SpillLines: 2000},
			}
			var empty protocol.Empty
			if err := p.Request(ctx, protocol.CmdTaskStart, task, &empty); err != nil {
				t.Errorf("task.start: %v", err)
				return
			}
			if err := p.Request(ctx, protocol.CmdTaskInput, protocol.TaskInput{
				TaskID: "write-1", Offset: 0, Data: content[:5],
			}, &empty); err != nil {
				t.Errorf("task.input: %v", err)
				return
			}
			signal(halfSent)
			cancelResult <- p.Request(ctx, protocol.CmdTaskCancel, protocol.TaskCancel{TaskID: "write-1"}, &empty)
		},
	})
	a := newTestAgent(t, Options{})
	startSession(t, a, dialTo(t, srv, serverKey))

	waitCh(t, halfSent, "the first half of the file content")
	if err := waitCh(t, cancelResult, "task.cancel"); err != nil {
		t.Fatalf("task.cancel: %v", err)
	}
	exit := waitCh(t, exitCh, "task.exit")
	if exit.TaskID != "write-1" {
		t.Fatalf("task.exit = %+v", exit)
	}
	if !exit.Cancelled {
		t.Fatal("cancelled file.write exit is not marked cancelled")
	}
	if exit.Outcome.Kind != protocol.OutcomeError || exit.Outcome.Error == nil || exit.Outcome.Error.Code != "cancelled" {
		t.Fatalf("task.exit outcome = %+v, want error cancelled", exit.Outcome)
	}
	if _, err := os.Stat(path); !os.IsNotExist(err) {
		t.Fatalf("cancelled file.write published %s (stat: %v)", path, err)
	}
}

// TestTaskStartZeroSizeInput covers the InputRef of size 0: a wrong sha256 can never match, so
// task.start is refused, while the sha256 of empty input is accepted and the task runs with an
// already closed input.
func TestTaskStartZeroSizeInput(t *testing.T) {
	serverKey, err := noise.GenerateKeypair()
	if err != nil {
		t.Fatal(err)
	}
	factsReady := make(chan struct{})
	startErr := make(chan error, 1)
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
			wrong := execTask("zero-bad", "true")
			wrong.Spec.Exec.Stdin = &protocol.InputRef{Size: 0, SHA256: protocol.Hash(sha256.Sum256([]byte("x")))}
			startErr <- p.Request(ctx, protocol.CmdTaskStart, wrong, &empty)

			ok := execTask("zero-ok", "cat")
			ok.Spec.Exec.Stdin = &protocol.InputRef{Size: 0, SHA256: protocol.Hash(sha256.Sum256(nil))}
			if err := p.Request(ctx, protocol.CmdTaskStart, ok, &empty); err != nil {
				t.Errorf("task.start with empty input: %v", err)
			}
		},
	})
	a := newTestAgent(t, Options{})
	startSession(t, a, dialTo(t, srv, serverKey))

	err = waitCh(t, startErr, "task.start with a bad empty input")
	var remote *protocol.RemoteError
	if !errors.As(err, &remote) || remote.Code != "invalid_spec" {
		t.Fatalf("task.start with a bad empty input = %v, want invalid_spec", err)
	}
	exit := waitCh(t, exitCh, "task.exit")
	if exit.TaskID != "zero-ok" {
		t.Fatalf("task.exit = %+v", exit)
	}
	if exit.Outcome.Kind != protocol.OutcomeCode || exit.Outcome.Code != 0 {
		t.Fatalf("task.exit outcome = %+v, want code 0", exit.Outcome)
	}
}

// TestInputDoesNotBlockReceiveLoop covers push never blocking: a process that never reads stdin
// leaves the input undrained, and many small chunks must not freeze the receive loop (and with it
// a.mu, which task.query also needs). Two 48 KiB chunks fill the process's stdin pipe, then the
// 1-byte chunks exceed the queue's buffer if the reader stopped.
func TestInputDoesNotBlockReceiveLoop(t *testing.T) {
	serverKey, err := noise.GenerateKeypair()
	if err != nil {
		t.Fatal(err)
	}
	factsReady := make(chan struct{})
	queryResult := make(chan error, 1)
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
			const declared = 1 << 20
			task := execTask("no-read-1", "sleep 30")
			task.Spec.Exec.Stdin = &protocol.InputRef{
				Size:   declared,
				SHA256: protocol.Hash(sha256.Sum256(make([]byte, declared))),
			}
			var empty protocol.Empty
			if err := p.Request(ctx, protocol.CmdTaskStart, task, &empty); err != nil {
				t.Errorf("task.start: %v", err)
				return
			}
			var off protocol.Uint
			send := func(data []byte) error {
				err := p.Request(ctx, protocol.CmdTaskInput, protocol.TaskInput{
					TaskID: "no-read-1", Offset: off, Data: data,
				}, &empty)
				off += protocol.Uint(len(data))
				return err
			}
			for range 2 {
				if err := send(make([]byte, 48<<10)); err != nil {
					t.Errorf("task.input: %v", err)
					return
				}
			}
			for range 200 {
				if err := send([]byte{0}); err != nil {
					t.Errorf("task.input: %v", err)
					return
				}
			}
			qctx, cancel := context.WithTimeout(ctx, 5*time.Second)
			defer cancel()
			var st protocol.TaskStatus
			queryResult <- p.Request(qctx, protocol.CmdTaskQuery, protocol.TaskQuery{TaskID: "no-read-1"}, &st)
		},
	})
	a := newTestAgent(t, Options{})
	startSession(t, a, dialTo(t, srv, serverKey))

	if err := waitCh(t, queryResult, "task.query while the input is undrained"); err != nil {
		t.Fatalf("task.query while the input is undrained: %v", err)
	}
}

// TestTaskExitWithOversizedErrorIsEmitted covers the sender-side bound on Error.message: a task
// failure that quotes a very long path must still produce a task.exit that fits in one frame,
// instead of failing to encode and ending the connection.
func TestTaskExitWithOversizedErrorIsEmitted(t *testing.T) {
	serverKey, err := noise.GenerateKeypair()
	if err != nil {
		t.Fatal(err)
	}
	factsReady := make(chan struct{})
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
			task := protocol.TaskStart{
				TaskID:  "big-path",
				Attempt: 1,
				Spec: protocol.TaskSpec{Kind: protocol.TaskSpecFileRead, FileRead: &protocol.FileReadSpec{
					// A relative path is rejected immediately; quoting it makes the error
					// message far larger than MaxErrorMessageBytes.
					Path:      strings.Repeat("\x01", 15400),
					StartLine: 1,
					LineCount: 1,
				}},
				Output: protocol.OutputMode{Kind: protocol.OutputFull, SpillBytes: 1 << 20, SpillLines: 2000},
			}
			var empty protocol.Empty
			if err := p.Request(ctx, protocol.CmdTaskStart, task, &empty); err != nil {
				t.Errorf("task.start: %v", err)
			}
		},
	})
	a := newTestAgent(t, Options{})
	startSession(t, a, dialTo(t, srv, serverKey))

	exit := waitCh(t, exitCh, "task.exit")
	if exit.TaskID != "big-path" {
		t.Fatalf("task.exit = %+v", exit)
	}
	if exit.Outcome.Kind != protocol.OutcomeError || exit.Outcome.Error == nil {
		t.Fatalf("outcome = %+v, want an error outcome", exit.Outcome)
	}
	if exit.Outcome.Error.Code != "invalid_spec" {
		t.Fatalf("outcome error code = %q, want invalid_spec", exit.Outcome.Error.Code)
	}
	if got := len(exit.Outcome.Error.Message); got == 0 || got > protocol.MaxErrorMessageBytes {
		t.Fatalf("outcome message has %d bytes, want at most %d", got, protocol.MaxErrorMessageBytes)
	}
	if !utf8.ValidString(exit.Outcome.Error.Message) {
		t.Fatal("outcome message is not valid UTF-8")
	}
}

// TestSendReplacesUnencodableTaskExit covers the pump fallback: a task.exit that cannot be encoded
// is retried with an internal_error outcome instead of ending the session.
func TestSendReplacesUnencodableTaskExit(t *testing.T) {
	frames := make(chan []byte, 1)
	peer := protocol.NewPeer(func(frame []byte) error {
		frames <- frame
		return nil
	}, protocol.NewSet(protocol.EventTaskExit))
	a := newTestAgent(t, Options{})

	exit := &protocol.TaskExit{
		TaskID:  "t1",
		Outcome: protocol.Outcome{Kind: protocol.OutcomeSignal, Signal: "\xff"},
	}
	if err := a.send(peer, &outbound{name: protocol.EventTaskExit, body: exit}); err != nil {
		t.Fatalf("send: %v", err)
	}
	frame, err := protocol.DecodeFrame(waitCh(t, frames, "task.exit frame"))
	if err != nil {
		t.Fatalf("DecodeFrame: %v", err)
	}
	var got protocol.TaskExit
	if err := protocol.Unmarshal(frame.Body, &got); err != nil {
		t.Fatalf("Unmarshal: %v", err)
	}
	if got.Outcome.Kind != protocol.OutcomeError || got.Outcome.Error == nil ||
		got.Outcome.Error.Code != "internal_error" {
		t.Fatalf("outcome = %+v, want the internal_error fallback", got.Outcome)
	}
	select {
	case extra := <-frames:
		t.Fatalf("unexpected extra frame %x", extra)
	default:
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

// TestAcceptedSetKeepsRunningTasks covers the eviction rule: an id whose task is still held is never
// evicted, and a re-sent task.start for it is refused. Evicting it would let the duplicate overwrite
// the running task in a.tasks, and the task would be executed twice.
func TestAcceptedSetKeepsRunningTasks(t *testing.T) {
	old := maxAcceptedTasks
	maxAcceptedTasks = 2
	defer func() { maxAcceptedTasks = old }()

	a := newTestAgent(t, Options{})
	ctx := context.Background()
	startTask := func(id, shell string) (any, error) {
		ts := execTask(id, shell)
		return a.start(ctx, &ts)
	}
	if _, err := startTask("live", "sleep 30"); err != nil {
		t.Fatal(err)
	}
	if _, err := startTask("done", "true"); err != nil {
		t.Fatal(err)
	}
	a.mu.Lock()
	live := a.tasks["live"]
	// A finished task whose exit was acknowledged leaves a.tasks but stays in the accepted set;
	// that id is the one the next accepts may evict.
	delete(a.tasks, "done")
	a.mu.Unlock()

	// Filling the set past the limit must skip the running task and evict the finished one.
	if _, err := startTask("next", "true"); err != nil {
		t.Fatal(err)
	}
	a.mu.Lock()
	_, liveAccepted := a.accepted["live"]
	_, doneAccepted := a.accepted["done"]
	size := len(a.accepted)
	a.mu.Unlock()
	if !liveAccepted {
		t.Fatal("the accepted id of a running task was evicted")
	}
	if doneAccepted {
		t.Fatal("the accepted id of a finished task was not evicted")
	}
	if size != maxAcceptedTasks {
		t.Fatalf("accepted set has %d ids, want %d", size, maxAcceptedTasks)
	}

	// The same id cannot be accepted again while its task is held.
	_, err := startTask("live", "true")
	var remote *protocol.RemoteError
	if !errors.As(err, &remote) || remote.Code != "already_accepted" {
		t.Fatalf("re-sent task.start = %v, want already_accepted", err)
	}
	a.mu.Lock()
	still := a.tasks["live"]
	a.mu.Unlock()
	if still != live {
		t.Fatal("the running task was overwritten by the duplicate")
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

// recordHandler keeps the log records of a test.
type recordHandler struct {
	mu      sync.Mutex
	records []slog.Record
}

func (h *recordHandler) Enabled(context.Context, slog.Level) bool { return true }

func (h *recordHandler) Handle(_ context.Context, record slog.Record) error {
	h.mu.Lock()
	defer h.mu.Unlock()
	h.records = append(h.records, record)
	return nil
}

func (h *recordHandler) WithAttrs([]slog.Attr) slog.Handler { return h }
func (h *recordHandler) WithGroup(string) slog.Handler      { return h }

func (h *recordHandler) all() []slog.Record {
	h.mu.Lock()
	defer h.mu.Unlock()
	return append([]slog.Record(nil), h.records...)
}

// TestClockWarn covers the clock offset warning of doc/privilege.md 时钟: an offset beyond
// clock_warn is logged with the offset and the threshold, and 0 disables the warning.
func TestClockWarn(t *testing.T) {
	handler := &recordHandler{}
	a := newTestAgent(t, Options{Logger: slog.New(handler), ClockWarn: 5 * time.Second})

	a.checkClock(&transport.Conn{ClockOffset: -10 * time.Second})
	records := handler.all()
	if len(records) != 1 || records[0].Level != slog.LevelWarn {
		t.Fatalf("records = %+v, want one warning", records)
	}
	attrs := map[string]string{}
	records[0].Attrs(func(attr slog.Attr) bool {
		attrs[attr.Key] = attr.Value.String()
		return true
	})
	if attrs["offset"] != "-10s" || attrs["threshold"] != "5s" {
		t.Fatalf("warning attributes = %v, want the offset and the threshold", attrs)
	}
	if !strings.Contains(records[0].Message, "clock") {
		t.Fatalf("message = %q", records[0].Message)
	}

	a.checkClock(&transport.Conn{ClockOffset: 5 * time.Second})
	a.checkClock(&transport.Conn{ClockOffset: -4 * time.Second})
	if got := len(handler.all()); got != 1 {
		t.Fatalf("%d warnings for offsets within the threshold", got)
	}

	a.opts.ClockWarn = 0
	a.checkClock(&transport.Conn{ClockOffset: time.Hour})
	if got := len(handler.all()); got != 1 {
		t.Fatalf("%d warnings with clock_warn = 0", got)
	}
}
