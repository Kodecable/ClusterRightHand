package cli

import (
	"context"
	"fmt"
	"log/slog"
	"os"
	"os/signal"
	"syscall"

	"github.com/Kodecable/ClusterRightHand/client/internal/agent"
	"github.com/Kodecable/ClusterRightHand/client/internal/config"
	"github.com/Kodecable/ClusterRightHand/client/internal/facts"
	"github.com/Kodecable/ClusterRightHand/client/internal/identity"
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
		Args:  cobra.NoArgs,
		RunE: func(cmd *cobra.Command, _ []string) error {
			cfg, err := config.Load(configPath)
			if err != nil {
				return err
			}
			key, err := identity.LoadKeypair(cfg.IdentityKeyPath())
			if err != nil {
				return fmt.Errorf("load identity (run \"crha enroll\" first): %w", err)
			}
			serverKey, err := identity.LoadServerKey(cfg.ServerKeyPath())
			if err != nil {
				return err
			}
			if err := os.MkdirAll(cfg.Output.Dir, 0o700); err != nil {
				return err
			}
			ctx, stop := signal.NotifyContext(cmd.Context(), syscall.SIGINT, syscall.SIGTERM)
			defer stop()
			log := slog.New(slog.NewTextHandler(os.Stderr, nil))
			a := agent.New(agent.Options{
				Dial: func(ctx context.Context) (*transport.Conn, error) {
					return transport.Dial(ctx, dialOptions(cfg, key, serverKey, &crhv1.HandshakeInit{CrhaVersion: version.Version}))
				},
				Facts:          func() *crhv1.Facts { return nodeFacts(cfg) },
				Version:        version.Version,
				OutputDir:      cfg.Output.Dir,
				PrivilegedMode: cfg.Privilege.Mode,
				Logger:         log,
			})
			log.Info("crha starting", "server", cfg.AgentURL(), "identity", identity.Fingerprint(key.Public))
			if err := a.Run(ctx); err != nil && ctx.Err() == nil {
				return err
			}
			return nil
		},
	}
	cmd.Flags().StringVar(&configPath, "config", config.DefaultPath, "path to the config file")
	return cmd
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
