// Package execenv resolves the environment of the tasks and terminals a crha process runs: the
// account identity, PATH and the shells discovered from /etc/shells or PATH. crha no longer passes
// its own environment through, so this is resolved once when the process starts (`crha run`,
// `crha privileged run`, the native helper) and used for every task and terminal.
//
// For terminals it also resolves the identity's login shell and the system default locale, which
// exec tasks do not use (doc/design/pty.md "The terminal environment").
// See doc/design/execution.md "The exec environment".
package execenv

import (
	"errors"
	"fmt"
	"os"
	"os/user"
	"path/filepath"
	"slices"
	"strings"
)

// PrivilegedPath is the fixed PATH of privileged execution. It is not inherited from crha's
// environment, so a bare command name always resolves the same way and a task cannot point PATH at
// a binary of its own (doc/design/execution.md "The exec environment").
const PrivilegedPath = "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"

// DefaultShellsFile lists the login shells of the node.
const DefaultShellsFile = "/etc/shells"

// DefaultPasswdFile is the passwd database consulted for a terminal's login shell. os/user cannot
// provide the shell (the pure-Go implementation that a cgo-less crha uses reads passwd only for the
// other fields), so the file is parsed directly (doc/design/pty.md "The terminal environment").
const DefaultPasswdFile = "/etc/passwd"

// The system default locale files, in the order pam_env reads them. The first one that yields a
// LANG supplies a terminal's initial locale (doc/design/pty.md "The terminal environment").
const (
	DefaultLocaleConf = "/etc/locale.conf"
	DefaultLocaleFile = "/etc/default/locale"
)

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

// Locale is the value of LANG and LC_ALL that every task environment starts with, and the LANG
// fallback of a terminal whose system default locale files are missing or unusable.
const Locale = "C.UTF-8"

// IsOverride reports whether name is one of crha's own variables, which never reach a task.
func IsOverride(name string) bool {
	return strings.HasPrefix(name, Prefix)
}

// Environment is the task environment resolved when the crha process started. Bash is empty when the
// node has no bash; the other fields come from the account and PATH above.
type Environment struct {
	// Shell is the discovered sh: it is SHELL and runs `shell` commands. Authorization, rule
	// matching and display still render those as /bin/sh -c (doc/design/execution.md "The exec environment").
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
	// LoginShell is the shell a terminal of this identity runs when argv is empty, and the value
	// of SHELL in every terminal: the identity's login shell when it is a valid login shell,
	// otherwise Bash, otherwise Shell. Exec tasks keep using Shell
	// (doc/design/pty.md "The terminal environment").
	LoginShell string
	// TerminalLocale is the initial locale of a terminal: LANG and the LC_*/LANGUAGE lines of the
	// system default locale file, or LANG=C.UTF-8. It never contains LC_ALL, which would override
	// a locale the login shell's profile sets (doc/design/pty.md "The terminal environment").
	TerminalLocale []string
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
	// PasswdFile is the passwd database that supplies a terminal's login shell; "" is
	// DefaultPasswdFile.
	PasswdFile string
	// LocaleConf and LocaleFile are the system default locale files for terminals; "" are
	// DefaultLocaleConf and DefaultLocaleFile. They are injectable for tests.
	LocaleConf string
	LocaleFile string
	// CurrentUser and LookupUser resolve the account; nil are user.Current and user.LookupId.
	CurrentUser func() (*user.User, error)
	LookupUser  func(string) (*user.User, error)
}

// Resolve builds the task environment, or fails when CRHA_TASK_SHELL is unusable or no sh can be
// found. Callers let the failure end the process: `crha run` and `crha privileged run` exit, and the
// native helper fails its handshake, which makes privileged tasks of that node fail with
// privileged_unsupported.
//
// It also resolves the terminal-only defaults, LoginShell and TerminalLocale, so every terminal of
// the process gets the same login shell and initial locale (doc/design/pty.md "The terminal
// environment"). Exec tasks do not use them.
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
	passwdFile := opts.PasswdFile
	if passwdFile == "" {
		passwdFile = DefaultPasswdFile
	}

	shellOverride := getenv(EnvShell)
	if shellOverride != "" {
		// A bad override would only fail on the first `shell` task, or make facts report a shell
		// that cannot run; refuse to start instead (doc/design/execution.md "The exec environment").
		if err := checkShellOverride(shellOverride); err != nil {
			return nil, fmt.Errorf("%s=%q: %w", EnvShell, shellOverride, err)
		}
	}
	sh := shellOverride
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
	env.LoginShell = resolveLoginShell(shellsFile, passwdFile, env.User, bash, sh)
	env.TerminalLocale = ResolveLocale(LocaleOptions{LocaleConf: opts.LocaleConf, LocaleFile: opts.LocaleFile})
	return env, nil
}

// resolveLoginShell applies the terminal default-shell rule (doc/design/pty.md "The terminal
// environment"): the account's passwd shell when it is a valid login shell, then the discovered
// bash, then the shell exec tasks use. CRHA_TASK_SHELL is the exec tasks' sh and takes no part.
func resolveLoginShell(shellsFile, passwdFile, account, bash, sh string) string {
	if candidate := passwdShell(passwdFile, account); validLoginShell(shellsFile, candidate) {
		return candidate
	}
	if bash != "" {
		return bash
	}
	return sh
}

// passwdShell returns the login shell of user from a passwd file, or "" when the file is missing or
// has no entry for the account. The passwd entry is parsed directly because os/user's pure-Go
// implementation does not expose the shell (doc/design/pty.md "The terminal environment").
func passwdShell(file, account string) string {
	if file == "" || account == "" {
		return ""
	}
	data, err := os.ReadFile(file)
	if err != nil {
		return ""
	}
	for line := range strings.SplitSeq(string(data), "\n") {
		fields := strings.Split(line, ":")
		if len(fields) < 7 || fields[0] != account {
			continue
		}
		return strings.TrimSpace(fields[6])
	}
	return ""
}

// validLoginShell reports whether candidate is an executable regular file listed as a login shell in
// file. A symlink is followed, as the login programs do.
func validLoginShell(file, candidate string) bool {
	if candidate == "" || !filepath.IsAbs(candidate) {
		return false
	}
	fi, err := os.Stat(candidate)
	if err != nil || !fi.Mode().IsRegular() || fi.Mode()&0o111 == 0 {
		return false
	}
	return listedInShells(file, candidate)
}

// listedInShells reports whether shell is one of the absolute paths in file. Comments, blank lines,
// relative paths and other shells are skipped.
func listedInShells(file, shell string) bool {
	if file == "" || shell == "" {
		return false
	}
	data, err := os.ReadFile(file)
	if err != nil {
		return false
	}
	want := filepath.Clean(shell)
	for line := range strings.SplitSeq(string(data), "\n") {
		line = strings.TrimSpace(line)
		if line == "" || strings.HasPrefix(line, "#") || !filepath.IsAbs(line) {
			continue
		}
		if filepath.Clean(line) == want {
			return true
		}
	}
	return false
}

// LocaleOptions names the system default locale files consulted for a terminal's initial locale.
// Empty fields use DefaultLocaleConf and DefaultLocaleFile.
type LocaleOptions struct {
	LocaleConf string
	LocaleFile string
}

// ResolveLocale returns the initial locale of a terminal: LANG and the LANGUAGE/LC_* lines of the
// first system default locale file that yields a LANG, in the manner of pam_env and pam_systemd. A
// file without LANG is skipped; when neither file yields one the environment is LANG=C.UTF-8.
// LC_ALL is never returned, because a login shell's profile must be able to set the locale.
func ResolveLocale(opts LocaleOptions) []string {
	conf := opts.LocaleConf
	if conf == "" {
		conf = DefaultLocaleConf
	}
	file := opts.LocaleFile
	if file == "" {
		file = DefaultLocaleFile
	}
	for _, path := range []string{conf, file} {
		values := parseLocaleFile(path)
		if values["LANG"] == "" {
			continue
		}
		return localeLines(values)
	}
	return []string{"LANG=" + Locale}
}

// parseLocaleFile reads simple KEY=VALUE and KEY="VALUE" lines. Comments, blank lines, unknown keys,
// LC_ALL and empty values are ignored (doc/design/pty.md "The terminal environment").
func parseLocaleFile(path string) map[string]string {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil
	}
	values := map[string]string{}
	for line := range strings.SplitSeq(string(data), "\n") {
		line = strings.TrimSpace(line)
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		key, value, ok := strings.Cut(line, "=")
		if !ok {
			continue
		}
		key = strings.TrimSpace(key)
		if !isLocaleKey(key) {
			continue
		}
		value = strings.TrimSpace(value)
		if len(value) >= 2 {
			if quote := value[0]; (quote == '"' || quote == '\'') && value[len(value)-1] == quote {
				value = value[1 : len(value)-1]
			}
		}
		if value != "" {
			values[key] = value
		}
	}
	return values
}

// isLocaleKey reports whether key is part of a terminal's initial locale: LANG, LANGUAGE or an LC_*
// variable other than LC_ALL.
func isLocaleKey(key string) bool {
	return key == "LANG" || key == "LANGUAGE" || (strings.HasPrefix(key, "LC_") && key != "LC_ALL")
}

// localeLines renders a parsed locale with LANG first and the rest sorted, so the environment does
// not depend on the file's line order.
func localeLines(values map[string]string) []string {
	keys := make([]string, 0, len(values))
	for key := range values {
		if key != "LANG" {
			keys = append(keys, key)
		}
	}
	slices.Sort(keys)
	lines := make([]string, 0, len(values))
	if lang := values["LANG"]; lang != "" {
		lines = append(lines, "LANG="+lang)
	}
	for _, key := range keys {
		lines = append(lines, key+"="+values[key])
	}
	return lines
}

// checkShellOverride rejects a CRHA_TASK_SHELL that cannot run `shell` commands: the override must
// be an absolute path to an existing executable regular file (doc/design/execution.md).
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
// an absolute path (doc/design/execution.md "The exec environment").
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
