// Package cli defines the crha command tree.
package cli

import (
	"errors"

	"github.com/spf13/cobra"
)

var errNotImplemented = errors.New("not implemented")

func notImplemented(*cobra.Command, []string) error { return errNotImplemented }

func NewRootCmd() *cobra.Command {
	root := &cobra.Command{
		Use:           "crha",
		Short:         "ClusterRightHand node client",
		SilenceUsage:  true,
		SilenceErrors: true,
	}
	root.AddCommand(
		newRunCmd(),
		newPrivilegedCmd(),
		newEnrollCmd(),
		newStatusCmd(),
		newRotateKeyCmd(),
		newUpgradeCmd(),
		newGrantCmd(),
		newPendingCmd(),
		newApproveCmd(),
		newDenyCmd(),
		newVersionCmd(),
	)
	return root
}
