// Package execenv resolves the environment of the tasks a crha process runs: the account
// identity, PATH and the shells discovered from /etc/shells or PATH. crha no longer passes its own
// environment through, so this is resolved once when the process starts (`crha run`,
// `crha privileged run`, the native helper) and used for every task.
// See doc/execution-plane.md#exec-的执行环境.
package execenv

import (
	"errors"
	"fmt"
	"os"
	"os/user"
	"path/filepath"
	"strings"
)

// PrivilegedPath is the fixed PATH of privileged execution. It is not inherited from crha's
// environment, so a bare command name always resolves the same way and a task cannot point PATH at
// a binary of its own (doc/privilege.md "方法与目标").
const PrivilegedPath = "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"

// DefaultShellsFile lists the login shells of the node.
const DefaultShellsFile = "/etc/shells"

// Prefix marks crha's own task overrides. Variables with this prefix are never passed to a task.
const Prefix = "CRHA_TASK_"

// The override variables of the process's own environment. A non-empty value replaces the
// resolution below; CRHA_TASK_SHELL also selects the shell that runs `shell` commands.
const (
	EnvHome    = Prefix + "HOME"
	EnvUser    = Prefix + "USER"
	EnvLogname = Prefix + "LOGNAME"
	EnvShell   = Prefix + "SHELL"
)

// Locale is the value of LANG and LC_ALL that every task environment starts with.
const Locale = "C.UTF-8"

// IsOverride reports whether name is one of crha's own variables, which never reach a task.
func IsOverride(name string) bool {
	return strings.HasPrefix(name, Prefix)
}

// Environment is the task environment resolved when the crha process started. Bash is empty when the
// node has no bash; the other fields come from the account and PATH above.
type Environment struct {
	// Shell is the discovered sh: it is SHELL and runs `shell` commands. Authorization, rule
	// matching and display still render those as /bin/sh -c (doc/execution-plane.md#exec-的执行环境).
	Shell string
	// Bash is the discovered bash path, "" when the node has none.
	Bash string
	// Path is the PATH task commands resolve against: crha's own PATH, or PrivilegedPath when that
	// is empty and always in privileged mode.
	Path string
	// Home, User and Logname belong to the account tasks run as: the running user of the
	// non-privileged mode, root in the privileged mode and the native helper.
	Home    string
	User    string
	Logname string
}

// Options configure Resolve. The zero value resolves the environment of the running (non-privileged)
// process from the real system; every field is injectable for tests.
type Options struct {
	// Privileged selects the fixed PATH, the root identity and the fixed PATH for shell lookup.
	Privileged bool
	// Getenv reads the process environment; nil is os.Getenv.
	Getenv func(string) string
	// LookPath finds a shell not listed in ShellsFile; nil searches the resolved PATH (PrivilegedPath
	// in privileged mode), never the process PATH of a privileged process.
	LookPath func(string) (string, error)
	// ShellsFile is the list of login shells; "" is DefaultShellsFile.
	ShellsFile string
	// CurrentUser and LookupUser resolve the account; nil are user.Current and user.LookupId.
	CurrentUser func() (*user.User, error)
	LookupUser  func(string) (*user.User, error)
}

// Resolve builds the task environment, or fails when CRHA_TASK_SHELL is unusable or no sh can be
// found. Callers let the failure end the process: `crha run` and `crha privileged run` exit, and the
// native helper fails its handshake, which makes privileged tasks of that node fail with
// privileged_unsupported.
func Resolve(opts Options) (*Environment, error) {
	getenv := opts.Getenv
	if getenv == nil {
		getenv = os.Getenv
	}
	path := getenv("PATH")
	if opts.Privileged || path == "" {
		path = PrivilegedPath
	}
	lookPath := opts.LookPath
	if lookPath == nil {
		lookPath = func(name string) (string, error) { return LookPathIn(path, name) }
	}
	shellsFile := opts.ShellsFile
	if shellsFile == "" {
		shellsFile = DefaultShellsFile
	}

	sh := getenv(EnvShell)
	if sh != "" {
		// A bad override would only fail on the first `shell` task, or make facts report a shell
		// that cannot run; refuse to start instead (doc/execution-plane.md#exec-的执行环境).
		if err := checkShellOverride(sh); err != nil {
			return nil, fmt.Errorf("%s=%q: %w", EnvShell, sh, err)
		}
	}
	if sh == "" {
		sh = fromShellsFile(shellsFile, "sh")
	}
	if sh == "" {
		found, err := lookPath("sh")
		if err != nil {
			return nil, fmt.Errorf("no sh to run tasks: set %s, list an executable sh in %s, or add sh to PATH (%s)", EnvShell, shellsFile, path)
		}
		sh = found
	}
	// bash is optional: the agent uses facts.shells to decide whether it can suggest `bash -c`.
	bash := fromShellsFile(shellsFile, "bash")
	if bash == "" {
		if found, err := lookPath("bash"); err == nil {
			bash = found
		}
	}

	env := &Environment{Shell: sh, Bash: bash, Path: path}
	if opts.Privileged {
		// root has no fallback: a privileged process must know which account it runs tasks as.
		lookup := opts.LookupUser
		if lookup == nil {
			lookup = user.LookupId
		}
		root, err := lookup("0")
		if err != nil {
			return nil, fmt.Errorf("resolve the root account: %w", err)
		}
		env.Home, env.User, env.Logname = root.HomeDir, root.Username, root.Username
	} else {
		current := opts.CurrentUser
		if current == nil {
			current = user.Current
		}
		if u, err := current(); err == nil {
			env.Home, env.User, env.Logname = u.HomeDir, u.Username, u.Username
		} else {
			// os/user reads /etc/passwd only (crha is built with CGO_ENABLED=0), so an account from
			// LDAP or SSSD is not found; $HOME and $USER are the documented fallback.
			env.Home, env.User, env.Logname = getenv("HOME"), getenv("USER"), getenv("USER")
		}
	}
	if v := getenv(EnvHome); v != "" {
		env.Home = v
	}
	if v := getenv(EnvUser); v != "" {
		env.User = v
	}
	if v := getenv(EnvLogname); v != "" {
		env.Logname = v
	}
	return env, nil
}

// checkShellOverride rejects a CRHA_TASK_SHELL that cannot run `shell` commands: the override must
// be an absolute path to an existing executable regular file (doc/execution-plane.md).
func checkShellOverride(path string) error {
	if !filepath.IsAbs(path) {
		return errors.New("must be an absolute path")
	}
	fi, err := os.Stat(path)
	if err != nil {
		return fmt.Errorf("not usable: %w", err)
	}
	if !fi.Mode().IsRegular() {
		return errors.New("not a regular file")
	}
	if fi.Mode()&0o111 == 0 {
		return errors.New("not executable")
	}
	return nil
}

// LookPathIn resolves a bare command name against path, like exec.LookPath but with an explicit
// PATH: the privileged mode must not consult crha's own environment. Empty and relative PATH
// entries are skipped (an empty entry would mean the current directory), and the result is always
// an absolute path (doc/execution-plane.md#exec-的执行环境).
func LookPathIn(path, name string) (string, error) {
	if strings.ContainsRune(name, '/') {
		if !filepath.IsAbs(name) {
			return "", fmt.Errorf("executable %q is not an absolute path", name)
		}
		return name, nil
	}
	for _, dir := range filepath.SplitList(path) {
		if !filepath.IsAbs(dir) {
			continue
		}
		candidate := filepath.Join(dir, name)
		fi, err := os.Stat(candidate)
		if err != nil || !fi.Mode().IsRegular() || fi.Mode()&0o111 == 0 {
			continue
		}
		return candidate, nil
	}
	return "", fmt.Errorf("executable %q not found in PATH", name)
}

// fromShellsFile returns the first absolute path in file whose base name is name and that exists and
// is executable. Comments, blank lines, relative paths and non-executable entries are skipped; a
// missing or unreadable file has no shells.
func fromShellsFile(file, name string) string {
	data, err := os.ReadFile(file)
	if err != nil {
		return ""
	}
	for line := range strings.SplitSeq(string(data), "\n") {
		line = strings.TrimSpace(line)
		if line == "" || strings.HasPrefix(line, "#") || !filepath.IsAbs(line) {
			continue
		}
		if filepath.Base(line) != name {
			continue
		}
		fi, err := os.Stat(line)
		if err != nil || !fi.Mode().IsRegular() || fi.Mode()&0o111 == 0 {
			continue
		}
		return line
	}
	return ""
}
