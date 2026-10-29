package cli

import (
	"context"
	"fmt"
	"io"
	"text/tabwriter"
	"time"

	"github.com/spf13/cobra"

	"github.com/Kodecable/ClusterRightHand/client/internal/privileged/authz"
	privconfig "github.com/Kodecable/ClusterRightHand/client/internal/privileged/config"
	"github.com/Kodecable/ClusterRightHand/client/internal/privileged/localclient"
	"github.com/Kodecable/ClusterRightHand/client/internal/protocol"
	"github.com/Kodecable/ClusterRightHand/client/internal/version"
)

func newGrantCmd() *cobra.Command {
	var (
		nodes                 []string
		method, exact, prefix string
		deadline, task, key   string
	)
	cmd := &cobra.Command{
		Use:   "grant",
		Short: "Sign an authorization for privileged tasks",
		Args:  cobra.NoArgs,
		RunE:  notImplemented,
	}
	f := cmd.Flags()
	f.StringSliceVar(&nodes, "nodes", nil, `node ids, "group:<name>", or "*"`)
	f.StringVar(&method, "method", "", "exec, file.read or file.write")
	f.StringVar(&exact, "exact", "", "allow exactly this target")
	f.StringVar(&prefix, "prefix", "", "allow targets starting with this prefix")
	f.StringVar(&deadline, "deadline", "", "authorization deadline")
	f.StringVar(&task, "task", "", "bind the authorization to a task id")
	f.StringVar(&key, "key", "", "path to the signing SSH key")
	cmd.MarkFlagsMutuallyExclusive("exact", "prefix")
	_ = cmd.MarkFlagRequired("nodes")
	return cmd
}

func newPendingCmd() *cobra.Command {
	var socketPath string
	cmd := &cobra.Command{
		Use:   "pending",
		Short: "List tasks pending local approval",
		Args:  cobra.NoArgs,
		RunE: func(cmd *cobra.Command, _ []string) error {
			return showPending(cmd.Context(), cmd.OutOrStdout(), socketPath)
		},
	}
	cmd.Flags().StringVar(&socketPath, "socket", privconfig.DefaultSocket, "path to the privileged mode's socket")
	return cmd
}

func newApproveCmd() *cobra.Command {
	var socketPath string
	var attempt uint64
	cmd := &cobra.Command{
		Use:   "approve <task-id>",
		Short: "Approve a pending task locally",
		Long: `Approve the local request of one task. When several attempts of the task are pending, the
highest attempt is approved unless --attempt is given.`,
		Args: cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			return decidePending(cmd.Context(), cmd.OutOrStdout(), socketPath, args[0], attempt, "", true)
		},
	}
	cmd.Flags().StringVar(&socketPath, "socket", privconfig.DefaultSocket, "path to the privileged mode's socket")
	cmd.Flags().Uint64Var(&attempt, "attempt", 0, "approve this attempt instead of the highest pending one")
	return cmd
}

func newDenyCmd() *cobra.Command {
	var socketPath, message string
	var attempt uint64
	cmd := &cobra.Command{
		Use:   "deny <task-id>",
		Short: "Deny a pending task locally",
		Args:  cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			return decidePending(cmd.Context(), cmd.OutOrStdout(), socketPath, args[0], attempt, message, false)
		},
	}
	cmd.Flags().StringVar(&socketPath, "socket", privconfig.DefaultSocket, "path to the privileged mode's socket")
	cmd.Flags().Uint64Var(&attempt, "attempt", 0, "deny this attempt instead of the highest pending one")
	cmd.Flags().StringVar(&message, "message", "", "reason shown to crhs and the user")
	return cmd
}

// showPending prints the tasks waiting for local approval: task id, attempt, method and
// target, note and age.
func showPending(ctx context.Context, out io.Writer, socket string) error {
	client, err := localclient.Dial(ctx, socket, version.Version)
	if err != nil {
		return err
	}
	defer client.Close()
	entries, err := client.Pending(ctx)
	if err != nil {
		return err
	}
	if len(entries) == 0 {
		fmt.Fprintln(out, "no tasks are pending local approval")
		return nil
	}
	w := tabwriter.NewWriter(out, 0, 4, 2, ' ', 0)
	fmt.Fprintln(w, "TASK ID\tATTEMPT\tMETHOD\tTARGET\tNOTE\tAGE")
	now := time.Now()
	for i := range entries {
		entry := &entries[i]
		method, target := "-", "-"
		if m, t, err := authz.Target(&entry.Spec); err == nil {
			method, target = m, t
		}
		age := now.Sub(time.UnixMilli(int64(entry.ReceivedAtMS))).Round(time.Second)
		if age < 0 {
			age = 0
		}
		fmt.Fprintf(w, "%s\t%d\t%s\t%s\t%s\t%s\n",
			entry.TaskID, entry.Attempt, method, target, noteText(entry.Note), age)
	}
	return w.Flush()
}

// noteText keeps a note on one line and quotes it when it has spaces.
func noteText(note string) string {
	if note == "" {
		return "-"
	}
	return fmt.Sprintf("%q", note)
}

// decidePending approves or denies one task. attempt 0 selects the highest pending attempt of
// that task, as the brief for `crha approve` requires.
func decidePending(ctx context.Context, out io.Writer, socket, taskID string, attempt uint64, message string, approve bool) error {
	client, err := localclient.Dial(ctx, socket, version.Version)
	if err != nil {
		return err
	}
	defer client.Close()
	entries, err := client.Pending(ctx)
	if err != nil {
		return err
	}
	chosen, ok := chooseAttempt(entries, taskID, attempt)
	if !ok {
		if attempt != 0 {
			return fmt.Errorf("no pending local request for task %s attempt %d", taskID, attempt)
		}
		return fmt.Errorf("no pending local request for task %s", taskID)
	}
	if approve {
		err = client.Approve(ctx, taskID, chosen, message)
	} else {
		err = client.Deny(ctx, taskID, chosen, message)
	}
	if err != nil {
		return err
	}
	action := "approved"
	if !approve {
		action = "denied"
	}
	fmt.Fprintf(out, "%s task %s attempt %d\n", action, taskID, chosen)
	return nil
}

// chooseAttempt returns the requested attempt or, when attempt is 0, the highest pending
// attempt of taskID.
func chooseAttempt(entries []protocol.PendingEntry, taskID string, attempt uint64) (uint64, bool) {
	var best uint64
	found := false
	for i := range entries {
		entry := &entries[i]
		if entry.TaskID != taskID {
			continue
		}
		value := uint64(entry.Attempt)
		if attempt != 0 {
			if value == attempt {
				return value, true
			}
			continue
		}
		if !found || value > best {
			best, found = value, true
		}
	}
	if attempt != 0 {
		return 0, false
	}
	return best, found
}
