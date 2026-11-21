package units

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"github.com/Kodecable/ClusterRightHand/client/internal/config"
)

// Runner runs a program to completion and returns its output; it fails when the program does.
type Runner func(ctx context.Context, name string, args ...string) ([]byte, error)

// Systemctl runs systemctl with args.
func Systemctl(ctx context.Context, run Runner, args ...string) error {
	output, err := run(ctx, "systemctl", args...)
	if err != nil {
		return fmt.Errorf("systemctl %s: %w: %s", strings.Join(args, " "), err, strings.TrimSpace(string(output)))
	}
	return nil
}

// Present lists the units crha may run whose files are in Dir below root, in start order. They are
// the ones to stop before crha's files change: the privileged mode keeps writing its state while it
// runs, so both must be gone first.
func Present(root string) []string {
	var out []string
	for _, name := range Names(config.ModeForward) {
		if _, err := os.Stat(filepath.Join(root, Dir, name)); err == nil {
			out = append(out, name)
		}
	}
	return out
}

// Stop stops names together.
func Stop(ctx context.Context, run Runner, names []string) error {
	if len(names) == 0 {
		return nil
	}
	return Systemctl(ctx, run, append([]string{"stop"}, names...)...)
}

// Start starts names one at a time in order, the privileged mode before crha, as the packages do.
func Start(ctx context.Context, run Runner, names []string) error {
	for _, name := range names {
		if err := Systemctl(ctx, run, "start", name); err != nil {
			return err
		}
	}
	return nil
}
