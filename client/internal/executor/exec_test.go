package executor

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"

	"golang.org/x/sys/unix"

	"github.com/Kodecable/ClusterRightHand/client/internal/protocol"
)

func runExec(t *testing.T, ctx context.Context, spec *protocol.ExecSpec, stdin string, opts ExecOptions) (Result, string) {
	t.Helper()
	o := NewOutput("x", "", OutputOptions{})
	var in *strings.Reader
	if stdin != "" {
		in = strings.NewReader(stdin)
	}
	var res Result
	if in != nil {
		res = RunExec(ctx, spec, in, o, opts)
	} else {
		res = RunExec(ctx, spec, nil, o, opts)
	}
	o.Close()
	return res, readAll(t, o, 0)
}

func code(r Result) int32 {
	if r.ExitCode == nil {
		return -1
	}
	return *r.ExitCode
}

func TestExecBasics(t *testing.T) {
	ctx := context.Background()
	res, out := runExec(t, ctx, &protocol.ExecSpec{Command: protocol.Command{Kind: protocol.CommandShell, Shell: "echo out; echo err >&2; exit 3"}}, "", ExecOptions{})
	if code(res) != 3 || out != "out\nerr\n" || res.Err != nil {
		t.Fatalf("res %+v out %q", res, out)
	}
	res, out = runExec(t, ctx, &protocol.ExecSpec{Command: protocol.Command{Kind: protocol.CommandArgv, Argv: []string{"cat"}}}, "piped", ExecOptions{})
	if code(res) != 0 || out != "piped" {
		t.Fatalf("stdin: %+v %q", res, out)
	}
	res, out = runExec(t, ctx, &protocol.ExecSpec{Command: protocol.Command{Kind: protocol.CommandShell, Shell: "echo $CRH_X; pwd"}, Env: map[string]string{"CRH_X": "y"}, Cwd: "/tmp"}, "", ExecOptions{})
	if out != "y\n/tmp\n" {
		t.Fatalf("env/cwd: %+v %q", res, out)
	}
	res, out = runExec(t, ctx, &protocol.ExecSpec{Command: protocol.Command{Kind: protocol.CommandArgv, Argv: []string{"pwd"}}}, "", ExecOptions{})
	if out != "/\n" {
		t.Fatalf("default cwd: %q", out)
	}
}

func TestExecErrors(t *testing.T) {
	ctx := context.Background()
	for name, spec := range map[string]*protocol.ExecSpec{
		"empty": {},
		"both": {Command: protocol.Command{
			Kind: protocol.CommandArgv, Argv: []string{"true"}, Shell: "true",
		}},
		"relative": {Command: protocol.Command{Kind: protocol.CommandArgv, Argv: []string{"true"}}, Cwd: "tmp"},
	} {
		if res, _ := runExec(t, ctx, spec, "", ExecOptions{}); res.Err == nil || res.Err.Code != "invalid_spec" {
			t.Errorf("%s: %+v", name, res)
		}
	}
	if res, _ := runExec(t, ctx, &protocol.ExecSpec{Command: protocol.Command{Kind: protocol.CommandArgv, Argv: []string{"/nonexistent/crh"}}}, "", ExecOptions{}); res.Err == nil || res.Err.Code != "not_found" {
		t.Errorf("missing binary: %+v", res)
	}
}

func TestExecSignalAndTimeout(t *testing.T) {
	ctx := context.Background()
	res, _ := runExec(t, ctx, &protocol.ExecSpec{Command: protocol.Command{Kind: protocol.CommandShell, Shell: "kill -TERM $$"}}, "", ExecOptions{})
	if res.Signal != "TERM" {
		t.Fatalf("signal: %+v", res)
	}
	start := time.Now()
	res, _ = runExec(t, ctx, &protocol.ExecSpec{Command: protocol.Command{Kind: protocol.CommandArgv, Argv: []string{"sleep", "30"}}}, "", ExecOptions{Timeout: 100 * time.Millisecond})
	if !res.TimedOut || res.Signal != "TERM" || time.Since(start) > 5*time.Second {
		t.Fatalf("timeout: %+v after %v", res, time.Since(start))
	}
	// A process ignoring SIGTERM is killed after the grace period.
	start = time.Now()
	res, _ = runExec(t, ctx, &protocol.ExecSpec{Command: protocol.Command{Kind: protocol.CommandShell, Shell: "trap '' TERM; sleep 30"}}, "", ExecOptions{Timeout: 100 * time.Millisecond, KillGrace: 300 * time.Millisecond})
	if !res.TimedOut || res.Signal != "KILL" || time.Since(start) > 5*time.Second {
		t.Fatalf("kill: %+v after %v", res, time.Since(start))
	}
}

func TestExecCancel(t *testing.T) {
	pidPath := filepath.Join(t.TempDir(), "pid")
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	out := NewOutput("x", "", OutputOptions{})
	done := make(chan Result, 1)
	go func() {
		done <- RunExec(ctx, &protocol.ExecSpec{
			Command: protocol.Command{
				Kind:  protocol.CommandShell,
				Shell: `sleep 100 & echo $! > "$CRH_PID_FILE"; wait`,
			},
			Env: map[string]string{"CRH_PID_FILE": pidPath},
		}, nil, out, ExecOptions{})
	}()
	pid := waitPIDFile(t, pidPath)
	cancel()
	res := <-done
	out.Close()
	if !res.Cancelled || res.Signal != "TERM" || res.Err != nil {
		t.Fatalf("cancel: %+v", res)
	}
	expectProcessGone(t, pid)
}

func TestExecKillsBackgroundChildOnNormalEnd(t *testing.T) {
	for _, mode := range []struct {
		name    string
		noPidFD bool
	}{
		{"pidfd", false},
		{"no pidfd", true},
	} {
		t.Run(mode.name, func(t *testing.T) {
			res, out := runExec(t, context.Background(), &protocol.ExecSpec{Command: protocol.Command{
				Kind: protocol.CommandShell, Shell: "sleep 100 & echo $!",
			}}, "", ExecOptions{noPidFD: mode.noPidFD})
			if code(res) != 0 || res.Err != nil {
				t.Fatalf("task ended with %+v, output %q", res, out)
			}
			expectProcessGone(t, backgroundPID(t, out))
		})
	}
}

func TestExecTimeoutKillsBackgroundChild(t *testing.T) {
	for _, mode := range []struct {
		name    string
		noPidFD bool
	}{
		{"pidfd", false},
		{"no pidfd", true},
	} {
		t.Run(mode.name, func(t *testing.T) {
			pidPath := filepath.Join(t.TempDir(), "pid")
			res, _ := runExec(t, context.Background(), &protocol.ExecSpec{
				Command: protocol.Command{
					Kind:  protocol.CommandShell,
					Shell: `sleep 100 & echo $! > "$CRH_PID_FILE"; wait`,
				},
				Env: map[string]string{"CRH_PID_FILE": pidPath},
			}, "", ExecOptions{Timeout: 2 * time.Second, KillGrace: time.Second, noPidFD: mode.noPidFD})
			if !res.TimedOut || res.Signal != "TERM" || res.Err != nil {
				t.Fatalf("timeout: %+v", res)
			}
			expectProcessGone(t, readPIDFile(t, pidPath))
		})
	}
}

func TestExecBackgroundChildDoesNotBlock(t *testing.T) {
	start := time.Now()
	res, out := runExec(t, context.Background(), &protocol.ExecSpec{Command: protocol.Command{Kind: protocol.CommandShell, Shell: "sleep 20 & echo started"}}, "", ExecOptions{})
	if code(res) != 0 || out != "started\n" || time.Since(start) > 10*time.Second {
		t.Fatalf("%+v %q after %v", res, out, time.Since(start))
	}
}

// backgroundPID parses the pid the shell printed with $!.
func backgroundPID(t *testing.T, out string) int {
	t.Helper()
	pid, err := strconv.Atoi(strings.TrimSpace(out))
	if err != nil {
		t.Fatalf("output %q does not hold the background pid", out)
	}
	return pid
}

// waitPIDFile polls until the command wrote its background pid to path.
func waitPIDFile(t *testing.T, path string) int {
	t.Helper()
	deadline := time.Now().Add(10 * time.Second)
	for {
		if data, err := os.ReadFile(path); err == nil {
			if pid, err := strconv.Atoi(strings.TrimSpace(string(data))); err == nil && pid > 0 {
				return pid
			}
		}
		if time.Now().After(deadline) {
			t.Fatalf("pid file %s did not appear", path)
		}
		time.Sleep(10 * time.Millisecond)
	}
}

func readPIDFile(t *testing.T, path string) int {
	t.Helper()
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read pid file: %v", err)
	}
	pid, err := strconv.Atoi(strings.TrimSpace(string(data)))
	if err != nil {
		t.Fatalf("pid file %q holds %q", path, data)
	}
	return pid
}

// expectProcessGone polls until pid no longer exists, so the test does not depend on how quickly
// the kernel reaps a killed process.
func expectProcessGone(t *testing.T, pid int) {
	t.Helper()
	deadline := time.Now().Add(10 * time.Second)
	for {
		err := unix.Kill(pid, 0)
		if errors.Is(err, unix.ESRCH) {
			return
		}
		if time.Now().After(deadline) {
			t.Fatalf("background process %d is still running: %v", pid, err)
		}
		time.Sleep(10 * time.Millisecond)
	}
}
