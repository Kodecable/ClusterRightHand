// Package crhu defines the crhu command tree, the signing utility for authorization payloads and
// signing-credential registrations.
package crhu

import (
	"github.com/Kodecable/ClusterRightHand/client/internal/version"
	"github.com/spf13/cobra"
)

func NewRootCmd() *cobra.Command {
	root := &cobra.Command{
		Use:           "crhu",
		Short:         "ClusterRightHand signing utility",
		Version:       version.StringFor("crhu"),
		SilenceUsage:  true,
		SilenceErrors: true,
	}
	// --version prints the same line as the version command.
	root.SetVersionTemplate("{{.Version}}\n")
	root.AddCommand(
		newSignCmd(),
		newGrantCmd(),
		newRegisterCmd(),
		newVersionCmd(),
	)
	return root
}
