package cli

import "github.com/spf13/cobra"

func newRunCmd() *cobra.Command {
	var config string
	cmd := &cobra.Command{
		Use:   "run",
		Short: "Run crha in non-privileged mode",
		Args:  cobra.NoArgs,
		RunE:  notImplemented,
	}
	cmd.Flags().StringVar(&config, "config", "/etc/crha/crha.toml", "path to the config file")
	return cmd
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
