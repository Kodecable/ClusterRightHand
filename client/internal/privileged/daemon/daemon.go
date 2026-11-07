// Package daemon implements crha's privileged mode: the unix-socket server that verifies
// authorizations for privileged tasks, executes them as its own Linux user, records the used
// list, exposes local approval and pushes the trust summary
// (doc/privilege.md 特权模式, doc/protocol.md crh-priv).
package daemon

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net"
	"os"
	"os/signal"
	"os/user"
	"path/filepath"
	"strconv"
	"sync"
	"sync/atomic"
	"syscall"
	"time"

	"golang.org/x/sys/unix"

	"github.com/Kodecable/ClusterRightHand/client/internal/execenv"
	"github.com/Kodecable/ClusterRightHand/client/internal/privileged/audit"
	"github.com/Kodecable/ClusterRightHand/client/internal/privileged/config"
	"github.com/Kodecable/ClusterRightHand/client/internal/privileged/state"
	"github.com/Kodecable/ClusterRightHand/client/internal/privileged/taskrun"
	"github.com/Kodecable/ClusterRightHand/client/internal/protocol"
)

// shutdownTaskWait bounds how long Run waits for aborted tasks during shutdown.
const shutdownTaskWait = 30 * time.Second

// Options configures New.
type Options struct {
	// ConfigPath is the file SIGHUP reloads. It is also the path the initial configuration
	// was read from.
	ConfigPath string
	// Version is this build's crha version; it is reported in the crh-priv handshake.
	Version string
	// Log is the local audit log. It is required.
	Log *audit.Logger
	// Logger receives operational warnings and errors (stale socket, unknown group, reload
	// failure). nil discards them.
	Logger *slog.Logger
	// Now returns the current time; nil means time.Now.
	Now func() time.Time
	// Env is the task environment resolved when `crha privileged run` started
	// (doc/execution-plane.md#exec-的执行环境). nil resolves it per task, which only tests and
	// programmatic callers do.
	Env *execenv.Environment
	// NoPersistUsed keeps the used list in memory only, for embedded devices with limited
	// disk endurance. It lowers security: after the privileged mode restarts, a one-shot
	// authorization can run again until its deadline.
	NoPersistUsed bool
}

// Server is one privileged-mode daemon.
type Server struct {
	opts Options
	cfg  atomic.Pointer[config.Config]
	log  *slog.Logger
	now  func() time.Time

	store *state.Store

	listener   net.Listener
	socketPath string

	mu       sync.Mutex
	conns    map[*conn]struct{}
	forwards map[*conn]struct{}
	tasks    map[*taskrun.Task]struct{}
	// idle is closed while no accepted task is running. registerTask opens a new channel for the
	// next busy period; unregisterTask closes it when the last task finished.
	idle chan struct{}

	approvalMu sync.Mutex
	approvals  map[approvalKey]*approval

	connWG sync.WaitGroup
}

// New opens the persistent state and prepares the server. Run owns the socket.
func New(cfg *config.Config, opts Options) (*Server, error) {
	if cfg == nil {
		return nil, errors.New("daemon: nil configuration")
	}
	if opts.Log == nil {
		return nil, errors.New("daemon: no local log")
	}
	logger := opts.Logger
	if logger == nil {
		logger = slog.New(slog.DiscardHandler)
	}
	now := opts.Now
	if now == nil {
		now = time.Now
	}
	store, err := state.Open(cfg.StateDir, state.Options{
		Now:       now,
		Logger:    logger,
		ClockSkew: cfg.ClockSkew,
		NoPersist: opts.NoPersistUsed,
	})
	if err != nil {
		return nil, err
	}
	if opts.NoPersistUsed {
		logger.Warn("the used list is kept in memory only; after the privileged mode restarts, " +
			"a one-shot authorization can run again until its deadline")
	}
	s := &Server{
		opts:      opts,
		log:       logger,
		now:       now,
		store:     store,
		conns:     make(map[*conn]struct{}),
		forwards:  make(map[*conn]struct{}),
		tasks:     make(map[*taskrun.Task]struct{}),
		idle:      make(chan struct{}),
		approvals: make(map[approvalKey]*approval),
	}
	close(s.idle)
	s.cfg.Store(cfg)
	return s, nil
}

// Config returns the current configuration.
func (s *Server) Config() *config.Config { return s.cfg.Load() }

// SocketPath returns the socket path the server listens on.
func (s *Server) SocketPath() string { return s.socketPath }

// Run listens on the configured unix socket and serves until ctx is cancelled. SIGHUP
// reloads the configuration and pushes trust.summary when the digest changed.
func (s *Server) Run(ctx context.Context) error {
	// Install the SIGHUP handler before the socket appears, so a caller that sees the socket
	// can already send a reload.
	hup := make(chan os.Signal, 1)
	signal.Notify(hup, syscall.SIGHUP)
	defer signal.Stop(hup)

	if err := s.listen(); err != nil {
		_ = s.store.Close()
		return err
	}
	defer s.shutdown()

	acceptErr := make(chan error, 1)
	go func() { acceptErr <- s.acceptLoop() }()

	for {
		select {
		case <-ctx.Done():
			return nil
		case err := <-acceptErr:
			if err != nil {
				return err
			}
			return nil
		case <-hup:
			s.reload()
		}
	}
}

// listen creates the socket with mode 0660 and the configured group. A stale socket at the
// path is removed; any other kind of file there is refused rather than deleted.
func (s *Server) listen() error {
	cfg := s.Config()
	path := cfg.Socket
	if path == "" {
		return errors.New("daemon: no socket path")
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return fmt.Errorf("daemon: create socket directory: %w", err)
	}
	if fi, err := os.Lstat(path); err == nil {
		if fi.Mode()&os.ModeSocket == 0 {
			return fmt.Errorf("daemon: %s exists and is not a socket", path)
		}
		if err := os.Remove(path); err != nil {
			return fmt.Errorf("daemon: remove stale socket %s: %w", path, err)
		}
	} else if !errors.Is(err, os.ErrNotExist) {
		return fmt.Errorf("daemon: stat %s: %w", path, err)
	}

	listener, err := net.Listen("unix", path)
	if err != nil {
		return fmt.Errorf("daemon: listen %s: %w", path, err)
	}
	s.listener = listener
	s.socketPath = path
	if err := os.Chmod(path, 0o660); err != nil {
		listener.Close()
		os.Remove(path)
		return fmt.Errorf("daemon: chmod %s: %w", path, err)
	}
	s.setSocketGroup(path, cfg.SocketGroup)
	return nil
}

// setSocketGroup gives the socket its configured group. A group that does not exist is a
// warning, not a failure: the running user's group stays, and the administrator can create
// it and reload or restart. A chown that the running user may not do (the daemon is not
// root) is also a warning; the socket can still be reached by its owner and group.
func (s *Server) setSocketGroup(path, name string) {
	if name == "" {
		return
	}
	group, err := user.LookupGroup(name)
	if err != nil {
		s.log.Warn("socket group does not exist, keeping the running user's group", "group", name, "socket", path)
		return
	}
	gid, err := strconv.ParseUint(group.Gid, 10, 32)
	if err != nil {
		s.log.Warn("socket group has an invalid gid", "group", name, "gid", group.Gid)
		return
	}
	if err := os.Chown(path, -1, int(gid)); err != nil {
		s.log.Warn("cannot give the socket its group", "group", name, "socket", path, "err", err)
	}
}

// acceptLoop accepts connections until the listener is closed.
func (s *Server) acceptLoop() error {
	for {
		conn, err := s.listener.Accept()
		if err != nil {
			if errors.Is(err, net.ErrClosed) {
				return nil
			}
			return fmt.Errorf("daemon: accept: %w", err)
		}
		s.connWG.Add(1)
		go func() {
			defer s.connWG.Done()
			s.serveConn(conn)
		}()
	}
}

// shutdown closes the listener and every connection, then aborts and waits for the tasks.
// Accepted tasks run while their connection closes; the daemon only stops them when the
// daemon itself is stopping.
func (s *Server) shutdown() {
	if s.listener != nil {
		_ = s.listener.Close()
	}
	s.mu.Lock()
	conns := make([]*conn, 0, len(s.conns))
	for c := range s.conns {
		conns = append(conns, c)
	}
	s.mu.Unlock()
	for _, c := range conns {
		c.close()
	}
	s.connWG.Wait()

	s.mu.Lock()
	tasks := make([]*taskrun.Task, 0, len(s.tasks))
	for t := range s.tasks {
		tasks = append(tasks, t)
	}
	s.mu.Unlock()
	for _, t := range tasks {
		t.Abort()
	}
	if !s.waitTasks(shutdownTaskWait) {
		s.log.Warn("tasks did not stop during shutdown", "tasks", len(tasks))
	}
	_ = s.store.Close()
	if s.socketPath != "" {
		_ = os.Remove(s.socketPath)
	}
}

// waitTasks waits until no accepted task is running. It returns false when timeout expires first.
func (s *Server) waitTasks(timeout time.Duration) bool {
	timer := time.NewTimer(timeout)
	defer timer.Stop()
	for {
		s.mu.Lock()
		idle := s.idle
		done := len(s.tasks) == 0
		s.mu.Unlock()
		if done {
			return true
		}
		select {
		case <-idle:
			// The task set emptied; check again whether another task took its place.
		case <-timer.C:
			return false
		}
	}
}

// registerConn adds a connection to the server's set. addForward adds it to the forward
// set once the handshake established that role.
func (s *Server) registerConn(c *conn) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.conns[c] = struct{}{}
}

// unregisterConn removes a connection from the server's sets.
func (s *Server) unregisterConn(c *conn) {
	s.mu.Lock()
	defer s.mu.Unlock()
	delete(s.conns, c)
	delete(s.forwards, c)
}

// registerTask tracks an accepted task until its execution ends.
func (s *Server) registerTask(t *taskrun.Task) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if len(s.tasks) == 0 {
		s.idle = make(chan struct{})
	}
	s.tasks[t] = struct{}{}
}

// unregisterTask removes a finished task and wakes waitTasks once none are left.
func (s *Server) unregisterTask(t *taskrun.Task) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if _, ok := s.tasks[t]; !ok {
		return
	}
	delete(s.tasks, t)
	if len(s.tasks) == 0 {
		close(s.idle)
	}
}

// forwardConns returns a snapshot of the forward connections.
func (s *Server) forwardConns() []*conn {
	s.mu.Lock()
	defer s.mu.Unlock()
	out := make([]*conn, 0, len(s.forwards))
	for c := range s.forwards {
		out = append(out, c)
	}
	return out
}

// reload re-reads the configuration. A file that does not load keeps the old configuration
// and is recorded in the local log. When the trust digest changed, every forward connection
// receives a fresh trust.summary.
func (s *Server) reload() {
	if s.opts.ConfigPath == "" {
		s.log.Error("SIGHUP without a configuration path")
		return
	}
	next, err := config.Load(s.opts.ConfigPath)
	if err != nil {
		s.log.Error("configuration reload failed, keeping the current one", "err", err)
		_ = s.opts.Log.Log(audit.Record{Event: "config.reload_failed", Detail: err.Error()})
		return
	}
	old := s.cfg.Load()
	oldSummary := old.Summary()
	oldDigest, err := protocol.TrustDigest(oldSummary)
	if err != nil {
		s.log.Error("cannot digest the current trust summary", "err", err)
		return
	}
	summary := next.Summary()
	digest, err := protocol.TrustDigest(summary)
	if err != nil {
		s.log.Error("cannot digest the new trust summary, keeping the current configuration", "err", err)
		_ = s.opts.Log.Log(audit.Record{Event: "config.reload_failed", Detail: err.Error()})
		return
	}
	s.cfg.Store(next)
	detail := "digest unchanged"
	changed := oldDigest != digest
	if changed {
		detail = fmt.Sprintf("digest %x -> %x", oldDigest[:8], digest[:8])
	}
	if next.Socket != old.Socket || next.StateDir != old.StateDir || next.LogPath != old.LogPath {
		detail += "; socket, state_dir and log changes take effect after a restart"
	}
	s.log.Info("configuration reloaded", "digest_changed", changed)
	if err := s.opts.Log.Log(audit.Record{Event: "config.reloaded", Detail: detail}); err != nil {
		s.log.Warn("write local log", "err", err)
	}
	if !changed {
		return
	}
	report := protocol.TrustReport{Kind: protocol.TrustReportOK, Summary: summary}
	for _, c := range s.forwardConns() {
		peer := c.currentPeer()
		if peer == nil {
			continue
		}
		if err := peer.Emit(protocol.EventTrustSummary, report); err != nil {
			s.log.Warn("push trust.summary", "err", err)
		}
	}
}

// localUIDAllowed reports whether uid is in a local trust entry of the current configuration.
func (s *Server) localUIDAllowed(uid uint32) bool {
	return s.Config().LocalEntry(uid) != nil
}

// peerCredential returns the uid and gid of the peer of a unix connection (SO_PEERCRED).
func peerCredential(conn *net.UnixConn) (uid, gid uint32, err error) {
	raw, err := conn.SyscallConn()
	if err != nil {
		return 0, 0, err
	}
	var cred *unix.Ucred
	var credErr error
	if err := raw.Control(func(fd uintptr) {
		cred, credErr = unix.GetsockoptUcred(int(fd), unix.SOL_SOCKET, unix.SO_PEERCRED)
	}); err != nil {
		return 0, 0, err
	}
	if credErr != nil {
		return 0, 0, credErr
	}
	return cred.Uid, cred.Gid, nil
}
