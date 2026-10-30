package executor

import (
	"context"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"

	"github.com/Kodecable/ClusterRightHand/client/internal/execenv"
	"github.com/Kodecable/ClusterRightHand/client/internal/protocol"
)

func testEnvironment() *execenv.Environment {
	return &execenv.Environment{
		Shell:   "/bin/sh",
		Bash:    "/bin/bash",
		Path:    "/usr/local/bin:/usr/bin:/bin",
		Home:    "/home/alice",
		User:    "alice",
		Logname: "alice",
	}
}

func envMap(t *testing.T, env []string) map[string]string {
	t.Helper()
	out := map[string]string{}
	for _, kv := range env {
		k, v, ok := strings.Cut(kv, "=")
		if !ok {
			t.Fatalf("entry %q has no =", kv)
		}
		out[k] = v
	}
	return out
}

func TestTaskEnvUnprivileged(t *testing.T) {
	env, err := taskEnv(testEnvironment(), map[string]string{
		"HOME":        "/task/home", // a task may override the identity
		"PATH":        "/task/bin",  // and PATH, in the non-privileged mode
		"CRHA_TASK_X": "leak",       // crha's own variables never reach a task
		"EXTRA":       "1",
		"LANG":        "de_DE.UTF-8", // and the locale
	}, false)
	if err != nil {
		t.Fatal(err)
	}
	got := envMap(t, env)
	want := map[string]string{
		"PATH":    "/task/bin",
		"HOME":    "/task/home",
		"USER":    "alice",
		"LOGNAME": "alice",
		"SHELL":   "/bin/sh",
		"LANG":    "de_DE.UTF-8",
		"LC_ALL":  "C.UTF-8",
		"EXTRA":   "1",
	}
	if len(got) != len(want) {
		t.Fatalf("environment has %d entries, want %d: %v", len(got), len(want), env)
	}
	for k, v := range want {
		if got[k] != v {
			t.Errorf("%s = %q, want %q", k, got[k], v)
		}
	}
	// Sorted, so the environment does not depend on map iteration order.
	if !slices.IsSorted(env) {
		t.Fatalf("environment is not sorted: %v", env)
	}
}

func TestTaskEnvPrivileged(t *testing.T) {
	env, err := taskEnv(testEnvironment(), map[string]string{
		"HOME":            "/root",  // allowed by the trust entry, an override of the base
		"PATH":            "/tmp/x", // never overridable
		"LC_ALL":          "POSIX",
		"CRHA_TASK_SHELL": "/tmp/evil",
	}, true)
	if err != nil {
		t.Fatal(err)
	}
	got := envMap(t, env)
	want := map[string]string{
		"PATH":    PrivilegedPath,
		"HOME":    "/root",
		"USER":    "alice",
		"LOGNAME": "alice",
		"SHELL":   "/bin/sh",
		"LANG":    "C.UTF-8",
		"LC_ALL":  "POSIX",
	}
	if len(got) != len(want) {
		t.Fatalf("environment has %d entries, want %d: %v", len(got), len(want), env)
	}
	for k, v := range want {
		if got[k] != v {
			t.Errorf("%s = %q, want %q", k, got[k], v)
		}
	}
	if !slices.IsSorted(env) {
		t.Fatalf("environment is not sorted: %v", env)
	}
}

func TestTaskEnvBaseIsMinimal(t *testing.T) {
	env, err := taskEnv(testEnvironment(), nil, false)
	if err != nil {
		t.Fatal(err)
	}
	got := envMap(t, env)
	if len(got) != 7 {
		t.Fatalf("base environment = %v, want exactly PATH, HOME, USER, LOGNAME, SHELL, LANG, LC_ALL", env)
	}
	for _, k := range []string{"PATH", "HOME", "USER", "LOGNAME", "SHELL", "LANG", "LC_ALL"} {
		if _, ok := got[k]; !ok {
			t.Errorf("base environment lacks %s: %v", k, env)
		}
	}
}

func TestTaskEnvValidation(t *testing.T) {
	for name, extra := range map[string]map[string]string{
		"empty name":   {"": "x"},
		"equals":       {"A=B": "x"},
		"NUL name":     {"A\x00B": "x"},
		"NUL value":    {"A": "x\x00y"},
		"path in name": {"A=B=C": "x"},
	} {
		if _, err := taskEnv(testEnvironment(), extra, false); err == nil || err.Code != "invalid_spec" {
			t.Errorf("%s: err = %+v, want invalid_spec", name, err)
		}
	}
}

// TestExecUsesConstructedEnvironment checks the child's whole environment: nothing of crha's own
// environment is passed through, the identity and locale come from the resolved environment.
func TestExecUsesConstructedEnvironment(t *testing.T) {
	t.Setenv("CRH_PARENT_ONLY", "leak")
	t.Setenv("CRHA_TASK_LEAK", "1")
	environment := testEnvironment()
	res, out, _ := runExec(t, context.Background(), &protocol.ExecSpec{
		Command: protocol.Command{Kind: protocol.CommandArgv, Argv: []string{"/usr/bin/env"}},
	}, "", ExecOptions{Env: environment})
	if code(res) != 0 {
		t.Fatalf("%+v", res)
	}
	got := map[string]string{}
	for _, line := range strings.Split(strings.TrimSuffix(out, "\n"), "\n") {
		k, v, _ := strings.Cut(line, "=")
		got[k] = v
	}
	for _, name := range []string{"CRH_PARENT_ONLY", "CRHA_TASK_LEAK"} {
		if _, ok := got[name]; ok {
			t.Fatalf("crha's own environment reached the task: %v", out)
		}
	}
	for k, v := range map[string]string{
		"HOME": "/home/alice", "USER": "alice", "LOGNAME": "alice",
		"SHELL": "/bin/sh", "LANG": "C.UTF-8", "LC_ALL": "C.UTF-8",
		"PATH": "/usr/local/bin:/usr/bin:/bin",
	} {
		if got[k] != v {
			t.Errorf("%s = %q, want %q (%v)", k, got[k], v, out)
		}
	}
}

// TestShellRunsOnDiscoveredShell checks that `shell` commands run on the discovered sh. The
// authorization target and the display keep rendering /bin/sh -c (see authz.Target).
func TestShellRunsOnDiscoveredShell(t *testing.T) {
	dir := t.TempDir()
	sh := filepath.Join(dir, "sh")
	script := "#!/bin/sh\nprintf 'ran-on:%s' \"$0\"\n"
	if err := os.WriteFile(sh, []byte(script), 0o755); err != nil {
		t.Fatal(err)
	}
	environment := testEnvironment()
	environment.Shell = sh
	res, out, errOut := runExec(t, context.Background(), &protocol.ExecSpec{
		Command: protocol.Command{Kind: protocol.CommandShell, Shell: "exit 0"},
	}, "", ExecOptions{Env: environment})
	if code(res) != 0 || errOut != "" {
		t.Fatalf("%+v stderr %q", res, errOut)
	}
	if out != "ran-on:"+sh {
		t.Fatalf("stdout = %q, want the discovered shell %q", out, sh)
	}
	// The task's SHELL is the same shell.
	res, out, _ = runExec(t, context.Background(), &protocol.ExecSpec{
		Command: protocol.Command{Kind: protocol.CommandArgv, Argv: []string{"/usr/bin/env"}},
	}, "", ExecOptions{Env: environment})
	if code(res) != 0 || !slices.Contains(strings.Split(out, "\n"), "SHELL="+sh) {
		t.Fatalf("SHELL missing from %q (%+v), want %q", out, res, sh)
	}
}

func TestExecPrivilegedEnv(t *testing.T) {
	// The privileged environment resolves the root account when no environment was passed; on any
	// normal Linux that works and the task sees root's identity and the fixed PATH.
	res, out, errOut := runExec(t, context.Background(), &protocol.ExecSpec{
		Command: protocol.Command{Kind: protocol.CommandArgv, Argv: []string{"/usr/bin/env"}},
		Env:     map[string]string{"PATH": "/tmp/x"},
	}, "", ExecOptions{Privileged: true})
	if code(res) != 0 {
		t.Fatalf("%+v stderr %q", res, errOut)
	}
	got := map[string]string{}
	for _, line := range strings.Split(strings.TrimSuffix(out, "\n"), "\n") {
		k, v, _ := strings.Cut(line, "=")
		got[k] = v
	}
	if got["PATH"] != PrivilegedPath {
		t.Fatalf("PATH = %q, want %q", got["PATH"], PrivilegedPath)
	}
	if got["USER"] == "" || got["HOME"] == "" || got["LOGNAME"] == "" {
		t.Fatalf("identity missing: %v", out)
	}
	if got["LANG"] != "C.UTF-8" || got["LC_ALL"] != "C.UTF-8" {
		t.Fatalf("locale = %q/%q", got["LANG"], got["LC_ALL"])
	}
}
