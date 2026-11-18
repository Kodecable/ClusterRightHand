package setup

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"os/user"
	"path/filepath"
	"strconv"
)

// CommandResult is one external command's outcome; a non-zero exit is a result, not an error.
type CommandResult struct {
	Code   int
	Stdout string
	Stderr string
}

// Host is everything `crha enroll` touches outside the answers: the filesystem root (so tests can use
// a temporary prefix), the system commands, chown, uid lookup and the running binary. Production uses
// the real host; tests inject fakes and never change the machine.
type Host interface {
	// Root prefixes every host path: "" in production, a temporary directory in tests.
	Root() string
	IsRoot() bool
	Exec(ctx context.Context, name string, args ...string) (CommandResult, error)
	Chown(path, owner, group string) error
	UID(name string) (uint32, error)
	GID(name string) (uint32, error)
	// Executable is the absolute path of the running crha, for ExecStart.
	Executable() (string, error)
}

// ProductionHost returns the Host of the real machine.
func ProductionHost() Host { return productionHost{} }

type productionHost struct{}

func (productionHost) Root() string { return "" }

func (productionHost) IsRoot() bool { return os.Geteuid() == 0 }

func (productionHost) Exec(ctx context.Context, name string, args ...string) (CommandResult, error) {
	cmd := exec.CommandContext(ctx, name, args...)
	var stdout, stderr bytes.Buffer
	cmd.Stdout, cmd.Stderr = &stdout, &stderr
	err := cmd.Run()
	if err == nil {
		return CommandResult{Stdout: stdout.String(), Stderr: stderr.String()}, nil
	}
	var exit *exec.ExitError
	if errors.As(err, &exit) {
		return CommandResult{Code: exit.ExitCode(), Stdout: stdout.String(), Stderr: stderr.String()}, nil
	}
	return CommandResult{}, err
}

// Chown changes the owner of the directory entry itself: Lchown never follows a symlink at path.
// Not every path crha enroll changes is below a root-owned directory, so no-follow is the safe
// default for every caller.
func (productionHost) Chown(path, owner, group string) error {
	uid, err := productionHost{}.UID(owner)
	if err != nil {
		return err
	}
	gid, err := productionHost{}.GID(group)
	if err != nil {
		return err
	}
	if err := os.Lchown(path, int(uid), int(gid)); err != nil {
		return fmt.Errorf("chown %s:%s %s: %w", owner, group, path, err)
	}
	return nil
}

// UID resolves a user name to its uid.
func (productionHost) UID(name string) (uint32, error) {
	u, err := user.Lookup(name)
	if err != nil {
		return 0, err
	}
	uid, err := strconv.ParseUint(u.Uid, 10, 32)
	if err != nil {
		return 0, fmt.Errorf("user %s has an invalid uid %q", name, u.Uid)
	}
	return uint32(uid), nil
}

// GID resolves a group name to its gid.
func (productionHost) GID(name string) (uint32, error) {
	g, err := user.LookupGroup(name)
	if err != nil {
		return 0, err
	}
	gid, err := strconv.ParseUint(g.Gid, 10, 32)
	if err != nil {
		return 0, fmt.Errorf("group %s has an invalid gid %q", name, g.Gid)
	}
	return uint32(gid), nil
}

func (productionHost) Executable() (string, error) {
	path, err := os.Executable()
	if err != nil {
		return "", err
	}
	return filepath.EvalSymlinks(path)
}
