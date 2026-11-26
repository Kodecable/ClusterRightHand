package cli

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"os"
	"os/signal"
	"path/filepath"
	"runtime"
	"slices"
	"strings"
	"sync/atomic"
	"syscall"
	"time"

	"github.com/Kodecable/ClusterRightHand/client/internal/agent"
	"github.com/Kodecable/ClusterRightHand/client/internal/config"
	"github.com/Kodecable/ClusterRightHand/client/internal/execenv"
	"github.com/Kodecable/ClusterRightHand/client/internal/facts"
	"github.com/Kodecable/ClusterRightHand/client/internal/identity"
	"github.com/Kodecable/ClusterRightHand/client/internal/janitor"
	"github.com/Kodecable/ClusterRightHand/client/internal/logging"
	"github.com/Kodecable/ClusterRightHand/client/internal/metrics"
	"github.com/Kodecable/ClusterRightHand/client/internal/privileged/audit"
	privconfig "github.com/Kodecable/ClusterRightHand/client/internal/privileged/config"
	"github.com/Kodecable/ClusterRightHand/client/internal/privileged/daemon"
	"github.com/Kodecable/ClusterRightHand/client/internal/privileged/helper"
	"github.com/Kodecable/ClusterRightHand/client/internal/protocol"
	"github.com/Kodecable/ClusterRightHand/client/internal/transport"
	"github.com/Kodecable/ClusterRightHand/client/internal/upgrade"
	"github.com/Kodecable/ClusterRightHand/client/internal/version"
	"github.com/spf13/cobra"
)

// resolveEnv resolves the task environment of a process. It is a variable so tests can exercise a
// node without a shell, whose modes must not start at all.
var resolveEnv = execenv.Resolve

func newRunCmd() *cobra.Command {
	var configPath string
	var startDebug func(context.Context) error
	cmd := &cobra.Command{
		Use:   "run",
		Short: "Run crha in non-privileged mode",
		Long:  "Run crha in non-privileged mode. SIGHUP re-reads the configuration; an invalid file keeps the running one.",
		Args:  cobra.NoArgs,
		RunE: func(cmd *cobra.Command, _ []string) error {
			return runWithDebug(cmd.Context(), configPath, startDebug)
		},
	}
	cmd.Flags().StringVar(&configPath, "config", "", "path to the config file (required)")
	_ = cmd.MarkFlagRequired("config")
	startDebug = addDebugFlags(cmd)
	return cmd
}

func run(ctx context.Context, configPath string) error {
	return runWithDebug(ctx, configPath, nil)
}

// runWithDebug is run plus the optional starter of a debug build's facilities (pprof). startDebug
// is nil in normal builds and when the debug flag was not given.
func runWithDebug(ctx context.Context, configPath string, startDebug func(context.Context) error) error {
	// One logger for the whole process, in whatever format this process's stderr needs. It is also
	// the default, so the standard library's log (the debug build's pprof lines) goes through it.
	log := logging.New(os.Stderr)
	slog.SetDefault(log)
	// The process context exists before anything else: a debug listener started below stops when the
	// process is asked to shut down, including the early-exit paths.
	ctx, stop := signal.NotifyContext(ctx, syscall.SIGINT, syscall.SIGTERM)
	defer stop()
	if startDebug != nil {
		// Validate and open the debug endpoint before the node connects, so a bad address is a
		// startup error rather than a surprise after enrollment.
		if err := startDebug(ctx); err != nil {
			return err
		}
	}
	// The task environment is resolved once for the process: a node that cannot give its tasks a
	// shell and an identity must not run tasks at all (doc/design/execution.md "The exec environment").
	env, err := resolveEnv(execenv.Options{})
	if err != nil {
		return err
	}
	first, err := config.Load(configPath)
	if err != nil {
		return err
	}
	var cfg atomic.Pointer[config.Config]
	cfg.Store(first)
	key, err := identity.LoadKeypair(first.IdentityKeyPath())
	if err != nil {
		return fmt.Errorf("load identity (run \"crha enroll\" first): %w", err)
	}
	serverKey, err := identity.LoadServerKey(first.ServerKeyPath())
	if err != nil {
		return err
	}
	if err := os.MkdirAll(first.Output.Dir, 0o700); err != nil {
		return err
	}

	collector := metrics.New(metrics.Options{
		Root:       "/",
		Disks:      metricsDisks(first.Metrics.Disks),
		Interfaces: first.Metrics.Interfaces,
	})
	a := agent.New(agent.Options{
		Dial: func(ctx context.Context) (*transport.Conn, error) {
			return transport.Dial(ctx, dialOptions(cfg.Load(), key, serverKey, &protocol.HandshakeInit{CRHAVersion: version.Version}))
		},
		DataDial: func(ctx context.Context, taskID, transferID string) (agent.DataConn, error) {
			return transport.DialData(ctx, dataDialOptions(cfg.Load(), key, serverKey, taskID, transferID))
		},
		PTYDial: func(ctx context.Context, ptyID string, inputReceived uint64) (agent.DataConn, uint64, error) {
			return transport.DialPTY(ctx, ptyDialOptions(cfg.Load(), key, serverKey, ptyID, inputReceived))
		},
		Facts: func() protocol.Facts { return nodeFacts(cfg.Load(), env) },
		// How crha is installed and started does not change while it runs (doc/design/distribution.md
		// "Who can self-upgrade"); the privileged mode is a restart-only setting.
		SelfUpgradeStatic: upgrade.StaticReasons(upgrade.ProductionHost(), first.Privilege.Mode, version.PackageManaged),
		Arch:              runtime.GOARCH,
		OutputDir:         first.Output.Dir,
		PrivilegedMode:    first.Privilege.Mode,
		PrivilegedSocket:  first.Privilege.Socket,
		NativePrefix:      nativeEscalation(first.Privilege.Native),
		ClockWarn:         first.ClockWarn,
		Env:               env,
		Metrics:           collector.Collect,
		Logger:            log,
	})
	outputDir, err := filepath.Abs(first.Output.Dir)
	if err != nil {
		return err
	}
	go janitor.Run(ctx, janitor.Options{
		Dir:      outputDir,
		MaxAge:   first.Output.MaxAge,
		MaxTotal: first.Output.MaxTotal,
		InUse:    a.OutputFilesInUse,
		Logger:   log,
	}, time.Hour)
	go reloadOnHangup(ctx, log, configPath, &cfg, a)

	log.Info("crha starting", "server", first.AgentURL(), "identity", identity.Fingerprint(key.Public))
	// What the metrics configuration resolves to, so a misconfiguration is visible in the log
	// (doc/design/metrics.md "crha nodes").
	targets := collector.Targets()
	log.Info("metrics targets", "disks", metricsDisksLog(targets.Disks),
		"interfaces", metricsInterfacesLog(targets))
	if len(targets.Dropped) > 0 {
		log.Warn("metrics targets dropped", "dropped", metricsDroppedLog(targets.Dropped))
	}
	if err := a.Run(ctx); err != nil {
		// agent.ErrNodeRejected carries crhs's reason. main prints the returned error to stderr and
		// exits non-zero; other errors are only reported when we were not shutting down.
		if errors.Is(err, agent.ErrNodeRejected) || ctx.Err() == nil {
			return err
		}
	}
	return nil
}

// reloadOnHangup re-reads the configuration on SIGHUP. An invalid file keeps the running configuration.
// Notes are reported again; a changed server or TLS setting reconnects. Settings fixed at start
// (state_dir, output, privileged mode) need a restart.
func reloadOnHangup(ctx context.Context, log *slog.Logger, path string, cfg *atomic.Pointer[config.Config], a *agent.Agent) {
	hup := make(chan os.Signal, 1)
	signal.Notify(hup, syscall.SIGHUP)
	defer signal.Stop(hup)
	for {
		select {
		case <-ctx.Done():
			return
		case <-hup:
		}
		next, err := config.Load(path)
		if err != nil {
			log.Error("reload failed, keeping the current configuration", "err", err)
			continue
		}
		prev := cfg.Swap(next)
		if next.StateDir != prev.StateDir || next.Output != prev.Output || next.Privilege != prev.Privilege ||
			next.ClockWarn != prev.ClockWarn || !slices.Equal(next.Metrics.Disks, prev.Metrics.Disks) ||
			!slices.Equal(next.Metrics.Interfaces, prev.Metrics.Interfaces) {
			log.Warn("state_dir, clock_warn, [output], [metrics] and [privileged] changes take effect after a restart")
		}
		log.Info("configuration reloaded")
		if next.Server != prev.Server || next.TLSVerify != prev.TLSVerify {
			a.Reconnect()
		} else if err := a.RefreshFacts(ctx); err != nil {
			log.Warn("report facts after reload", "err", err)
		}
	}
}

func dataDialOptions(cfg *config.Config, key identity.Keypair, serverKey []byte, taskID, transferID string) transport.DataDialOptions {
	return transport.DataDialOptions{
		URL:                cfg.DataURL(),
		InsecureSkipVerify: cfg.TLSVerify == config.TLSVerifyNone,
		Identity:           key,
		ServerPublic:       serverKey,
		TaskID:             taskID,
		TransferID:         transferID,
	}
}

// ptyDialOptions is the data connection of one terminal: the same transport on the terminal path
// and prologue (doc/design/pty.md "crha").
func ptyDialOptions(
	cfg *config.Config,
	key identity.Keypair,
	serverKey []byte,
	ptyID string,
	inputReceived uint64,
) transport.PTYDialOptions {
	return transport.PTYDialOptions{
		URL:                cfg.PTYURL(),
		InsecureSkipVerify: cfg.TLSVerify == config.TLSVerifyNone,
		Identity:           key,
		ServerPublic:       serverKey,
		PTYID:              ptyID,
		InputReceived:      inputReceived,
	}
}

func dialOptions(cfg *config.Config, key identity.Keypair, serverKey []byte, init *protocol.HandshakeInit) transport.DialOptions {
	return transport.DialOptions{
		URL:                cfg.AgentURL(),
		InsecureSkipVerify: cfg.TLSVerify == config.TLSVerifyNone,
		Identity:           key,
		ServerPublic:       serverKey,
		Init:               init,
	}
}

// nodeFacts collects this node's facts; the shells are the ones the process discovered, since that
// is what `shell` commands run on (doc/design/protocol.md "Events").
func nodeFacts(cfg *config.Config, env *execenv.Environment) protocol.Facts {
	f := facts.Collect()
	if cfg.Notes != "" {
		notes := cfg.Notes
		f.NotesPath = &notes
	}
	f.Shells = &protocol.Shells{Sh: env.Shell}
	if env.Bash != "" {
		bash := env.Bash
		f.Shells.Bash = &bash
	}
	return facts.Clean(f)
}

// metricsDisks converts the configured filesystems to the metrics collector's form.
func metricsDisks(disks []config.MetricsDisk) []metrics.Disk {
	out := make([]metrics.Disk, len(disks))
	for i, disk := range disks {
		out[i] = metrics.Disk{Name: disk.Name, Path: disk.Path}
	}
	return out
}

// metricsDisksLog renders the collected filesystems as "root=/ data=/srv" for the startup log.
func metricsDisksLog(disks []metrics.Disk) string {
	if len(disks) == 0 {
		return "none"
	}
	parts := make([]string, len(disks))
	for i, disk := range disks {
		parts[i] = disk.Name + "=" + disk.Path
	}
	return strings.Join(parts, " ")
}

// metricsInterfacesLog renders the collected interfaces for the startup log: the configured names, or
// the automatic selection with what it picks now.
func metricsInterfacesLog(targets metrics.Targets) string {
	if !targets.AutoInterfaces {
		if len(targets.Interfaces) == 0 {
			return "none"
		}
		return strings.Join(targets.Interfaces, ",")
	}
	now := "none"
	if len(targets.AutoNow) > 0 {
		now = strings.Join(targets.AutoNow, ",")
	}
	if targets.AutoErr != nil {
		return fmt.Sprintf("auto (now: %s, error: %v)", now, targets.AutoErr)
	}
	return fmt.Sprintf("auto (now: %s)", now)
}

// metricsDroppedLog names every configuration entry the collector discarded and why.
func metricsDroppedLog(dropped []metrics.DroppedTarget) string {
	parts := make([]string, len(dropped))
	for i, target := range dropped {
		parts[i] = fmt.Sprintf("%s %q: %s", target.Kind, target.Name, target.Reason)
	}
	return strings.Join(parts, ", ")
}

// nativeEscalation returns the argv prefix that runs the native helper as the target identity. The
// helper's executable and "privileged stdio" are appended to it; sudo and doas run non-interactively
// with -n, and run0 is the experimental systemd backend (doc/design/privilege.md "Native mode").
func nativeEscalation(tool string) []string {
	switch tool {
	case config.NativeDoas:
		return []string{"doas", "-n"}
	case config.NativeRun0:
		return []string{"run0", "--pipe", "--no-ask-password"}
	default:
		return []string{"sudo", "-n"}
	}
}

func newPrivilegedCmd() *cobra.Command {
	cmd := &cobra.Command{
		Use:   "privileged",
		Short: "Privileged mode commands",
	}

	var configPath string
	var noPersistUsed bool
	var startDebug func(context.Context) error
	run := &cobra.Command{
		Use:   "run",
		Short: "Run crha in privileged mode",
		Long: `Run crha in privileged mode: listen on the local unix socket, verify authorizations and
execute privileged tasks as this process's Linux user. SIGHUP reloads the trust configuration.`,
		Args: cobra.NoArgs,
		RunE: func(cmd *cobra.Command, _ []string) error {
			return runPrivilegedWithDebug(cmd.Context(), configPath, noPersistUsed, startDebug)
		},
	}
	run.Flags().StringVar(&configPath, "config", "", "path to the privileged config file (required)")
	run.Flags().BoolVar(&noPersistUsed, "no-persist-used", false,
		"keep the used list in memory only; for embedded devices with limited disk endurance. "+
			"Lowers security: after the privileged mode restarts, a one-shot authorization can run "+
			"again until its deadline")
	_ = run.MarkFlagRequired("config")
	startDebug = addDebugFlags(run)

	stdio := &cobra.Command{
		Use:   "stdio",
		Short: "Execute one privileged task for the non-privileged mode (native helper)",
		Long: `Execute one privileged task over the crh-priv protocol on stdin and stdout.

The non-privileged mode starts this command through sudo -n, doas -n or run0 when
[privileged] mode = "native". It is not a security boundary: whoever may run it
non-interactively may submit any task, so the sudoers rule is the real grant. Do not
run it from a terminal.`,
		Args: cobra.NoArgs,
		RunE: func(cmd *cobra.Command, _ []string) error {
			ctx, stop := signal.NotifyContext(cmd.Context(), syscall.SIGINT, syscall.SIGTERM)
			defer stop()
			return helper.Stdio(ctx, os.Stdin, os.Stdout, os.Stderr, version.Version, helper.StdioOptions{})
		},
	}

	cmd.AddCommand(run, stdio)
	return cmd
}

// runPrivileged is `crha privileged run`: load the trust configuration, open the local log and
// serve the socket until SIGINT/SIGTERM.
func runPrivileged(ctx context.Context, configPath string, noPersistUsed bool) error {
	return runPrivilegedWithDebug(ctx, configPath, noPersistUsed, nil)
}

// runPrivilegedWithDebug is runPrivileged plus the optional starter of a debug build's facilities
// (pprof). startDebug is nil in normal builds and when the debug flag was not given.
func runPrivilegedWithDebug(ctx context.Context, configPath string, noPersistUsed bool, startDebug func(context.Context) error) error {
	// One logger for the whole process, in whatever format this process's stderr needs. It is also
	// the default, so the standard library's log (the debug build's pprof lines) goes through it.
	logger := logging.New(os.Stderr)
	slog.SetDefault(logger)
	// The process context exists before anything else: a debug listener started below stops when the
	// process is asked to shut down, including the early-exit paths.
	ctx, stop := signal.NotifyContext(ctx, syscall.SIGINT, syscall.SIGTERM)
	defer stop()
	if startDebug != nil {
		if err := startDebug(ctx); err != nil {
			return err
		}
	}
	// The privileged process resolves its own environment: the fixed PATH, root's identity and the
	// shells it discovered. A failure keeps the privileged mode from starting at all.
	env, err := resolveEnv(execenv.Options{Privileged: true})
	if err != nil {
		return err
	}
	cfg, err := privconfig.Load(configPath)
	if err != nil {
		return err
	}
	localLog, err := audit.Open(cfg.LogPath, audit.Options{Logger: logger})
	if err != nil {
		return err
	}
	defer localLog.Close()
	server, err := daemon.New(cfg, daemon.Options{
		ConfigPath:    configPath,
		Version:       version.Version,
		Log:           localLog,
		Env:           env,
		Logger:        logger,
		NoPersistUsed: noPersistUsed,
	})
	if err != nil {
		return err
	}
	return server.Run(ctx)
}
