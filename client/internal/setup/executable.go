package setup

import (
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"syscall"
)

// unitPath is a path ExecStart takes as it is: systemd would split it at a space and expand % and $, and
// the unit parser reads it unquoted.
var unitPath = regexp.MustCompile(`^/[A-Za-z0-9._+@/-]+$`)

// checkUnitPath refuses a path ExecStart cannot carry unquoted.
func checkUnitPath(what, path string) error {
	if !unitPath.MatchString(path) || filepath.Clean(path) != path {
		return fmt.Errorf("%s %q cannot go into a systemd unit: use a clean absolute path of letters, digits and ._+@-", what, path)
	}
	return nil
}

// checkExecutable refuses a binary root would run from a place another user can change: enroll writes
// the running binary into units that run as root, and a self-upgrade replaces it there. The binary and
// every directory above it must belong to root and be writable by no one else (a group other than
// root's counts as someone else).
func checkExecutable(host Host, path string) error {
	if err := checkUnitPath("the crha binary", path); err != nil {
		return err
	}
	// Root's uid, as the filesystem root's owner says: 0 on a host, the test's own uid in a test tree.
	top, err := os.Stat(at(host, "/"))
	if err != nil {
		return err
	}
	rootUID := top.Sys().(*syscall.Stat_t).Uid
	for p := path; ; p = filepath.Dir(p) {
		info, err := os.Stat(at(host, p))
		if err != nil {
			return fmt.Errorf("the crha binary: %w", err)
		}
		st := info.Sys().(*syscall.Stat_t)
		perm := info.Mode().Perm()
		if (st.Uid != 0 && st.Uid != rootUID) || perm&0o002 != 0 || (perm&0o020 != 0 && st.Gid != 0) {
			return fmt.Errorf("the crha binary %s would run as root, but %s can be changed by a user other than root; copy crha to /usr/local/bin and run that one", path, p)
		}
		if p == "/" {
			return nil
		}
	}
}
