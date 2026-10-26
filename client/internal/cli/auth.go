package cli

import "github.com/spf13/cobra"

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
	return &cobra.Command{
		Use:   "pending",
		Short: "List tasks pending local approval",
		Args:  cobra.NoArgs,
		RunE:  notImplemented,
	}
}

func newApproveCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "approve <task-id>",
		Short: "Approve a pending task locally",
		Args:  cobra.ExactArgs(1),
		RunE:  notImplemented,
	}
}
