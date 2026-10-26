package cli

import (
	"context"
	"fmt"
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
	"github.com/Kodecable/ClusterRightHand/client/internal/proto/crhv1"
	"github.com/Kodecable/ClusterRightHand/client/internal/transport"
	"github.com/Kodecable/ClusterRightHand/client/internal/version"
	"github.com/spf13/cobra"
)

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
			return transport.Dial(ctx, dialOptions(cfg.Load(), key, serverKey, &crhv1.HandshakeInit{CrhaVersion: version.Version}))
		},
		Facts:          func() *crhv1.Facts { return nodeFacts(cfg.Load()) },
		Version:        version.Version,
		OutputDir:      first.Output.Dir,
		PrivilegedMode: first.Privilege.Mode,
		Logger:         log,
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
	if err := a.Run(ctx); err != nil && ctx.Err() == nil {
		return err
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
		if next.StateDir != prev.StateDir || next.Output != prev.Output || next.Privilege != prev.Privilege {
			log.Warn("state_dir, [output] and [privileged] changes take effect after a restart")
		}
		log.Info("configuration reloaded")
		if next.Server != prev.Server || next.TLSVerify != prev.TLSVerify {
			a.Reconnect()
		} else if err := a.RefreshFacts(ctx); err != nil {
			log.Warn("report facts after reload", "err", err)
		}
	}
}

func dialOptions(cfg *config.Config, key identity.Keypair, serverKey []byte, init *crhv1.HandshakeInit) transport.DialOptions {
	return transport.DialOptions{
		URL:                cfg.AgentURL(),
		InsecureSkipVerify: cfg.TLSVerify == config.TLSVerifyNone,
		Identity:           key,
		ServerPublic:       serverKey,
		Init:               init,
	}
}

func nodeFacts(cfg *config.Config) *crhv1.Facts {
	f := facts.Collect()
	f.NotesPath = cfg.Notes
	f.Groups = cfg.Groups
	return f
}

func newPrivilegedCmd() *cobra.Command {
	cmd := &cobra.Command{
		Use:   "privileged",
		Short: "Privileged mode commands",
	}

	var config string
	run := &cobra.Command{
		Use:   "run",
		Short: "Run crha in privileged mode",
		Args:  cobra.NoArgs,
		RunE:  notImplemented,
	}
	run.Flags().StringVar(&config, "config", "/etc/crha/privileged.toml", "path to the config file")

	revoke := &cobra.Command{
		Use:   "revoke <authorization-id>",
		Short: "Revoke an authorization locally",
		Args:  cobra.ExactArgs(1),
		RunE:  notImplemented,
	}

	cmd.AddCommand(run, revoke)
	return cmd
}
