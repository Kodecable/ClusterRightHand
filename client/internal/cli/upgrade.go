package cli

import (
	"errors"
	"fmt"
	"os"
	"os/signal"
	"syscall"

	"github.com/spf13/cobra"

	"github.com/Kodecable/ClusterRightHand/client/internal/upgrade"
	"github.com/Kodecable/ClusterRightHand/client/internal/version"
)

// errPackageManaged refuses a self-upgrade when the system package manager owns the binary.
var errPackageManaged = errors.New("crha is managed by the system package manager; upgrade it with apt or dnf")

// newUpgradeCmd is `crha upgrade`: the upgrade log and a manual rollback. Upgrades themselves are
// started from crhs (doc/design/distribution.md "crha self-upgrade").
func newUpgradeCmd() *cobra.Command {
	cmd := &cobra.Command{
		Use:   "upgrade",
		Short: "Show the upgrade log or roll back the last upgrade (upgrades are started from crhs)",
		Args:  cobra.NoArgs,
		RunE: func(cmd *cobra.Command, _ []string) error {
			return cmd.Help()
		},
	}
	cmd.AddCommand(newUpgradeStatusCmd(), newUpgradeRollbackCmd())
	return cmd
}

func newUpgradeStatusCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "status",
		Short: "Print the last upgrade's outcome, what a rollback would do, and the upgrade log",
		Args:  cobra.NoArgs,
		RunE: func(cmd *cobra.Command, _ []string) error {
			out := cmd.OutOrStdout()
			fmt.Fprintln(out, upgrade.Summary("", upgrade.Dir))
			entries, err := upgrade.ReadLog(upgrade.Dir)
			if errors.Is(err, os.ErrNotExist) {
				return nil
			}
			if err != nil {
				return err
			}
			for _, e := range entries {
				fmt.Fprintf(out, "%s %s %s→%s %-5s %-12s %s\n", e.TS, e.UpgradeID, e.From, e.To, e.Level, e.Step, e.Msg)
			}
			return nil
		},
	}
}

func newUpgradeRollbackCmd() *cobra.Command {
	var force bool
	cmd := &cobra.Command{
		Use:   "rollback",
		Short: "Undo the upgrade that produced the running version (as root)",
		Long: "Restores the files the upgrade to the running version replaced, reloads systemd and starts crha " +
			"again, for when the new version cannot reach crhs. It only goes to a lower release, and refuses " +
			"when a file changed since the upgrade wrote it unless --force is given. Run it again to step " +
			"back through an older upgrade, while its backup is kept.",
		Args: cobra.NoArgs,
		RunE: func(cmd *cobra.Command, _ []string) error {
			if version.PackageManaged {
				return errPackageManaged
			}
			if os.Geteuid() != 0 {
				return errors.New("crha upgrade rollback must run as root")
			}
			return upgrade.Rollback(cmd.Context(), upgrade.RollbackOptions{Force: force, Out: cmd.OutOrStdout()})
		},
	}
	cmd.Flags().BoolVar(&force, "force", false, "restore the backup over files that changed since the upgrade")
	return cmd
}

// newUpgradeInstallCmd is the hidden subcommand the new binary runs in its transient unit
// (doc/design/distribution.md "On the node"). Nothing but crha's own hand-over starts it.
func newUpgradeInstallCmd() *cobra.Command {
	var from, to, taskID string
	cmd := &cobra.Command{
		Use:    upgrade.InstallCommand,
		Hidden: true,
		Args:   cobra.NoArgs,
		RunE: func(cmd *cobra.Command, _ []string) error {
			if version.PackageManaged {
				return errPackageManaged
			}
			if os.Geteuid() != 0 {
				return errors.New("the upgrade installer must run as root")
			}
			if to != version.Version {
				return fmt.Errorf("this binary is crha %s, not %s", version.Version, to)
			}
			ctx, stop := signal.NotifyContext(cmd.Context(), syscall.SIGTERM, syscall.SIGINT)
			defer stop()
			return upgrade.Install(ctx, upgrade.InstallOptions{From: from, To: to, TaskID: taskID})
		},
	}
	cmd.Flags().StringVar(&from, "from", "", "the version being replaced")
	cmd.Flags().StringVar(&to, "to", "", "this binary's version")
	cmd.Flags().StringVar(&taskID, "task", "", "the node.upgrade task that handed over")
	for _, name := range []string{"from", "to", "task"} {
		_ = cmd.MarkFlagRequired(name)
	}
	return cmd
}
