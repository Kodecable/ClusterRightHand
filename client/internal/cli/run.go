package cli

import (
	"context"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"os"
	"os/signal"
	"path/filepath"
	"strconv"
	"sync/atomic"
	"syscall"
	"time"

	"github.com/Kodecable/ClusterRightHand/client/internal/agent"
	"github.com/Kodecable/ClusterRightHand/client/internal/config"
	"github.com/Kodecable/ClusterRightHand/client/internal/facts"
	"github.com/Kodecable/ClusterRightHand/client/internal/identity"
	"github.com/Kodecable/ClusterRightHand/client/internal/janitor"
	"github.com/Kodecable/ClusterRightHand/client/internal/privileged/audit"
	privconfig "github.com/Kodecable/ClusterRightHand/client/internal/privileged/config"
	"github.com/Kodecable/ClusterRightHand/client/internal/privileged/daemon"
	"github.com/Kodecable/ClusterRightHand/client/internal/privileged/helper"
	"github.com/Kodecable/ClusterRightHand/client/internal/privileged/localclient"
	"github.com/Kodecable/ClusterRightHand/client/internal/protocol"
	"github.com/Kodecable/ClusterRightHand/client/internal/transport"
	"github.com/Kodecable/ClusterRightHand/client/internal/version"
	"github.com/spf13/cobra"
)

// privilegedConfigPath is the default privileged.toml location of `crha privileged run`.
const privilegedConfigPath = privconfig.DefaultPath

func newRunCmd() *cobra.Command {
	var configPath string
	cmd := &cobra.Command{
		Use:   "run",
		Short: "Run crha in non-privileged mode",
		Long:  "Run crha in non-privileged mode. SIGHUP (or `crha reload`) re-reads the configuration.",
		Args:  cobra.NoArgs,
		RunE: func(cmd *cobra.Command, _ []string) error {
			return run(cmd.Context(), configPath)
		},
	}
	cmd.Flags().StringVar(&configPath, "config", config.DefaultPath, "path to the config file")
	return cmd
}

func run(ctx context.Context, configPath string) error {
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
	pidPath := filepath.Join(first.StateDir, "crha.pid")
	if err := os.WriteFile(pidPath, []byte(strconv.Itoa(os.Getpid())+"\n"), 0o644); err != nil {
		return err
	}
	defer os.Remove(pidPath)

	ctx, stop := signal.NotifyContext(ctx, syscall.SIGINT, syscall.SIGTERM)
	defer stop()
	log := slog.New(slog.NewTextHandler(os.Stderr, nil))
	a := agent.New(agent.Options{
		Dial: func(ctx context.Context) (*transport.Conn, error) {
			return transport.Dial(ctx, dialOptions(cfg.Load(), key, serverKey, &protocol.HandshakeInit{CRHAVersion: version.Version}))
		},
		Facts:            func() protocol.Facts { return nodeFacts(cfg.Load()) },
		OutputDir:        first.Output.Dir,
		PrivilegedMode:   first.Privilege.Mode,
		PrivilegedSocket: first.Privilege.Socket,
		NativePrefix:     nativeEscalation(first.Privilege.Native),
		ClockWarn:        first.ClockWarn,
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
// Groups and notes are reported again; a changed server or TLS setting reconnects. Settings fixed at
// start (state_dir, output, privileged mode) need a restart.
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

func nodeFacts(cfg *config.Config) protocol.Facts {
	f := facts.Collect()
	f.NotesPath = cfg.Notes
	f.Groups = cfg.Groups
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

	var configPath, socketPath string
	run := &cobra.Command{
		Use:   "run",
		Short: "Run crha in privileged mode",
		Long: `Run crha in privileged mode: listen on the local unix socket, verify authorizations and
execute privileged tasks as this process's Linux user. SIGHUP reloads the trust configuration.`,
		Args: cobra.NoArgs,
		RunE: func(cmd *cobra.Command, _ []string) error {
			return runPrivileged(cmd.Context(), configPath)
		},
	}
	run.Flags().StringVar(&configPath, "config", privilegedConfigPath, "path to the privileged config file")

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

	revoke := &cobra.Command{
		Use:   "revoke <authorization-id>",
		Short: "Revoke an authorization locally",
		Long:  "Add the authorization id (hex SHA-256 of its payload) to the privileged mode's revocation list.",
		Args:  cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			return revokeLocally(cmd.Context(), cmd.OutOrStdout(), socketPath, args[0])
		},
	}
	revoke.Flags().StringVar(&socketPath, "socket", privconfig.DefaultSocket, "path to the privileged mode's socket")

	cmd.AddCommand(run, stdio, revoke)
	return cmd
}

// runPrivileged is `crha privileged run`: load the trust configuration, open the local log and
// serve the socket until SIGINT/SIGTERM.
func runPrivileged(ctx context.Context, configPath string) error {
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
		ConfigPath: configPath,
		Version:    version.Version,
		Log:        log,
		Logger:     slog.New(slog.NewTextHandler(os.Stderr, nil)),
	})
	if err != nil {
		return err
	}
	ctx, stop := signal.NotifyContext(ctx, syscall.SIGINT, syscall.SIGTERM)
	defer stop()
	return server.Run(ctx)
}

// revokeLocally adds an authorization id to the revocation list through the local-role socket.
func revokeLocally(ctx context.Context, out io.Writer, socket, text string) error {
	id, err := parseAuthorizationID(text)
	if err != nil {
		return err
	}
	client, err := localclient.Dial(ctx, socket, version.Version)
	if err != nil {
		return err
	}
	defer client.Close()
	if err := client.Revoke(ctx, id); err != nil {
		return err
	}
	fmt.Fprintf(out, "revoked %x\n", id[:])
	return nil
}

// parseAuthorizationID parses the 32-byte hex authorization id of `crha privileged revoke`.
func parseAuthorizationID(text string) ([32]byte, error) {
	var id [32]byte
	raw, err := hex.DecodeString(text)
	if err != nil || len(raw) != len(id) {
		return id, fmt.Errorf("authorization id %q is not 32 bytes of hex", text)
	}
	copy(id[:], raw)
	return id, nil
}
