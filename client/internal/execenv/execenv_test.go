package execenv

import (
	"os"
	"os/exec"
	"os/user"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
)

// fakeShell writes an executable script and returns its path.
func fakeShell(t *testing.T, dir, name, body string) string {
	t.Helper()
	p := filepath.Join(dir, name)
	if err := os.WriteFile(p, []byte("#!/bin/sh\n"+body+"\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	return p
}

func shellsFile(t *testing.T, lines ...string) string {
	t.Helper()
	p := filepath.Join(t.TempDir(), "shells")
	if err := os.WriteFile(p, []byte(strings.Join(lines, "\n")+"\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	return p
}

func getenvOf(values map[string]string) func(string) string {
	return func(name string) string { return values[name] }
}

func failingLookPath(string) (string, error) { return "", os.ErrNotExist }

// resolved returns the sh and bash of a successful Resolve.
func resolved(t *testing.T, opts Options) *Environment {
	t.Helper()
	env, err := Resolve(opts)
	if err != nil {
		t.Fatal(err)
	}
	return env
}

func TestShellsFileOrderAndMatching(t *testing.T) {
	dir := t.TempDir()
	dash := fakeShell(t, dir, "dash", "exit 0")
	sh := fakeShell(t, dir, "sh", "exit 0")
	bash := fakeShell(t, dir, "bash", "exit 0")
	inexecutable := filepath.Join(dir, "sh-not-executable")
	if err := os.WriteFile(inexecutable, []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}
	file := shellsFile(t,
		"# /etc/shells: valid login shells",
		"",
		dash,                      // another shell, skipped
		"bin/sh",                  // relative paths are not used
		"/nonexistent/bin/sh",     // does not exist
		inexecutable,              // exists but is not executable
		"  "+sh+"  ",              // surrounding whitespace is ignored
		filepath.Join(dir, "xsh"), // base name is not sh
		bash,
	)
	env := resolved(t, Options{ShellsFile: file, LookPath: failingLookPath, CurrentUser: func() (*user.User, error) {
		return &user.User{Username: "alice", HomeDir: "/home/alice"}, nil
	}})
	if env.Shell != sh {
		t.Fatalf("sh = %q, want %q", env.Shell, sh)
	}
	if env.Bash != bash {
		t.Fatalf("bash = %q, want %q", env.Bash, bash)
	}
}

func TestShellsFileWithoutBash(t *testing.T) {
	dir := t.TempDir()
	sh := fakeShell(t, dir, "sh", "exit 0")
	env := resolved(t, Options{ShellsFile: shellsFile(t, sh), LookPath: failingLookPath, CurrentUser: func() (*user.User, error) {
		return &user.User{Username: "alice", HomeDir: "/home/alice"}, nil
	}})
	if env.Shell != sh || env.Bash != "" {
		t.Fatalf("shells = %q/%q, want %q/empty", env.Shell, env.Bash, sh)
	}
}

func TestShellLookPathFallback(t *testing.T) {
	dir := t.TempDir()
	sh := fakeShell(t, dir, "sh", "exit 0")
	bash := fakeShell(t, dir, "bash", "exit 0")
	look := func(name string) (string, error) {
		switch name {
		case "sh":
			return sh, nil
		case "bash":
			return bash, nil
		}
		return "", os.ErrNotExist
	}
	// A missing shells file falls through to the lookup.
	env := resolved(t, Options{ShellsFile: filepath.Join(dir, "missing"), LookPath: look, CurrentUser: func() (*user.User, error) {
		return &user.User{Username: "alice", HomeDir: "/home/alice"}, nil
	}})
	if env.Shell != sh || env.Bash != bash {
		t.Fatalf("shells = %q/%q, want %q/%q", env.Shell, env.Bash, sh, bash)
	}
}

func TestShellLookPathIgnoresNonExecutable(t *testing.T) {
	dir := t.TempDir()
	// LookPathIn rejects a non-executable candidate; the package's own default lookup is exercised
	// here with an explicit PATH.
	bin := filepath.Join(dir, "bin")
	if err := os.Mkdir(bin, 0o755); err != nil {
		t.Fatal(err)
	}
	nonExec := filepath.Join(bin, "sh")
	if err := os.WriteFile(nonExec, []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}
	if _, err := Resolve(Options{
		ShellsFile:  filepath.Join(dir, "missing"),
		Getenv:      getenvOf(map[string]string{"PATH": bin}),
		CurrentUser: currentUserStub,
	}); err == nil {
		t.Fatal("resolved a non-executable sh")
	}
}

func TestShellOverride(t *testing.T) {
	dir := t.TempDir()
	sh := fakeShell(t, dir, "sh", "exit 0")
	override := fakeShell(t, dir, "my-sh", "exit 0")
	env := resolved(t, Options{
		ShellsFile:  shellsFile(t, sh),
		Getenv:      getenvOf(map[string]string{EnvShell: override}),
		LookPath:    failingLookPath,
		CurrentUser: currentUserStub,
	})
	if env.Shell != override {
		t.Fatalf("sh = %q, want the override %q", env.Shell, override)
	}
}

func TestShellResolutionFailure(t *testing.T) {
	env, err := Resolve(Options{
		ShellsFile:  shellsFile(t, "# no shells here"),
		LookPath:    failingLookPath,
		CurrentUser: currentUserStub,
	})
	if err == nil || env != nil {
		t.Fatalf("Resolve = %+v, %v; want a failure", env, err)
	}
	if !strings.Contains(err.Error(), EnvShell) || !strings.Contains(err.Error(), "no sh") {
		t.Fatalf("error %q does not describe the missing sh", err)
	}
}

func currentUserStub() (*user.User, error) {
	return &user.User{Username: "alice", HomeDir: "/home/alice", Uid: "1000", Gid: "1000"}, nil
}

func TestUnprivilegedPath(t *testing.T) {
	dir := t.TempDir()
	sh := fakeShell(t, dir, "sh", "exit 0")
	opts := Options{
		ShellsFile:  shellsFile(t, sh),
		LookPath:    failingLookPath,
		CurrentUser: currentUserStub,
	}
	opts.Getenv = getenvOf(map[string]string{"PATH": "/opt/bin:/bin"})
	if env := resolved(t, opts); env.Path != "/opt/bin:/bin" {
		t.Fatalf("PATH = %q", env.Path)
	}
	// An empty PATH falls back to the fixed PATH.
	opts.Getenv = getenvOf(map[string]string{"PATH": ""})
	if env := resolved(t, opts); env.Path != PrivilegedPath {
		t.Fatalf("empty PATH = %q, want the fixed PATH", env.Path)
	}
}

func TestUnprivilegedIdentity(t *testing.T) {
	dir := t.TempDir()
	sh := fakeShell(t, dir, "sh", "exit 0")
	env := resolved(t, Options{
		ShellsFile:  shellsFile(t, sh),
		LookPath:    failingLookPath,
		CurrentUser: currentUserStub,
		Getenv:      getenvOf(map[string]string{"CRHA_TASK_IGNORED": "x"}),
	})
	if env.Home != "/home/alice" || env.User != "alice" || env.Logname != "alice" {
		t.Fatalf("identity = %q/%q/%q", env.Home, env.User, env.Logname)
	}
}

func TestUnprivilegedIdentityFallback(t *testing.T) {
	dir := t.TempDir()
	sh := fakeShell(t, dir, "sh", "exit 0")
	env := resolved(t, Options{
		ShellsFile: shellsFile(t, sh),
		LookPath:   failingLookPath,
		CurrentUser: func() (*user.User, error) {
			return nil, user.UnknownUserError("alice")
		},
		Getenv: getenvOf(map[string]string{"HOME": "/srv/alice", "USER": "alice"}),
	})
	if env.Home != "/srv/alice" || env.User != "alice" || env.Logname != "alice" {
		t.Fatalf("fallback identity = %q/%q/%q", env.Home, env.User, env.Logname)
	}
}

func TestOverrides(t *testing.T) {
	dir := t.TempDir()
	sh := fakeShell(t, dir, "sh", "exit 0")
	env := resolved(t, Options{
		ShellsFile:  shellsFile(t, sh),
		LookPath:    failingLookPath,
		CurrentUser: currentUserStub,
		Getenv: getenvOf(map[string]string{
			EnvHome:    "/task/home",
			EnvUser:    "someone",
			EnvLogname: "someone-else",
		}),
	})
	if env.Home != "/task/home" || env.User != "someone" || env.Logname != "someone-else" {
		t.Fatalf("overridden identity = %q/%q/%q", env.Home, env.User, env.Logname)
	}
	// An empty override does not win.
	env = resolved(t, Options{
		ShellsFile:  shellsFile(t, sh),
		LookPath:    failingLookPath,
		CurrentUser: currentUserStub,
		Getenv:      getenvOf(map[string]string{EnvHome: "", EnvUser: ""}),
	})
	if env.Home != "/home/alice" || env.User != "alice" {
		t.Fatalf("empty override changed the identity: %q/%q", env.Home, env.User)
	}
}

func TestPrivilegedIdentityAndPath(t *testing.T) {
	dir := t.TempDir()
	fakePathSh := fakeShell(t, dir, "sh", "exit 0")
	env := resolved(t, Options{
		Privileged: true,
		// The privileged mode never consults this PATH for lookup, only as a decoy.
		Getenv:     getenvOf(map[string]string{"PATH": dir}),
		ShellsFile: filepath.Join(dir, "missing"),
		LookupUser: func(uid string) (*user.User, error) {
			if uid != "0" {
				t.Fatalf("LookupUser(%q)", uid)
			}
			return &user.User{Username: "root", HomeDir: "/root", Uid: "0", Gid: "0"}, nil
		},
		CurrentUser: func() (*user.User, error) {
			t.Fatal("the privileged mode must not use user.Current")
			return nil, nil
		},
	})
	if env.Path != PrivilegedPath {
		t.Fatalf("PATH = %q, want the fixed PATH", env.Path)
	}
	if env.Home != "/root" || env.User != "root" || env.Logname != "root" {
		t.Fatalf("identity = %q/%q/%q", env.Home, env.User, env.Logname)
	}
	if env.Shell == fakePathSh {
		t.Fatalf("privileged lookup used the process PATH: %q", env.Shell)
	}
}

func TestPrivilegedLookupFailure(t *testing.T) {
	dir := t.TempDir()
	sh := fakeShell(t, dir, "sh", "exit 0")
	_, err := Resolve(Options{
		Privileged: true,
		ShellsFile: shellsFile(t, sh),
		LookupUser: func(string) (*user.User, error) {
			return nil, user.UnknownUserError("0")
		},
	})
	if err == nil || !strings.Contains(err.Error(), "root account") {
		t.Fatalf("Resolve error = %v, want a root account failure", err)
	}
}

func TestLookPathIn(t *testing.T) {
	dir := t.TempDir()
	bin := filepath.Join(dir, "bin")
	if err := os.MkdirAll(bin, 0o755); err != nil {
		t.Fatal(err)
	}
	tool := filepath.Join(bin, "tool")
	if err := os.WriteFile(tool, []byte("x"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.Mkdir(filepath.Join(bin, "dir"), 0o755); err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{"tool", "dir"} {
		got, err := LookPathIn(bin, name)
		if name == "tool" && (err != nil || got != tool) {
			t.Fatalf("LookPathIn(tool) = %q, %v", got, err)
		}
		if name == "dir" && err == nil {
			t.Fatalf("LookPathIn(dir) = %q, want a failure", got)
		}
	}
	if got, err := LookPathIn("/nonexistent", "/bin/sh"); err != nil || got != "/bin/sh" {
		t.Fatalf("absolute path = %q, %v", got, err)
	}
	if _, err := LookPathIn(bin, "missing"); err == nil {
		t.Fatal("LookPathIn(missing) succeeded")
	}
}

func TestLookPathInSkipsEmptyAndRelativeEntries(t *testing.T) {
	dir := t.TempDir()
	// The process runs in dir, which itself holds an executable sh; the empty PATH entry (the
	// current directory) and the relative entry "bin" must not find either one
	// (doc/design/execution.md "The exec environment").
	sh := fakeShell(t, dir, "sh", "exit 0")
	bin := filepath.Join(dir, "bin")
	if err := os.Mkdir(bin, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(bin, "sh"), []byte("#!/bin/sh\nexit 0\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	t.Chdir(dir)
	for _, path := range []string{"", ":", "bin", ".:bin", "bin:/nonexistent"} {
		if got, err := LookPathIn(path, "sh"); err == nil {
			t.Fatalf("LookPathIn(%q) found %q", path, got)
		}
	}
	// An absolute entry still works, and the result is absolute.
	if got, err := LookPathIn(dir, "sh"); err != nil || got != sh {
		t.Fatalf("LookPathIn(%q) = %q, %v", dir, got, err)
	}
	// A relative name with a slash can only produce a relative result, so it is refused too.
	if got, err := LookPathIn(dir, "./sh"); err == nil {
		t.Fatalf("LookPathIn(%q, ./sh) = %q", dir, got)
	}
}

func TestShellOverrideMustBeExecutableAbsolutePath(t *testing.T) {
	dir := t.TempDir()
	sh := fakeShell(t, dir, "sh", "exit 0")
	notExecutable := filepath.Join(dir, "not-executable")
	if err := os.WriteFile(notExecutable, []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}
	notRegular := filepath.Join(dir, "a-directory")
	if err := os.Mkdir(notRegular, 0o755); err != nil {
		t.Fatal(err)
	}
	options := func(override string) Options {
		return Options{
			ShellsFile:  shellsFile(t, sh),
			LookPath:    failingLookPath,
			CurrentUser: currentUserStub,
			Getenv:      getenvOf(map[string]string{EnvShell: override}),
		}
	}
	for name, override := range map[string]string{
		"bare name":          "sh",
		"relative path":      "bin/sh",
		"missing":            filepath.Join(dir, "missing"),
		"not executable":     notExecutable,
		"not a regular file": notRegular,
	} {
		t.Run(name, func(t *testing.T) {
			env, err := Resolve(options(override))
			if err == nil || env != nil {
				t.Fatalf("Resolve accepted %s: %+v, %v", name, env, err)
			}
			if !strings.Contains(err.Error(), EnvShell) {
				t.Fatalf("error %q does not name %s", err, EnvShell)
			}
		})
	}
	// The privileged mode validates the override the same way, whatever the identity.
	_, err := Resolve(Options{
		Privileged:  true,
		ShellsFile:  shellsFile(t, sh),
		LookupUser:  func(string) (*user.User, error) { return &user.User{Username: "root", HomeDir: "/root"}, nil },
		CurrentUser: currentUserStub,
		Getenv:      getenvOf(map[string]string{EnvShell: "sh"}),
	})
	if err == nil || !strings.Contains(err.Error(), EnvShell) {
		t.Fatalf("privileged Resolve error = %v, want a %s failure", err, EnvShell)
	}
	if env := resolved(t, options(sh)); env.Shell != sh {
		t.Fatalf("sh = %q, want the override %q", env.Shell, sh)
	}
	if env := resolved(t, options("")); env.Shell != sh {
		t.Fatalf("empty override: sh = %q, want the discovered %q", env.Shell, sh)
	}
}

func TestIsOverride(t *testing.T) {
	for name, want := range map[string]bool{
		EnvHome: true, EnvUser: true, EnvLogname: true, EnvShell: true,
		"CRHA_TASK_SECRET": true, "CRHA_TASKS": false, "PATH": false, "HOME": false,
	} {
		if got := IsOverride(name); got != want {
			t.Errorf("IsOverride(%q) = %v, want %v", name, got, want)
		}
	}
}

func TestResolvedEnvironmentIsComplete(t *testing.T) {
	env := resolved(t, Options{Privileged: false})
	if env.Shell == "" || env.Path == "" || env.Home == "" || env.User == "" || env.Logname == "" {
		t.Fatalf("incomplete environment: %+v", env)
	}
	if !reflect.DeepEqual([]string{env.User}, []string{env.Logname}) {
		t.Fatalf("user/logname disagree: %q/%q", env.User, env.Logname)
	}
}

// passwdFile writes a passwd database with lines, or an empty one when there are none.
func passwdFile(t *testing.T, lines ...string) string {
	t.Helper()
	p := filepath.Join(t.TempDir(), "passwd")
	content := strings.Join(lines, "\n")
	if content != "" {
		content += "\n"
	}
	if err := os.WriteFile(p, []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
	return p
}

// passwdLine is one passwd entry for alice with home and shell.
func passwdLine(home, shell string) string {
	return "alice:x:1000:1000::" + home + ":" + shell
}

// TestLoginShellSelection is the default shell rule of a terminal: the passwd shell when it is a
// valid login shell, otherwise bash, otherwise the discovered sh (doc/design/pty.md "The terminal
// environment").
func TestLoginShellSelection(t *testing.T) {
	dir := t.TempDir()
	zsh := fakeShell(t, dir, "zsh", "exit 0")
	bash := fakeShell(t, dir, "bash", "exit 0")
	sh := fakeShell(t, dir, "sh", "exit 0")
	notExecutable := filepath.Join(dir, "zsh-not-executable")
	if err := os.WriteFile(notExecutable, []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}

	tests := []struct {
		name        string
		passwdShell string
		shells      []string
		override    string
		want        string
	}{
		{"passwd shell chosen", zsh, []string{zsh, bash, sh}, "", zsh},
		{"passwd shell not in shells file", zsh, []string{bash, sh}, "", bash},
		{"passwd shell not executable", notExecutable, []string{notExecutable, bash, sh}, "", bash},
		{"passwd shell path missing", filepath.Join(dir, "missing-shell"), []string{bash, sh}, "", bash},
		{"account not in passwd", "", []string{bash, sh}, "", bash},
		{"no bash falls back to sh", "", []string{sh}, "", sh},
		// CRHA_TASK_SHELL is the exec tasks' sh, not a login shell: it never replaces bash here.
		{"task shell override is not a login shell", "", []string{zsh, bash, sh}, zsh, bash},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			var passwd string
			if tc.passwdShell != "" {
				passwd = passwdFile(t, passwdLine("/home/alice", tc.passwdShell))
			} else {
				passwd = passwdFile(t, "bob:x:1001:1001::/home/bob:"+sh)
			}
			values := map[string]string{}
			if tc.override != "" {
				values[EnvShell] = tc.override
			}
			env := resolved(t, Options{
				ShellsFile:  shellsFile(t, tc.shells...),
				PasswdFile:  passwd,
				LookPath:    failingLookPath,
				CurrentUser: currentUserStub,
				Getenv:      getenvOf(values),
			})
			if env.LoginShell != tc.want {
				t.Fatalf("login shell = %q, want %q (exec shell %q, bash %q)", env.LoginShell, tc.want, env.Shell, env.Bash)
			}
		})
	}
}

// TestLoginShellPrivilegedRootWithBash covers the privileged identity: root's passwd shell is bash,
// so a privileged terminal's default shell and SHELL are bash, not the shell exec tasks use.
func TestLoginShellPrivilegedRootWithBash(t *testing.T) {
	bash, err := exec.LookPath("bash")
	if err != nil || !filepath.IsAbs(bash) {
		t.Skip("the host has no absolute bash")
	}
	sh, err := exec.LookPath("sh")
	if err != nil || !filepath.IsAbs(sh) {
		t.Skip("the host has no absolute sh")
	}
	env := resolved(t, Options{
		Privileged: true,
		ShellsFile: shellsFile(t, bash, sh),
		PasswdFile: passwdFile(t, "root:x:0:0:root:/root:"+bash),
		LookupUser: func(uid string) (*user.User, error) {
			if uid != "0" {
				t.Fatalf("LookupUser(%q), want uid 0", uid)
			}
			return &user.User{Username: "root", HomeDir: "/root", Uid: "0", Gid: "0"}, nil
		},
		CurrentUser: func() (*user.User, error) {
			t.Fatal("the privileged mode must not use user.Current")
			return nil, nil
		},
		Getenv: getenvOf(map[string]string{}),
	})
	if env.LoginShell != bash {
		t.Fatalf("login shell = %q, want root's passwd shell %q", env.LoginShell, bash)
	}
}

// localeInput is one of the two system default locale files in a test.
type localeInput struct {
	content string
	exists  bool
}

// at writes the file into a fresh temporary directory and returns its path; a file that does not
// exist is a path in that directory that was never created.
func (in localeInput) at(t *testing.T) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), "locale")
	if !in.exists {
		return path
	}
	if err := os.WriteFile(path, []byte(in.content), 0o644); err != nil {
		t.Fatal(err)
	}
	return path
}

// TestResolveLocale covers the locale a terminal starts with, in pam_env's order: LANG and the
// LC_*/LANGUAGE lines of the first file that yields LANG, never LC_ALL.
func TestResolveLocale(t *testing.T) {
	tests := []struct {
		name string
		conf localeInput
		file localeInput
		want []string
	}{
		{
			"locale.conf supplies LANG",
			localeInput{content: "LANG=en_US.UTF-8\nLC_TIME=de_DE.UTF-8\nLC_ALL=POSIX\nXKBLAYOUT=us\n# comment\n\n", exists: true},
			localeInput{content: "LANG=fr_FR.UTF-8\n", exists: true},
			[]string{"LANG=en_US.UTF-8", "LC_TIME=de_DE.UTF-8"},
		},
		{
			"quotes, comments and unknown keys",
			localeInput{content: "# a comment\nLANG=\"en_GB.UTF-8\"\nLANGUAGE=\"en_GB:en\"\nLC_CTYPE='C.UTF-8'\nNOT_A_LOCALE=x\n", exists: true},
			localeInput{},
			[]string{"LANG=en_GB.UTF-8", "LANGUAGE=en_GB:en", "LC_CTYPE=C.UTF-8"},
		},
		{
			"default/locale when locale.conf is missing",
			localeInput{},
			localeInput{content: "LANG=fr_FR.UTF-8\nLC_ALL=POSIX\n", exists: true},
			[]string{"LANG=fr_FR.UTF-8"},
		},
		{
			"locale.conf without LANG falls through to default/locale",
			localeInput{content: "LC_TIME=de_DE.UTF-8\n", exists: true},
			localeInput{content: "LANG=fr_FR.UTF-8\n", exists: true},
			[]string{"LANG=fr_FR.UTF-8"},
		},
		{
			"empty LANG falls through",
			localeInput{content: "LANG=\n", exists: true},
			localeInput{content: "LANG=C\n", exists: true},
			[]string{"LANG=C"},
		},
		{
			"neither file supplies LANG",
			localeInput{},
			localeInput{},
			[]string{"LANG=C.UTF-8"},
		},
		{
			"LC_ALL is ignored",
			localeInput{content: "LANG=C.UTF-8\nLC_ALL=POSIX\n", exists: true},
			localeInput{},
			[]string{"LANG=C.UTF-8"},
		},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			got := ResolveLocale(LocaleOptions{LocaleConf: tc.conf.at(t), LocaleFile: tc.file.at(t)})
			if !reflect.DeepEqual(got, tc.want) {
				t.Fatalf("locale = %q, want %q", got, tc.want)
			}
		})
	}
}

// TestResolveTerminalDefaultsFromOptions checks that Resolve wires the injected locale and passwd
// files into the terminal-only fields.
func TestResolveTerminalDefaultsFromOptions(t *testing.T) {
	dir := t.TempDir()
	sh := fakeShell(t, dir, "sh", "exit 0")
	conf := filepath.Join(dir, "locale.conf")
	if err := os.WriteFile(conf, []byte("LANG=de_DE.UTF-8\nLC_TIME=fr_FR.UTF-8\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	env := resolved(t, Options{
		ShellsFile:  shellsFile(t, sh),
		PasswdFile:  filepath.Join(dir, "missing-passwd"),
		LocaleConf:  conf,
		LocaleFile:  filepath.Join(dir, "missing-locale"),
		LookPath:    failingLookPath,
		CurrentUser: currentUserStub,
		Getenv:      getenvOf(map[string]string{}),
	})
	if !reflect.DeepEqual(env.TerminalLocale, []string{"LANG=de_DE.UTF-8", "LC_TIME=fr_FR.UTF-8"}) {
		t.Fatalf("terminal locale = %q", env.TerminalLocale)
	}
	if env.LoginShell != sh {
		t.Fatalf("login shell = %q, want the discovered sh %q", env.LoginShell, sh)
	}
}
