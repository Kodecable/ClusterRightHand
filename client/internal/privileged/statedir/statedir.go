// Package statedir checks where the privileged mode keeps its state: the used list and the stdin
// spool. The directory must not be reachable by an unprivileged account that could rename it away
// and put its own directory in its place (doc/design/privilege.md "The privileged mode").
package statedir

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"syscall"
)

// DefaultDir is the state directory of the privileged mode. It is outside crha's own state
// directory, so the unprivileged account cannot rename or replace it.
const DefaultDir = "/var/lib/crha-privileged"

// Verify checks dir and every parent up to / before the privileged mode uses the directory. The
// directory itself must be a real directory (not a symlink), owned by the current euid, and not
// writable by group or others. A parent may be owned by root or the current euid and must not be
// writable by group or others, unless it has the sticky bit: a sticky directory does not let one
// user rename another user's entries, which is why /tmp is acceptable.
func Verify(dir string) error {
	return verify(dir, os.Lstat, os.Geteuid())
}

// verify is Verify with the stat and euid dependencies injected, so tests can exercise ownership
// rules that a non-root test process cannot construct.
func verify(dir string, lstat func(string) (os.FileInfo, error), euid int) error {
	if dir == "" {
		return errors.New("privileged state directory is empty")
	}
	dir = filepath.Clean(dir)
	if !filepath.IsAbs(dir) {
		return reject(dir, dir, "is not an absolute path")
	}
	// In a user namespace the root of the filesystem appears owned by the unmapped host uid
	// (nobody) instead of 0. Treat the owner of / the same way as root: in a normal system that
	// is uid 0, and the check is about who may modify the components above the directory.
	rootUID := -1
	if fi, err := lstat(string(filepath.Separator)); err == nil {
		if st, ok := fi.Sys().(*syscall.Stat_t); ok {
			rootUID = int(st.Uid)
		}
	}
	fi, err := lstat(dir)
	if err != nil {
		return reject(dir, dir, "cannot be inspected: %v", err)
	}
	if err := check(dir, dir, fi, euid, rootUID, true); err != nil {
		return err
	}
	for parent := filepath.Dir(dir); ; parent = filepath.Dir(parent) {
		fi, err := lstat(parent)
		if err != nil {
			return reject(dir, parent, "cannot be inspected: %v", err)
		}
		if err := check(dir, parent, fi, euid, rootUID, false); err != nil {
			return err
		}
		if parent == string(filepath.Separator) {
			return nil
		}
	}
}

// check applies the owner and mode rules to one component of dir's path.
func check(dir, path string, fi os.FileInfo, euid, rootUID int, leaf bool) error {
	if fi.Mode()&os.ModeSymlink != 0 {
		return reject(dir, path, "is a symbolic link")
	}
	if !fi.IsDir() {
		return reject(dir, path, "is not a directory")
	}
	st, ok := fi.Sys().(*syscall.Stat_t)
	if !ok {
		return reject(dir, path, "has an unknown owner")
	}
	owner := int(st.Uid)
	if leaf {
		if owner != euid {
			return reject(dir, path, "is owned by uid %d, but the privileged mode runs as uid %d", owner, euid)
		}
	} else if owner != 0 && owner != rootUID && owner != euid {
		return reject(dir, path, "is owned by uid %d, not by root or the privileged mode's uid %d", owner, euid)
	}
	if fi.Mode().Perm()&0o022 != 0 {
		if !leaf && fi.Mode()&os.ModeSticky != 0 {
			return nil
		}
		return reject(dir, path, "is writable by group or others (mode %04o)", fi.Mode().Perm())
	}
	return nil
}

// reject builds the startup error. It names the configured directory and the offending path, and
// tells the operator where the directory must move.
func reject(dir, path, format string, args ...any) error {
	detail := fmt.Sprintf(format, args...)
	if path == "" || path == dir {
		return fmt.Errorf("privileged state directory %s %s; move state_dir to %s", dir, detail, DefaultDir)
	}
	return fmt.Errorf("privileged state directory %s: parent %s %s; move state_dir to %s", dir, path, detail, DefaultDir)
}
