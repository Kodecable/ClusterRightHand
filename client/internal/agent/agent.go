// Package agent is crha's non-privileged mode: it keeps a connection to crhs, runs tasks, streams their
// output and resumes after reconnects. It never replays a task: a task id it does not hold is unknown.
// See doc/execution-plane.md.
package agent

import (
	"bytes"
	"context"
	"crypto/sha256"
	"errors"
	"fmt"
	"hash"
	"io"
	"log/slog"
	"math/rand/v2"
	"sync"
	"time"

	"github.com/Kodecable/ClusterRightHand/client/internal/executor"
	"github.com/Kodecable/ClusterRightHand/client/internal/proto/crhv1"
	"github.com/Kodecable/ClusterRightHand/client/internal/transport"
)

const (
	outputChunk     = 32 << 10
	pingInterval    = 30 * time.Second
	idleTimeout     = 90 * time.Second
	maxConnLifetime = 24 * time.Hour // instead of Noise rekeying
	minBackoff      = time.Second
	maxBackoff      = time.Minute
)

// Options configure the agent. Dial is called for every connection attempt.
type Options struct {
	Dial      func(ctx context.Context) (*transport.Conn, error)
	Facts     func() *crhv1.Facts
	Version   string
	OutputDir string
	Logger    *slog.Logger
	// PrivilegedMode is reported in Hello; privileged tasks are rejected until M4.
	PrivilegedMode string
}

type Agent struct {
	opts Options
	log  *slog.Logger

	mu    sync.Mutex
	tasks map[string]*task
	kick  chan struct{}
}

type task struct {
	id     string
	spec   *crhv1.TaskStart
	output *executor.Output
	cancel context.CancelFunc

	// TaskInput chunks for the executor (stdin or file content), fed by a goroutine so that a slow
	// reader never blocks the receive loop.
	inputCh   chan []byte
	inputOff  uint64
	inputSize uint64
	inputHash []byte
	hasher    hash.Hash

	done   bool
	result *crhv1.TaskExit

	// Per connection: how far output has been sent, and whether TaskExit went out.
	sent     [3]uint64
	exitSent bool
}

func New(opts Options) *Agent {
	if opts.Logger == nil {
		opts.Logger = slog.Default()
	}
	return &Agent{opts: opts, log: opts.Logger, tasks: map[string]*task{}, kick: make(chan struct{}, 1)}
}

// Run connects and reconnects until ctx is cancelled. Running tasks survive disconnects.
func (a *Agent) Run(ctx context.Context) error {
	backoff := minBackoff
	for ctx.Err() == nil {
		conn, err := a.opts.Dial(ctx)
		if err != nil {
			var he *transport.HandshakeError
			if errors.As(err, &he) {
				a.log.Error("crhs rejected the connection", "err", err)
			} else {
				a.log.Warn("connect failed", "err", err)
			}
		} else {
			backoff = minBackoff
			start := time.Now()
			err := a.session(ctx, conn)
			a.log.Info("disconnected", "err", err, "after", time.Since(start).Round(time.Second))
			if errors.Is(err, errReconnectNow) {
				continue
			}
		}
		// Full jitter keeps a fleet from reconnecting in lockstep after a crhs restart.
		wait := time.Duration(rand.Int64N(int64(backoff))) + backoff/2
		select {
		case <-ctx.Done():
		case <-time.After(wait):
		}
		backoff = min(backoff*2, maxBackoff)
	}
	return ctx.Err()
}

var errReconnectNow = errors.New("reconnect requested by crhs")

func (a *Agent) session(ctx context.Context, conn *transport.Conn) error {
	ctx, cancel := context.WithTimeout(ctx, maxConnLifetime)
	defer cancel()
	defer conn.Close("bye")

	if conn.Response.NodeState == crhv1.NodeState_NODE_STATE_PENDING {
		return a.pendingSession(ctx, conn)
	}
	a.log.Info("connected", "node", conn.Response.NodeId, "clock_offset", conn.ClockOffset.Round(time.Millisecond))

	if err := conn.Send(ctx, &crhv1.Envelope{Body: &crhv1.Envelope_Hello{Hello: a.hello()}}); err != nil {
		return err
	}
	env, err := conn.Recv(ctx)
	if err != nil {
		return err
	}
	welcome := env.GetWelcome()
	if welcome == nil {
		return fmt.Errorf("expected Welcome, got %T", env.Body)
	}
	a.resume(welcome.Acks)
	facts := a.facts(conn)
	if err := conn.Send(ctx, &crhv1.Envelope{Body: &crhv1.Envelope_Facts{Facts: facts}}); err != nil {
		return err
	}

	errc := make(chan error, 3)
	go func() { errc <- a.pump(ctx, conn) }()
	go func() { errc <- a.keepalive(ctx, conn) }()
	go func() { errc <- a.receive(ctx, conn) }()
	err = <-errc
	cancel()
	return err
}

// pendingSession waits for an administrator to approve the node; crhs then closes the connection.
func (a *Agent) pendingSession(ctx context.Context, conn *transport.Conn) error {
	a.log.Info("waiting for approval on crhs", "node", conn.Response.NodeId)
	_ = conn.Send(ctx, &crhv1.Envelope{Body: &crhv1.Envelope_Facts{Facts: a.facts(conn)}})
	for {
		if _, err := conn.Recv(ctx); err != nil {
			if ctx.Err() == nil && bytes.Contains([]byte(err.Error()), []byte("approved")) {
				return errReconnectNow
			}
			return err
		}
	}
}

func (a *Agent) facts(conn *transport.Conn) *crhv1.Facts {
	f := &crhv1.Facts{}
	if a.opts.Facts != nil {
		f = a.opts.Facts()
	}
	f.ClockOffsetMs = conn.ClockOffset.Milliseconds()
	return f
}

func (a *Agent) hello() *crhv1.Hello {
	a.mu.Lock()
	defer a.mu.Unlock()
	h := &crhv1.Hello{
		CrhaVersion:    a.opts.Version,
		TaskKinds:      []string{"exec", "file.read", "file.write", "file.edit", "file.stat", "file.list"},
		PrivilegedMode: a.opts.PrivilegedMode,
	}
	for _, t := range a.tasks {
		h.Tasks = append(h.Tasks, t.status())
	}
	return h
}

func (t *task) status() *crhv1.TaskStatus {
	st := crhv1.TaskState_TASK_STATE_RUNNING
	if t.done {
		st = crhv1.TaskState_TASK_STATE_EXITED
	}
	return &crhv1.TaskStatus{
		TaskId:    t.id,
		State:     st,
		StdoutEnd: t.output.End(crhv1.Stream_STREAM_STDOUT),
		StderrEnd: t.output.End(crhv1.Stream_STREAM_STDERR),
	}
}

// resume rewinds each task's send position to what crhs has acknowledged.
func (a *Agent) resume(acks []*crhv1.OutputAck) {
	a.mu.Lock()
	defer a.mu.Unlock()
	byID := map[string]*crhv1.OutputAck{}
	for _, ack := range acks {
		byID[ack.TaskId] = ack
	}
	for id, t := range a.tasks {
		ack := byID[id]
		t.sent, t.exitSent = [3]uint64{}, false
		if ack != nil {
			t.sent[crhv1.Stream_STREAM_STDOUT] = ack.StdoutOffset
			t.sent[crhv1.Stream_STREAM_STDERR] = ack.StderrOffset
		}
	}
	a.wake()
}

func (a *Agent) wake() {
	select {
	case a.kick <- struct{}{}:
	default:
	}
}

// pump sends pending output, then TaskExit for finished tasks whose output is all sent.
func (a *Agent) pump(ctx context.Context, conn *transport.Conn) error {
	for {
		for {
			env := a.nextOutbound()
			if env == nil {
				break
			}
			if err := conn.Send(ctx, env); err != nil {
				return err
			}
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-a.kick:
		}
	}
}

func (a *Agent) nextOutbound() *crhv1.Envelope {
	a.mu.Lock()
	defer a.mu.Unlock()
	for _, t := range a.tasks {
		for _, s := range []crhv1.Stream{crhv1.Stream_STREAM_STDOUT, crhv1.Stream_STREAM_STDERR} {
			if t.sent[s] >= t.output.End(s) {
				continue
			}
			data, err := t.output.ReadAt(s, t.sent[s], outputChunk)
			if err != nil || len(data) == 0 {
				// Lost output (memory cap without a spill file): skip it; TaskExit's ends tell crhs.
				a.log.Warn("output lost", "task", t.id, "stream", s, "err", err)
				t.sent[s] = t.output.End(s)
				continue
			}
			off := t.sent[s]
			t.sent[s] += uint64(len(data))
			return &crhv1.Envelope{Body: &crhv1.Envelope_TaskOutput{TaskOutput: &crhv1.TaskOutput{
				TaskId: t.id, Stream: s, Offset: off, Data: data,
			}}}
		}
		if t.done && !t.exitSent && t.sent[crhv1.Stream_STREAM_STDOUT] >= t.result.StdoutEnd &&
			t.sent[crhv1.Stream_STREAM_STDERR] >= t.result.StderrEnd {
			t.exitSent = true // resent after every reconnect until acknowledged
			return &crhv1.Envelope{Body: &crhv1.Envelope_TaskExit{TaskExit: t.result}}
		}
	}
	return nil
}

func (a *Agent) keepalive(ctx context.Context, conn *transport.Conn) error {
	tick := time.NewTicker(pingInterval)
	defer tick.Stop()
	var seq uint64
	for {
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-tick.C:
			seq++
			if err := conn.Send(ctx, &crhv1.Envelope{Body: &crhv1.Envelope_Ping{Ping: &crhv1.Ping{Seq: seq}}}); err != nil {
				return err
			}
		}
	}
}

func (a *Agent) receive(ctx context.Context, conn *transport.Conn) error {
	for {
		rctx, cancel := context.WithTimeout(ctx, idleTimeout)
		env, err := conn.Recv(rctx)
		cancel()
		if err != nil {
			return err
		}
		if err := a.handle(ctx, conn, env); err != nil {
			return err
		}
	}
}

func (a *Agent) handle(ctx context.Context, conn *transport.Conn, env *crhv1.Envelope) error {
	switch b := env.Body.(type) {
	case *crhv1.Envelope_Ping:
		return conn.Send(ctx, &crhv1.Envelope{Body: &crhv1.Envelope_Pong{Pong: &crhv1.Pong{Seq: b.Ping.Seq}}})
	case *crhv1.Envelope_TaskStart:
		return a.start(ctx, conn, b.TaskStart)
	case *crhv1.Envelope_TaskInput:
		return a.input(b.TaskInput)
	case *crhv1.Envelope_TaskCancel:
		a.mu.Lock()
		if t := a.tasks[b.TaskCancel.TaskId]; t != nil && !t.done {
			t.cancel()
		}
		a.mu.Unlock()
	case *crhv1.Envelope_TaskQuery:
		a.mu.Lock()
		st := &crhv1.TaskStatus{TaskId: b.TaskQuery.TaskId, State: crhv1.TaskState_TASK_STATE_UNKNOWN}
		if t := a.tasks[b.TaskQuery.TaskId]; t != nil {
			st = t.status()
		}
		a.mu.Unlock()
		return conn.Send(ctx, &crhv1.Envelope{Body: &crhv1.Envelope_TaskStatus{TaskStatus: st}})
	case *crhv1.Envelope_TaskExitAck:
		a.mu.Lock()
		if t := a.tasks[b.TaskExitAck.TaskId]; t != nil && t.done {
			t.output.Release()
			delete(a.tasks, t.id)
		}
		a.mu.Unlock()
	}
	return nil
}

func (a *Agent) start(ctx context.Context, conn *transport.Conn, ts *crhv1.TaskStart) error {
	reject := func(reason string) error {
		return conn.Send(ctx, &crhv1.Envelope{Body: &crhv1.Envelope_TaskRejected{TaskRejected: &crhv1.TaskRejected{TaskId: ts.TaskId, Reason: reason}}})
	}
	a.mu.Lock()
	_, dup := a.tasks[ts.TaskId]
	a.mu.Unlock()
	switch {
	case ts.TaskId == "" || dup:
		return reject("duplicate or missing task id")
	case ts.Spec == nil || ts.Spec.Kind == nil:
		return reject("missing task spec")
	case ts.Privileged:
		return reject("privileged tasks are not supported by this crha")
	}

	t := &task{id: ts.TaskId, spec: ts, output: executor.NewOutput(ts.TaskId, a.opts.OutputDir, ts.SpillBytes, ts.SpillLines)}
	var in io.Reader
	if ref := inputRef(ts.Spec); ref != nil {
		r, w := io.Pipe()
		in = r
		t.inputSize, t.inputHash, t.hasher = ref.Size, ref.Sha256, sha256.New()
		// Room for every chunk crhs may send (it sends <= 48 KiB chunks), so queuing never blocks
		// while holding a.mu; the input itself is bounded by crhs.
		t.inputCh = make(chan []byte, min(ref.Size/(16<<10)+2, 1<<14))
		go feed(w, t.inputCh)
		if ref.Size == 0 {
			close(t.inputCh)
		}
	}
	runCtx, cancel := context.WithCancel(context.Background()) // tasks outlive connections
	t.cancel = cancel
	a.mu.Lock()
	a.tasks[t.id] = t
	a.mu.Unlock()
	if err := conn.Send(ctx, &crhv1.Envelope{Body: &crhv1.Envelope_TaskAccepted{TaskAccepted: &crhv1.TaskAccepted{TaskId: t.id}}}); err != nil {
		cancel()
		return err
	}
	go a.forward(t)
	go a.execute(runCtx, t, in)
	return nil
}

func inputRef(spec *crhv1.TaskSpec) *crhv1.InputRef {
	switch k := spec.Kind.(type) {
	case *crhv1.TaskSpec_Exec:
		return k.Exec.Stdin
	case *crhv1.TaskSpec_FileWrite:
		if k.FileWrite.Content == nil {
			return &crhv1.InputRef{Sha256: sha256.New().Sum(nil)}
		}
		return k.FileWrite.Content
	}
	return nil
}

// input queues a TaskInput chunk. Chunks arrive in order on one connection; a reconnect mid-input
// cannot be resumed (crhs sends the start once), so the executor then sees a short input and fails.
func (a *Agent) input(in *crhv1.TaskInput) error {
	a.mu.Lock()
	defer a.mu.Unlock()
	t := a.tasks[in.TaskId]
	if t == nil || t.inputCh == nil || t.inputOff >= t.inputSize || in.Offset != t.inputOff {
		return nil
	}
	t.inputOff += uint64(len(in.Data))
	_, _ = t.hasher.Write(in.Data)
	switch {
	case t.inputOff > t.inputSize:
		t.inputCh <- nil // poison: input longer than declared
	case t.inputOff == t.inputSize && !bytes.Equal(t.hasher.Sum(nil), t.inputHash):
		t.inputCh <- nil
	default:
		t.inputCh <- in.Data
	}
	if t.inputOff >= t.inputSize {
		close(t.inputCh)
	}
	return nil
}

// feed copies queued input into the executor's pipe. A nil chunk aborts the input.
func feed(w *io.PipeWriter, ch <-chan []byte) {
	for chunk := range ch {
		if chunk == nil {
			w.CloseWithError(errors.New("input does not match its declared size and hash"))
			for range ch {
			}
			return
		}
		if _, err := w.Write(chunk); err != nil {
			for range ch { // the executor stopped reading; drain
			}
			return
		}
	}
	_ = w.Close()
}

// forward turns output notifications into pump wake-ups.
func (a *Agent) forward(t *task) {
	for range t.output.Notify() {
		a.wake()
		a.mu.Lock()
		done := t.done
		a.mu.Unlock()
		if done {
			return
		}
	}
}

func (a *Agent) execute(ctx context.Context, t *task, in io.Reader) {
	exit := &crhv1.TaskExit{TaskId: t.id}
	switch k := t.spec.Spec.Kind.(type) {
	case *crhv1.TaskSpec_Exec:
		res := executor.RunExec(ctx, k.Exec, in, t.output, executor.ExecOptions{
			Timeout:   time.Duration(t.spec.TimeoutMs) * time.Millisecond,
			KillGrace: time.Duration(t.spec.KillGraceMs) * time.Millisecond,
		})
		exit.TimedOut, exit.Cancelled = res.TimedOut, res.Cancelled
		switch {
		case res.Err != nil:
			exit.Outcome = &crhv1.TaskExit_Error{Error: &crhv1.TaskError{Code: res.Err.Code, Message: res.Err.Message}}
		case res.Signal != "":
			exit.Outcome = &crhv1.TaskExit_Signal{Signal: res.Signal}
		default:
			exit.Outcome = &crhv1.TaskExit_ExitCode{ExitCode: *res.ExitCode}
		}
	default:
		err := executor.RunFile(ctx, t.spec.Spec, in, t.output.Writer(crhv1.Stream_STREAM_STDOUT))
		var e *executor.Error
		switch {
		case err == nil:
			exit.Outcome = &crhv1.TaskExit_ExitCode{ExitCode: 0}
		case errors.As(err, &e):
			exit.Outcome = &crhv1.TaskExit_Error{Error: &crhv1.TaskError{Code: e.Code, Message: e.Message}}
			exit.Cancelled = e.Code == "cancelled"
		default:
			exit.Outcome = &crhv1.TaskExit_Error{Error: &crhv1.TaskError{Code: "io_error", Message: err.Error()}}
		}
	}
	if pr, ok := in.(*io.PipeReader); ok {
		_ = pr.CloseWithError(errors.New("task finished")) // unblocks feed
	}
	t.output.Close()
	exit.StdoutEnd = t.output.End(crhv1.Stream_STREAM_STDOUT)
	exit.StderrEnd = t.output.End(crhv1.Stream_STREAM_STDERR)
	exit.OutputFile = t.output.Path()

	a.mu.Lock()
	t.done, t.result = true, exit
	a.mu.Unlock()
	a.wake()
}

// OutputFilesInUse lists the spill files of tasks still held (running, or exit not yet acknowledged),
// which the output janitor must keep.
func (a *Agent) OutputFilesInUse() map[string]bool {
	a.mu.Lock()
	defer a.mu.Unlock()
	inUse := map[string]bool{}
	for _, t := range a.tasks {
		if p := t.output.Path(); p != "" {
			inUse[p] = true
		}
	}
	return inUse
}
