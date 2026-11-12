// Package cli defines the crha command tree.
package cli

import (
	"errors"

	"github.com/Kodecable/ClusterRightHand/client/internal/version"
	"github.com/spf13/cobra"
)

var errNotImplemented = errors.New("not implemented")

func notImplemented(*cobra.Command, []string) error { return errNotImplemented }

func NewRootCmd() *cobra.Command {
	root := &cobra.Command{
		Use:           "crha",
		Short:         "ClusterRightHand node client",
		Version:       version.String(),
		SilenceUsage:  true,
		SilenceErrors: true,
	}
	// --version prints the same line as the version command.
	root.SetVersionTemplate("{{.Version}}\n")
	root.AddCommand(
		newRunCmd(),
		newPrivilegedCmd(),
		newEnrollCmd(),
		newRegisterCmd(),
		newStatusCmd(),
		newUpgradeCmd(),
		newGrantCmd(),
		newPendingCmd(),
		newApproveCmd(),
		newDenyCmd(),
		newVersionCmd(),
	)
	return root
}
