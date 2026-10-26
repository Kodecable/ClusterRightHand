package cli

import "github.com/spf13/cobra"

func newEnrollCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "enroll <server-url> <token>",
		Short: "Enroll this node with a crhs server",
		Args:  cobra.ExactArgs(2),
		RunE:  notImplemented,
	}
}

func newStatusCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "status",
		Short: "Show the status of the running crha",
		Args:  cobra.NoArgs,
		RunE:  notImplemented,
	}
}

func newReloadCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "reload",
		Short: "Ask the running crha to reload its configuration",
		Args:  cobra.NoArgs,
		RunE:  notImplemented,
	}
}

func newRotateKeyCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "rotate-key",
		Short: "Rotate the node key",
		Args:  cobra.NoArgs,
		RunE:  notImplemented,
	}
}

func newUpgradeCmd() *cobra.Command {
	var apply string
	cmd := &cobra.Command{
		Use:   "upgrade",
		Short: "Apply a crha binary upgrade",
		Args:  cobra.NoArgs,
		RunE:  notImplemented,
	}
	cmd.Flags().StringVar(&apply, "apply", "", "path to the new crha binary")
	_ = cmd.MarkFlagRequired("apply")
	return cmd
}

func newMCPCmd() *cobra.Command {
	var url, tokenFile string
	cmd := &cobra.Command{
		Use:   "mcp",
		Short: "Bridge MCP over stdio to the crhs HTTP endpoint",
		Args:  cobra.NoArgs,
		RunE:  notImplemented,
	}
	cmd.Flags().StringVar(&url, "url", "", "MCP endpoint URL")
	cmd.Flags().StringVar(&tokenFile, "token-file", "", "file containing the access token")
	return cmd
}
