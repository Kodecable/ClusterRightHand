// Package pty runs the terminals of a crha node in non-privileged mode: it keeps one crosspty
// process per terminal, reads its output into a bounded ring buffer, and holds the terminal's
// crhs-owned metadata until crhs closes it. The data connection that carries the bytes to crhs
// and back lives in the agent, which owns the transport (doc/design/pty.md "crha").
package pty

import (
	"errors"
	"log/slog"
	"sort"
	"strconv"
	"sync"
	"time"

	"github.com/Kodecable/crosspty"

	"github.com/Kodecable/ClusterRightHand/client/internal/execenv"
	"github.com/Kodecable/ClusterRightHand/client/internal/protocol"
)

const (
	// DefaultMaxTerminals is crha's backstop on terminals held at once, running or exited and not
	// yet closed by crhs. It is not the node's configured limit; crhs enforces that
	// (doc/design/pty.md "Settings and limits").
	DefaultMaxTerminals = 64
	// DefaultExitRetention is how long an exited terminal crhs has not closed is kept, with its
	// output and exit code, before crha drops it. crhs normally sends pty.close after it has shown
	// the last screen (doc/design/pty.md "Reconnect").
	DefaultExitRetention = 10 * time.Minute

	// maxSize is the largest accepted rows or cols value, as for a task's terminal size.
	maxSize = 1000
	// readBufferBytes is one Read call's buffer. The ring keeps what is read; the size only bounds
	// one syscall.
	readBufferBytes = 32 << 10
)

// Options configure a Manager. The zero value resolves the node's environment on first use and
// uses the defaults above.
type Options struct {
	// Env is the task environment resolved when `crha run` started (execenv.Resolve). nil resolves
	// it on first use, which only tests and programmatic callers do.
	Env *execenv.Environment
	// Logger receives the terminal lifecycle lines. nil uses slog.Default().
	Logger *slog.Logger
	// MaxTerminals overrides DefaultMaxTerminals; tests lower it.
	MaxTerminals int
	// ExitRetention overrides DefaultExitRetention; tests lower it.
	ExitRetention time.Duration
	// OnExit is called once when a terminal's process has exited and its last output has been
	// read, unless crhs closed the terminal first. The agent uses it to emit pty.exited.
	OnExit func(*Terminal)
}

// Manager owns every terminal of one crha process. It is safe for concurrent use.
type Manager struct {
	opts Options
	log  *slog.Logger

	envOnce sync.Once
	env     *execenv.Environment
	envErr  error

	mu        sync.Mutex
	terminals map[string]*Terminal
}

// NewManager returns an empty terminal manager.
func NewManager(opts Options) *Manager {
	if opts.Logger == nil {
		opts.Logger = slog.Default()
	}
	return &Manager{opts: opts, log: opts.Logger, terminals: map[string]*Terminal{}}
}

// OpenRequest is the validated pty.open request plus the agent's non-privileged identity.
type OpenRequest struct {
	ID              string
	Argv            []string
	Rows            uint64
	Cols            uint64
	Privileged      bool
	ScrollbackBytes uint64
	Meta            []byte
}

// Open starts a terminal. An empty Argv runs the identity's login shell (its discovered sh with
// "-l"), with the environment and home directory ordinary exec tasks of that identity get. The
// returned errors are *protocol.RemoteError values with the codes pty.open answers with.
func (m *Manager) Open(req OpenRequest) (*Terminal, error) {
	if req.Privileged {
		return nil, remote(protocol.CodePrivilegedUnsupported, "privileged terminals are not supported by this crha")
	}
	if req.ID == "" {
		return nil, remote(protocol.CodeInvalidSpec, "terminal id must not be empty")
	}
	if !validSize(req.Rows, req.Cols) {
		return nil, invalidSizeError()
	}
	env, err := m.environment()
	if err != nil {
		return nil, remote(protocol.CodeInternalError, "resolve the terminal environment: "+err.Error())
	}
	argv := append([]string(nil), req.Argv...)
	if len(argv) == 0 {
		// The identity's login shell: the discovered sh with -l, in the identity's home directory.
		argv = []string{env.Shell, "-l"}
	}
	dir := env.Home
	if dir == "" {
		dir = "/"
	}

	m.mu.Lock()
	defer m.mu.Unlock()
	if _, ok := m.terminals[req.ID]; ok {
		return nil, remote(protocol.CodeAlreadyAccepted, "terminal "+req.ID+" was already accepted")
	}
	if limit := m.maxTerminals(); len(m.terminals) >= limit {
		return nil, remote(protocol.CodeBusy, "this node already holds "+strconv.Itoa(limit)+" terminals")
	}

	proc, err := crosspty.New(crosspty.CommandConfig{
		Argv: argv,
		Dir:  dir,
		Env:  terminalEnv(env),
		// TERM is the only variable crosspty fills in, and only when an exec-style environment
		// does not already carry one.
		EnvFallback: map[string]string{"TERM": "xterm-256color"},
		Size: crosspty.TermSize{
			Rows: uint16(req.Rows),
			Cols: uint16(req.Cols),
		},
		CloseConfig: crosspty.CloseConfig{
			// Closing a terminal takes its whole process group with it, so a background child of
			// the shell cannot outlive it (doc/design/pty.md "Lifecycle").
			KillMode: crosspty.KillModeKillGroupOnSubProcessExit,
		},
	})
	if err != nil {
		return nil, remote(protocol.CodeSpawnFailed, "start the terminal: "+err.Error())
	}
	t := &Terminal{
		id:              req.ID,
		argv:            argv,
		rows:            uint16(req.Rows),
		cols:            uint16(req.Cols),
		privileged:      false,
		scrollbackBytes: req.ScrollbackBytes,
		meta:            append([]byte(nil), req.Meta...),
		startedAt:       time.Now(),
		proc:            proc,
		ring:            NewRing(clampScrollback(req.ScrollbackBytes)),
		ended:           make(chan struct{}),
		gone:            make(chan struct{}),
	}
	// The reader is attached before Start, so the shell's first prompt cannot be lost.
	go t.readLoop()
	if err := proc.Start(); err != nil {
		// After a failed Start only Close may be called.
		_ = proc.Close()
		return nil, remote(protocol.CodeSpawnFailed, "start the terminal: "+err.Error())
	}
	go t.waitLoop()
	m.terminals[t.id] = t
	m.log.Info("terminal opened", "id", t.id, "argv", t.argv)
	go m.watchExit(t)
	return t, nil
}

// Get returns the terminal with id, or nil when this node does not hold it.
func (m *Manager) Get(id string) *Terminal {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.terminals[id]
}

// List returns every held terminal, running and exited, in a stable order (started, then id) for
// pty.list.
func (m *Manager) List() []protocol.PTYStatus {
	m.mu.Lock()
	terms := make([]*Terminal, 0, len(m.terminals))
	for _, t := range m.terminals {
		terms = append(terms, t)
	}
	m.mu.Unlock()
	out := make([]protocol.PTYStatus, 0, len(terms))
	for _, t := range terms {
		out = append(out, t.Status())
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].StartedAtMS != out[j].StartedAtMS {
			return out[i].StartedAtMS < out[j].StartedAtMS
		}
		return out[i].PTYID < out[j].PTYID
	})
	return out
}

// Held returns every held terminal, running or exited but not yet closed, for (re)starting their
// data connections after a new control connection (doc/design/pty.md "Reconnect").
func (m *Manager) Held() []*Terminal {
	m.mu.Lock()
	terms := make([]*Terminal, 0, len(m.terminals))
	for _, t := range m.terminals {
		terms = append(terms, t)
	}
	m.mu.Unlock()
	return terms
}

// Resize changes a terminal's size. An unknown id is not_found; an out-of-range size is
// invalid_spec, exactly as pty.open validates one.
func (m *Manager) Resize(id string, rows, cols uint64) error {
	t := m.Get(id)
	if t == nil {
		return remote(protocol.CodeNotFound, "unknown terminal "+id)
	}
	if !validSize(rows, cols) {
		return invalidSizeError()
	}
	if err := t.Resize(uint16(rows), uint16(cols)); err != nil {
		if errors.Is(err, errGone) {
			return remote(protocol.CodeNotFound, "unknown terminal "+id)
		}
		return remote(protocol.CodeInternalError, "resize the terminal: "+err.Error())
	}
	return nil
}

// SetMeta replaces a terminal's opaque crhs metadata blob.
func (m *Manager) SetMeta(id string, meta []byte) error {
	t := m.Get(id)
	if t == nil {
		return remote(protocol.CodeNotFound, "unknown terminal "+id)
	}
	t.setMeta(meta)
	return nil
}

// Drop removes a terminal from the map immediately and marks it gone, without waiting for the
// process group to be closed. It reports nil for an unknown id, so pty.close stays idempotent.
// Callers that must know the group is gone use Close.
func (m *Manager) Drop(id string) *Terminal {
	m.mu.Lock()
	t := m.terminals[id]
	if t != nil {
		delete(m.terminals, id)
	}
	m.mu.Unlock()
	if t == nil {
		return nil
	}
	t.markRemoved()
	t.closeGone()
	return t
}

// Close removes a terminal and closes its process group, returning once crosspty's close sequence
// has finished. An unknown id is a no-op.
func (m *Manager) Close(id string) {
	t := m.Drop(id)
	if t == nil {
		return
	}
	if err := t.Close(); err != nil {
		m.log.Warn("close terminal", "id", id, "err", err)
	}
}

// Shutdown closes every terminal, and their process groups, when crha stops. Terminals do not
// outlive the node (doc/design/pty.md "The terminal object").
func (m *Manager) Shutdown() {
	m.mu.Lock()
	terms := make([]*Terminal, 0, len(m.terminals))
	for id, t := range m.terminals {
		terms = append(terms, t)
		delete(m.terminals, id)
	}
	m.mu.Unlock()
	var wg sync.WaitGroup
	for _, t := range terms {
		m.log.Info("terminal closed", "id", t.id, "reason", "node shutting down")
		t.markRemoved()
		t.closeGone()
		wg.Add(1)
		go func() {
			defer wg.Done()
			if err := t.Close(); err != nil {
				m.log.Warn("close terminal", "id", t.id, "err", err)
			}
		}()
	}
	wg.Wait()
}

// Count reports how many terminals are held, for tests and diagnostics.
func (m *Manager) Count() int {
	m.mu.Lock()
	defer m.mu.Unlock()
	return len(m.terminals)
}

func (m *Manager) maxTerminals() int {
	if m.opts.MaxTerminals > 0 {
		return m.opts.MaxTerminals
	}
	return DefaultMaxTerminals
}

func (m *Manager) retention() time.Duration {
	if m.opts.ExitRetention > 0 {
		return m.opts.ExitRetention
	}
	return DefaultExitRetention
}

// environment returns the node's task environment, resolving it once when the agent did not pass
// the environment it resolved at start.
func (m *Manager) environment() (*execenv.Environment, error) {
	if m.opts.Env != nil {
		return m.opts.Env, nil
	}
	m.envOnce.Do(func() {
		m.env, m.envErr = execenv.Resolve(execenv.Options{})
	})
	if m.envErr != nil {
		return nil, m.envErr
	}
	return m.env, nil
}

// watchExit waits for a terminal's process and its remaining output, then reports the exit once
// and starts the retention timer for a terminal crhs never closes. A terminal crhs closed first,
// or the node is shutting down, reports nothing.
func (m *Manager) watchExit(t *Terminal) {
	<-t.OutputDone()
	_, code := t.Exit()
	m.log.Info("terminal exited", "id", t.ID(), "code", code)
	t.reportMu.Lock()
	defer t.reportMu.Unlock()
	if t.removed {
		return
	}
	if m.opts.OnExit != nil {
		m.opts.OnExit(t)
	}
	t.retention = time.AfterFunc(m.retention(), func() { m.expire(t) })
}

// expire drops an exited terminal crhs did not close within the retention window and frees its
// PTY. The entry is already gone from the map when crhs closed it, so this is the only path that
// reports it.
func (m *Manager) expire(t *Terminal) {
	t.reportMu.Lock()
	if t.removed || t.retention == nil {
		t.reportMu.Unlock()
		return
	}
	t.reportMu.Unlock()
	if m.Drop(t.id) == t {
		m.log.Info("terminal closed", "id", t.id, "reason", "retention expired")
		if err := t.Close(); err != nil {
			m.log.Warn("close terminal", "id", t.id, "err", err)
		}
	}
}

// Terminal is one PTY process and the state crha keeps for it.
type Terminal struct {
	mu              sync.Mutex
	ioMu            sync.RWMutex // lets Close wait out an in-flight Write or Resize
	id              string
	argv            []string
	rows            uint16
	cols            uint16
	privileged      bool
	scrollbackBytes uint64
	meta            []byte
	startedAt       time.Time
	proc            crosspty.Pty
	ring            *Ring
	exited          bool
	exitCode        int
	drained         bool
	ended           chan struct{}
	endOnce         sync.Once
	removed         bool

	// reportMu serializes the exit report against removal, so no pty.exited is emitted for a
	// terminal crhs closed (doc/design/pty.md "crha").
	reportMu  sync.Mutex
	retention *time.Timer

	gone     chan struct{}
	goneOnce sync.Once
}

var errGone = errors.New("pty: terminal is gone")

// ID returns the terminal id crhs chose.
func (t *Terminal) ID() string { return t.id }

// Argv returns a copy of the terminal's argv.
func (t *Terminal) Argv() []string {
	t.mu.Lock()
	defer t.mu.Unlock()
	return append([]string(nil), t.argv...)
}

// Ring returns the terminal's output ring buffer.
func (t *Terminal) Ring() *Ring { return t.ring }

// Exit reports whether the process has exited and its exit code. The code is -1 when crosspty
// could not determine one, for example after a signal.
func (t *Terminal) Exit() (exited bool, code int) {
	t.mu.Lock()
	defer t.mu.Unlock()
	return t.exited, t.exitCode
}

// OutputDone is closed once the process has exited and the last output has been read. A data
// connection that has sent every byte before it sends [end].
func (t *Terminal) OutputDone() <-chan struct{} { return t.ended }

// Ended reports whether OutputDone is closed.
func (t *Terminal) Ended() bool {
	select {
	case <-t.ended:
		return true
	default:
		return false
	}
}

// Gone is closed when the terminal was closed or dropped: no new data connection should be
// opened for it.
func (t *Terminal) Gone() <-chan struct{} { return t.gone }

// Status returns the terminal's pty.list entry.
func (t *Terminal) Status() protocol.PTYStatus {
	t.mu.Lock()
	defer t.mu.Unlock()
	argv := append([]string(nil), t.argv...)
	if argv == nil {
		argv = []string{}
	}
	meta := append([]byte(nil), t.meta...)
	if meta == nil {
		meta = []byte{}
	}
	return protocol.PTYStatus{
		PTYID:           t.id,
		Argv:            argv,
		Rows:            protocol.Uint(t.rows),
		Cols:            protocol.Uint(t.cols),
		Privileged:      t.privileged,
		ScrollbackBytes: protocol.Uint(t.scrollbackBytes),
		Meta:            meta,
		StartedAtMS:     protocol.Uint(max(t.startedAt.UnixMilli(), 0)),
		Exited:          t.exited,
		ExitCode:        protocol.Int(t.exitCode),
	}
}

// Resize changes the PTY size, which also tells the foreground program through SIGWINCH.
func (t *Terminal) Resize(rows, cols uint16) error {
	t.ioMu.RLock()
	defer t.ioMu.RUnlock()
	if t.isRemoved() {
		return errGone
	}
	if err := t.proc.Resize(crosspty.TermSize{Rows: rows, Cols: cols}); err != nil {
		return err
	}
	t.mu.Lock()
	t.rows, t.cols = rows, cols
	t.mu.Unlock()
	return nil
}

// Write sends crhs input to the PTY in order.
func (t *Terminal) Write(p []byte) error {
	t.ioMu.RLock()
	defer t.ioMu.RUnlock()
	if t.isRemoved() {
		return errGone
	}
	_, err := t.proc.Write(p)
	return err
}

// Close follows crosspty's graceful sequence for the process group: hang up, then SIGKILL after
// the grace period. It is idempotent.
func (t *Terminal) Close() error {
	t.ioMu.Lock()
	defer t.ioMu.Unlock()
	return t.proc.Close()
}

// isRemoved reports whether the manager dropped the terminal. removed is guarded by reportMu,
// which also orders it against the one exit report.
func (t *Terminal) isRemoved() bool {
	t.reportMu.Lock()
	defer t.reportMu.Unlock()
	return t.removed
}

func (t *Terminal) setMeta(meta []byte) {
	t.mu.Lock()
	t.meta = append([]byte(nil), meta...)
	t.mu.Unlock()
}

// markRemoved records that crhs (or the node) dropped the terminal and stops the retention
// timer. It reports false when the terminal was already removed.
func (t *Terminal) markRemoved() bool {
	t.reportMu.Lock()
	defer t.reportMu.Unlock()
	if t.removed {
		return false
	}
	t.removed = true
	if t.retention != nil {
		t.retention.Stop()
	}
	return true
}

func (t *Terminal) closeGone() {
	t.goneOnce.Do(func() { close(t.gone) })
}

// readLoop reads the PTY continuously into the ring. It never blocks on crhs: only the ring's
// capacity bounds what is kept.
func (t *Terminal) readLoop() {
	buf := make([]byte, readBufferBytes)
	for {
		n, err := t.proc.Read(buf)
		if n > 0 {
			t.ring.Write(buf[:n])
		}
		if err != nil {
			break
		}
	}
	t.mu.Lock()
	t.drained = true
	t.maybeEndLocked()
	t.mu.Unlock()
}

// waitLoop records the exit code as soon as the direct process exits. The reader may still be
// draining output after it.
func (t *Terminal) waitLoop() {
	code := t.proc.Wait()
	t.mu.Lock()
	t.exited, t.exitCode = true, code
	t.maybeEndLocked()
	t.mu.Unlock()
}

// maybeEndLocked closes ended once the process is gone and its output fully read. t.mu must be
// held.
func (t *Terminal) maybeEndLocked() {
	if !t.exited || !t.drained {
		return
	}
	t.endOnce.Do(func() { close(t.ended) })
}

// terminalEnv is the environment a terminal starts with: what an exec task of this identity gets,
// before crosspty adds TERM (doc/design/execution.md "The exec environment").
func terminalEnv(env *execenv.Environment) []string {
	return []string{
		"HOME=" + env.Home,
		"LANG=" + execenv.Locale,
		"LC_ALL=" + execenv.Locale,
		"LOGNAME=" + env.Logname,
		"PATH=" + env.Path,
		"SHELL=" + env.Shell,
		"USER=" + env.User,
	}
}

func validSize(rows, cols uint64) bool {
	return rows > 0 && rows <= maxSize && cols > 0 && cols <= maxSize
}

func invalidSizeError() *protocol.RemoteError {
	return remote(protocol.CodeInvalidSpec, "rows and cols must be between 1 and 1000")
}

func remote(code, message string) *protocol.RemoteError {
	return &protocol.RemoteError{Code: code, Message: message}
}
