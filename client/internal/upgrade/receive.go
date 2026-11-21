package upgrade

import (
	"context"
	"crypto/sha256"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"syscall"

	"github.com/Kodecable/ClusterRightHand/client/internal/backup"
	"github.com/Kodecable/ClusterRightHand/client/internal/protocol"
	"github.com/Kodecable/ClusterRightHand/client/internal/version"
)

// versionPattern bounds the version a node.upgrade names: it becomes a directory name.
var versionPattern = regexp.MustCompile(`^[0-9][0-9A-Za-z.+-]{0,63}$`)

// unitPattern bounds a task id used in the transient unit's name.
var unitPattern = regexp.MustCompile(`^[0-9A-Za-z_-]{1,64}$`)

// Runner runs a program and returns its combined output; tests replace it.
type Runner func(ctx context.Context, name string, args ...string) ([]byte, error)

// ExecRunner runs programs directly, never through a shell.
func ExecRunner(ctx context.Context, name string, args ...string) ([]byte, error) {
	return exec.CommandContext(ctx, name, args...).CombinedOutput()
}

// ReceiveOptions are the parts of the node a receive touches.
type ReceiveOptions struct {
	// Dir replaces Dir (tests).
	Dir string
	// Run runs systemd-run; ExecRunner by default.
	Run Runner
	// SkipRootCheck lets tests run without root.
	SkipRootCheck bool
}

// Receive is the old binary's whole part of an upgrade (doc/design/distribution.md "On the node"): it
// writes the new binary to <Dir>/backups/task-<task id>/crha while hashing it, checks its size and SHA-256 against
// the authorized spec, and hands over to it in a transient unit outside crha's cgroups. Everything
// after this runs in the new binary, so the old file can be freed and new logic ships with the new
// version.
func Receive(ctx context.Context, taskID string, spec *protocol.NodeUpgradeSpec, in io.Reader, out io.Writer, opts ReceiveOptions) error {
	if spec == nil {
		return errors.New("node.upgrade task has no spec")
	}
	if !versionPattern.MatchString(spec.Version) {
		return fmt.Errorf("version %q is not a version", spec.Version)
	}
	if !unitPattern.MatchString(taskID) {
		return fmt.Errorf("task id %q cannot name a unit", taskID)
	}
	if !opts.SkipRootCheck && os.Geteuid() != 0 {
		return errors.New("an upgrade needs root: the privileged side does not run as root")
	}
	dir := opts.Dir
	if dir == "" {
		dir = Dir
	}
	run := opts.Run
	if run == nil {
		run = ExecRunner
	}
	if err := rootDir(dir, 0o755, opts.SkipRootCheck); err != nil {
		return err
	}
	// The binary goes into this upgrade's backup directory, which is pruned with it.
	backups := filepath.Join(dir, "backups")
	if err := rootDir(backups, 0o700, opts.SkipRootCheck); err != nil {
		return err
	}
	taskDir := backup.Path(backups, backup.UpgradeID(taskID))
	if err := rootDir(taskDir, 0o700, opts.SkipRootCheck); err != nil {
		return err
	}
	binary := filepath.Join(taskDir, "crha")
	if err := receiveFile(binary, spec, in); err != nil {
		return err
	}
	fmt.Fprintf(out, "received crha %s for %s (%d bytes, sha256 %x)\n", spec.Version, spec.Arch, spec.Size, spec.SHA256)

	// The installer stops and restarts crha's services; in a transient unit of its own it outlives them.
	unit := "crha-upgrade-" + taskID
	args := []string{
		"--unit", unit, "--collect", "--quiet",
		"--description", "ClusterRightHand crha upgrade to " + spec.Version,
		binary, InstallCommand, "--from", version.Version, "--to", spec.Version, "--task", taskID,
	}
	if output, err := run(ctx, "systemd-run", args...); err != nil {
		return fmt.Errorf("systemd-run: %w: %s", err, bytesTrim(output))
	}
	fmt.Fprintf(out, "handed over to %s.service; it waits for crhs to confirm this result, then stops and upgrades crha\n", unit)
	return nil
}

// InstallCommand is the hidden subcommand the new binary runs the install with.
const InstallCommand = "__upgrade-install"

// rootDir makes sure path is a real directory with mode, owned by root unless tests skip the check.
// It never follows a symbolic link: only root can write these directories, and a link would let
// whoever planted it choose where the binary goes.
func rootDir(path string, mode os.FileMode, skipOwner bool) error {
	info, err := os.Lstat(path)
	if errors.Is(err, os.ErrNotExist) {
		if err := os.Mkdir(path, mode); err != nil {
			return fmt.Errorf("create %s: %w", path, err)
		}
		info, err = os.Lstat(path)
	}
	if err != nil {
		return fmt.Errorf("check %s: %w", path, err)
	}
	if !info.IsDir() {
		return fmt.Errorf("%s is not a directory", path)
	}
	if !skipOwner {
		if st, ok := info.Sys().(*syscall.Stat_t); !ok || st.Uid != 0 {
			return fmt.Errorf("%s is not owned by root", path)
		}
	}
	if info.Mode().Perm() != mode {
		if err := os.Chmod(path, mode); err != nil {
			return fmt.Errorf("chmod %s: %w", path, err)
		}
	}
	return nil
}

// receiveFile streams the binary into place, checking its size and hash before the rename.
func receiveFile(target string, spec *protocol.NodeUpgradeSpec, in io.Reader) error {
	part := target + ".part"
	_ = os.Remove(part)
	f, err := os.OpenFile(part, os.O_WRONLY|os.O_CREATE|os.O_EXCL|syscall.O_NOFOLLOW, 0o700)
	if err != nil {
		return fmt.Errorf("create %s: %w", part, err)
	}
	defer func() { _ = os.Remove(part) }()
	hash := sha256.New()
	limit := int64(spec.Size)
	n, err := io.Copy(io.MultiWriter(f, hash), io.LimitReader(in, limit+1))
	if err == nil {
		err = f.Sync()
	}
	if cerr := f.Close(); err == nil {
		err = cerr
	}
	if err != nil {
		return fmt.Errorf("write %s: %w", part, err)
	}
	if n != limit {
		return fmt.Errorf("received %d bytes, the authorized binary has %d", n, limit)
	}
	var sum protocol.Hash
	copy(sum[:], hash.Sum(nil))
	if sum != spec.SHA256 {
		return fmt.Errorf("received sha256 %x, the authorized binary has %x", sum, spec.SHA256)
	}
	if err := os.Rename(part, target); err != nil {
		return fmt.Errorf("rename %s: %w", part, err)
	}
	return nil
}

func bytesTrim(b []byte) string {
	const max = 512
	if len(b) > max {
		b = b[:max]
	}
	return string(b)
}
