package cli

import (
	"context"
	"fmt"
	"io"
	"os"
	"time"

	"github.com/spf13/cobra"

	"github.com/Kodecable/ClusterRightHand/client/internal/privileged/localclient"
	"github.com/Kodecable/ClusterRightHand/client/internal/protocol"
	"github.com/Kodecable/ClusterRightHand/client/internal/version"
)

// defaultApprovalSocket is the socket `crha approve` and `crha lock` try when neither --socket
// nor CRHA_PRIVILEGED_SOCKET is set. It exists only for a local administrator typing the
// commands on the node; nothing else in crha may use it.
const defaultApprovalSocket = "/run/crha/privileged.sock"

// approvalSocketEnv overrides defaultApprovalSocket for the local window commands.
const approvalSocketEnv = "CRHA_PRIVILEGED_SOCKET"

// approvalSocketUsage is the --socket help of the local window commands.
const approvalSocketUsage = "path to the privileged mode's socket (default: $" + approvalSocketEnv + " or " + defaultApprovalSocket + ")"

// resolveApprovalSocket resolves the socket of the local window commands. An explicitly set
// --socket wins, then a non-empty CRHA_PRIVILEGED_SOCKET, then defaultApprovalSocket.
func resolveApprovalSocket(flagValue string, flagSet bool) string {
	if flagSet {
		return flagValue
	}
	if value := os.Getenv(approvalSocketEnv); value != "" {
		return value
	}
	return defaultApprovalSocket
}

func newApproveCmd() *cobra.Command {
	var socketPath, length string
	cmd := &cobra.Command{
		Use:   "approve",
		Short: "Open the local approval window, or show its state",
		Long: `Open a time-limited local approval window on this node, or print its current state.

While the window is open, a privileged task authorized by crhs's own signature runs on this
node without the limits of the node's crhs trust entry: no guard rules, environment
allowlist, require_spec, max_ttl or execute-kind requirement apply. crhs effectively holds
the privileged identity on this node, including the ability to change the trust
configuration, so open the window only when you mean that.

Opening the window releases every privileged task waiting on this node, for every user and
every task group: crhs sends each of them with its own signature at once. The window is not
tied to the task you opened it for.

The window closes when it expires, when you run ` + "`crha lock`" + `, or when the privileged mode
restarts. Opening it again replaces the current window. The requested length must be positive
and no longer than max_window of the local trust entries that list your uid.`,
		Args: cobra.NoArgs,
		RunE: func(cmd *cobra.Command, _ []string) error {
			socket := resolveApprovalSocket(socketPath, cmd.Flags().Changed("socket"))
			if !cmd.Flags().Changed("for") {
				return showWindow(cmd.Context(), cmd.OutOrStdout(), socket)
			}
			duration, err := time.ParseDuration(length)
			if err != nil {
				return fmt.Errorf("--for: %w", err)
			}
			if duration <= 0 {
				return fmt.Errorf("--for: the window length must be positive")
			}
			return openWindow(cmd.Context(), cmd.OutOrStdout(), socket, duration)
		},
	}
	cmd.Flags().StringVar(&socketPath, "socket", "", approvalSocketUsage)
	cmd.Flags().StringVar(&length, "for", "", "open the window for this long (for example 30m); without it, show the state")
	return cmd
}

func newLockCmd() *cobra.Command {
	var socketPath string
	cmd := &cobra.Command{
		Use:   "lock",
		Short: "Close the local approval window",
		Args:  cobra.NoArgs,
		RunE: func(cmd *cobra.Command, _ []string) error {
			socket := resolveApprovalSocket(socketPath, cmd.Flags().Changed("socket"))
			return closeWindow(cmd.Context(), cmd.OutOrStdout(), socket)
		},
	}
	cmd.Flags().StringVar(&socketPath, "socket", "", approvalSocketUsage)
	return cmd
}

// showWindow prints whether the local approval window is open and until when.
func showWindow(ctx context.Context, out io.Writer, socket string) error {
	client, err := localclient.Dial(ctx, socket, version.Version)
	if err != nil {
		return err
	}
	defer client.Close()
	state, err := client.Window(ctx)
	if err != nil {
		return err
	}
	_, err = fmt.Fprintln(out, windowText(state))
	return err
}

// openWindow opens or replaces the window and prints its state.
func openWindow(ctx context.Context, out io.Writer, socket string, length time.Duration) error {
	client, err := localclient.Dial(ctx, socket, version.Version)
	if err != nil {
		return err
	}
	defer client.Close()
	state, err := client.Open(ctx, length)
	if err != nil {
		return err
	}
	if _, err := fmt.Fprintln(out, windowText(state)); err != nil {
		return err
	}
	_, err = fmt.Fprintln(out, windowOpenedNote)
	return err
}

// closeWindow closes the window and prints its state.
func closeWindow(ctx context.Context, out io.Writer, socket string) error {
	client, err := localclient.Dial(ctx, socket, version.Version)
	if err != nil {
		return err
	}
	defer client.Close()
	state, err := client.CloseWindow(ctx)
	if err != nil {
		return err
	}
	_, err = fmt.Fprintln(out, windowText(state))
	return err
}

// windowOpenedNote is printed after a window opens: it releases more than the task it was opened for.
const windowOpenedNote = "every privileged task waiting on this node, for any user or task group, can now run with crhs's signature; run `crha lock` to close the window early"

// formatMillis renders a Unix millisecond timestamp as RFC 3339 with milliseconds.
func formatMillis(ms int64) string {
	return time.UnixMilli(ms).Format("2006-01-02T15:04:05.000Z07:00")
}

// windowText renders a window state for the CLI.
func windowText(state protocol.WindowState) string {
	if state.Kind != protocol.WindowStateOpen || state.Opened == nil {
		return "the local approval window is closed"
	}
	return fmt.Sprintf("the local approval window is open until %s (opened by uid %d)",
		formatMillis(int64(state.Opened.UntilMS)), uint64(state.Opened.OpenedByUID))
}
