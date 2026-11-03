package cli

import (
	"context"

	"github.com/spf13/cobra"
)

// debugFlags, when non-nil, registers the debug-build-only flags on a command and returns the
// function that starts the selected debug services once the process has a cancellable context.
// A normal build leaves it nil: the command has no extra flag and this package does not import
// net/http/pprof. The pprof build sets it in init (pprof_on.go).
var debugFlags func(cmd *cobra.Command) func(context.Context) error

// addDebugFlags is the only non-tagged reference to the hook. It keeps the call sites readable and
// makes the nil check impossible to forget.
func addDebugFlags(cmd *cobra.Command) func(context.Context) error {
	if debugFlags == nil {
		return nil
	}
	return debugFlags(cmd)
}
