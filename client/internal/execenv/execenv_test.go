package execenv

import (
	"os"
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
	// (doc/execution-plane.md#exec-的执行环境).
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
