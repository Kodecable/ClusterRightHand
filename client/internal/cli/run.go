package cli

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"os"
	"os/signal"
	"path/filepath"
	"sync/atomic"
	"syscall"
	"time"

	"github.com/Kodecable/ClusterRightHand/client/internal/agent"
	"github.com/Kodecable/ClusterRightHand/client/internal/config"
	"github.com/Kodecable/ClusterRightHand/client/internal/execenv"
	"github.com/Kodecable/ClusterRightHand/client/internal/facts"
	"github.com/Kodecable/ClusterRightHand/client/internal/identity"
	"github.com/Kodecable/ClusterRightHand/client/internal/janitor"
	"github.com/Kodecable/ClusterRightHand/client/internal/privileged/audit"
	privconfig "github.com/Kodecable/ClusterRightHand/client/internal/privileged/config"
	"github.com/Kodecable/ClusterRightHand/client/internal/privileged/daemon"
	"github.com/Kodecable/ClusterRightHand/client/internal/privileged/helper"
	"github.com/Kodecable/ClusterRightHand/client/internal/protocol"
	"github.com/Kodecable/ClusterRightHand/client/internal/transport"
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
	// shell and an identity must not run tasks at all (doc/execution-plane.md#exec-的执行环境).
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

	log := slog.New(slog.NewTextHandler(os.Stderr, nil))
	a := agent.New(agent.Options{
		Dial: func(ctx context.Context) (*transport.Conn, error) {
			return transport.Dial(ctx, dialOptions(cfg.Load(), key, serverKey, &protocol.HandshakeInit{CRHAVersion: version.Version}))
		},
		Facts:            func() protocol.Facts { return nodeFacts(cfg.Load(), env) },
		OutputDir:        first.Output.Dir,
		PrivilegedMode:   first.Privilege.Mode,
		PrivilegedSocket: first.Privilege.Socket,
		NativePrefix:     nativeEscalation(first.Privilege.Native),
		ClockWarn:        first.ClockWarn,
		Env:              env,
		Logger:           log,
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
			next.ClockWarn != prev.ClockWarn {
			log.Warn("state_dir, clock_warn, [output] and [privileged] changes take effect after a restart")
		}
		log.Info("configuration reloaded")
		if next.Server != prev.Server || next.TLSVerify != prev.TLSVerify {
			a.Reconnect()
		} else if err := a.RefreshFacts(ctx); err != nil {
			log.Warn("report facts after reload", "err", err)
		}
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
// is what `shell` commands run on (doc/protocol.md Facts).
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

// nativeEscalation returns the argv prefix that runs the native helper as the target identity. The
// helper's executable and "privileged stdio" are appended to it; sudo and doas run non-interactively
// with -n, and run0 is the experimental systemd backend (doc/privilege.md, native).
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
			return helper.Stdio(ctx, os.Stdin, os.Stdout, os.Stderr, version.Version)
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
	log, err := audit.Open(cfg.LogPath, audit.Options{})
	if err != nil {
		return err
	}
	defer log.Close()
	server, err := daemon.New(cfg, daemon.Options{
		ConfigPath:    configPath,
		Version:       version.Version,
		Log:           log,
		Env:           env,
		Logger:        slog.New(slog.NewTextHandler(os.Stderr, nil)),
		NoPersistUsed: noPersistUsed,
	})
	if err != nil {
		return err
	}
	return server.Run(ctx)
}
