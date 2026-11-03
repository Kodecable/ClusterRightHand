// Package authz implements the authorization decision of crha's privileged mode
// (doc/privilege.md#校验流程): method and target rendering, guard rules, SSHSIG and
// WebAuthn verification, and the pure decision function steps 2–8 of the verification
// flow. It performs no I/O and knows nothing about the socket, the crh-priv protocol or
// the used store; callers supply that state.
package authz

import (
	"errors"
	"fmt"
	"path/filepath"
	"strings"

	"github.com/Kodecable/ClusterRightHand/client/internal/protocol"
)

// Target renders a task spec as the (method, target) pair that authorization commands and
// guard rules match (doc/privilege.md#方法与目标).
//
// exec tasks render their argv with POSIX single quoting and one space between arguments;
// shell tasks render ["/bin/sh", "-c", script]. File tasks use their absolute path and
// map file.stat / file.list to file.read, file.edit to file.write.
func Target(spec *protocol.TaskSpec) (method, target string, err error) {
	if spec == nil {
		return "", "", errors.New("authz: nil task spec")
	}
	switch spec.Kind {
	case protocol.TaskSpecExec:
		if spec.Exec == nil {
			return "", "", errors.New("authz: exec task spec has no body")
		}
		var argv []string
		switch spec.Exec.Command.Kind {
		case protocol.CommandArgv:
			argv = spec.Exec.Command.Argv
			if len(argv) == 0 {
				return "", "", errors.New("authz: exec task spec has an empty argv")
			}
		case protocol.CommandShell:
			argv = []string{"/bin/sh", "-c", spec.Exec.Command.Shell}
		default:
			return "", "", fmt.Errorf("authz: unknown command kind %q", string(spec.Exec.Command.Kind))
		}
		quoted := make([]string, len(argv))
		for i, arg := range argv {
			quoted[i] = quoteArg(arg)
		}
		return string(protocol.MethodExec), strings.Join(quoted, " "), nil

	case protocol.TaskSpecFileRead:
		if spec.FileRead == nil {
			return "", "", errors.New("authz: file.read task spec has no body")
		}
		return string(protocol.MethodFileRead), spec.FileRead.Path, nil
	case protocol.TaskSpecFileStat:
		if spec.FileStat == nil {
			return "", "", errors.New("authz: file.stat task spec has no body")
		}
		return string(protocol.MethodFileRead), spec.FileStat.Path, nil
	case protocol.TaskSpecFileList:
		if spec.FileList == nil {
			return "", "", errors.New("authz: file.list task spec has no body")
		}
		return string(protocol.MethodFileRead), spec.FileList.Path, nil
	case protocol.TaskSpecFileWrite:
		if spec.FileWrite == nil {
			return "", "", errors.New("authz: file.write task spec has no body")
		}
		return string(protocol.MethodFileWrite), spec.FileWrite.Path, nil
	case protocol.TaskSpecFileEdit:
		if spec.FileEdit == nil {
			return "", "", errors.New("authz: file.edit task spec has no body")
		}
		return string(protocol.MethodFileWrite), spec.FileEdit.Path, nil
	default:
		return "", "", fmt.Errorf("authz: unknown task spec kind %q", string(spec.Kind))
	}
}

// quoteArg POSIX single-quotes one argv element. Characters in [A-Za-z0-9_@%+=:,./-] are
// safe unquoted; every other byte forces quoting, so non-ASCII and control characters are
// quoted too. The empty argument becomes ”.
func quoteArg(arg string) string {
	if arg == "" {
		return "''"
	}
	if isSafeArg(arg) {
		return arg
	}
	return "'" + strings.ReplaceAll(arg, "'", `'\''`) + "'"
}

func isSafeArg(arg string) bool {
	for i := 0; i < len(arg); i++ {
		c := arg[i]
		switch {
		case c >= 'a' && c <= 'z', c >= 'A' && c <= 'Z', c >= '0' && c <= '9':
		case strings.ContainsRune("_@%+=:,./-", rune(c)):
		default:
			return false
		}
	}
	return true
}

// CheckPath validates a privileged file path (doc/privilege.md#方法与目标): it must be
// absolute and already clean, so that no "." or ".." component and no repeated separator
// can hide the real target from path-based rules. Symlinks are rejected later, when the
// executor opens the path.
func CheckPath(path string) error {
	if path == "" {
		return errors.New("authz: path is empty")
	}
	if !filepath.IsAbs(path) {
		return fmt.Errorf("authz: path %q is not absolute", path)
	}
	if clean := filepath.Clean(path); clean != path {
		return fmt.Errorf("authz: path %q is not normalized (want %q)", path, clean)
	}
	return nil
}
