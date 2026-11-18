// Package term detects the terminal the command-line tools ask their questions on.
package term

import (
	"os"

	"golang.org/x/sys/unix"
)

// IsTerminal reports whether f is a terminal.
func IsTerminal(f *os.File) bool {
	_, err := unix.IoctlGetTermios(int(f.Fd()), unix.TCGETS)
	return err == nil
}
