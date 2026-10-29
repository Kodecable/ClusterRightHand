package executor

import (
	"context"
	"strings"
	"testing"
	"time"

	"github.com/Kodecable/ClusterRightHand/client/internal/protocol"
)

func runExec(t *testing.T, ctx context.Context, spec *protocol.ExecSpec, stdin string, opts ExecOptions) (Result, string, string) {
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
	return res, readAll(t, o, stdout, 0), readAll(t, o, stderr, 0)
}

func code(r Result) int32 {
	if r.ExitCode == nil {
		return -1
	}
	return *r.ExitCode
}

func TestExecBasics(t *testing.T) {
	ctx := context.Background()
	res, out, errOut := runExec(t, ctx, &protocol.ExecSpec{Command: protocol.Command{Kind: protocol.CommandShell, Shell: "echo out; echo err >&2; exit 3"}}, "", ExecOptions{})
	if code(res) != 3 || out != "out\n" || errOut != "err\n" || res.Err != nil {
		t.Fatalf("res %+v out %q err %q", res, out, errOut)
	}
	res, out, _ = runExec(t, ctx, &protocol.ExecSpec{Command: protocol.Command{Kind: protocol.CommandArgv, Argv: []string{"cat"}}}, "piped", ExecOptions{})
	if code(res) != 0 || out != "piped" {
		t.Fatalf("stdin: %+v %q", res, out)
	}
	res, out, _ = runExec(t, ctx, &protocol.ExecSpec{Command: protocol.Command{Kind: protocol.CommandShell, Shell: "echo $CRH_X; pwd"}, Env: map[string]string{"CRH_X": "y"}, Cwd: "/tmp"}, "", ExecOptions{})
	if out != "y\n/tmp\n" {
		t.Fatalf("env/cwd: %+v %q", res, out)
	}
	res, out, _ = runExec(t, ctx, &protocol.ExecSpec{Command: protocol.Command{Kind: protocol.CommandArgv, Argv: []string{"pwd"}}}, "", ExecOptions{})
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
		if res, _, _ := runExec(t, ctx, spec, "", ExecOptions{}); res.Err == nil || res.Err.Code != "invalid_spec" {
			t.Errorf("%s: %+v", name, res)
		}
	}
	if res, _, _ := runExec(t, ctx, &protocol.ExecSpec{Command: protocol.Command{Kind: protocol.CommandArgv, Argv: []string{"/nonexistent/crh"}}}, "", ExecOptions{}); res.Err == nil || res.Err.Code != "not_found" {
		t.Errorf("missing binary: %+v", res)
	}
}

func TestExecSignalAndTimeout(t *testing.T) {
	ctx := context.Background()
	res, _, _ := runExec(t, ctx, &protocol.ExecSpec{Command: protocol.Command{Kind: protocol.CommandShell, Shell: "kill -TERM $$"}}, "", ExecOptions{})
	if res.Signal != "TERM" {
		t.Fatalf("signal: %+v", res)
	}
	start := time.Now()
	res, _, _ = runExec(t, ctx, &protocol.ExecSpec{Command: protocol.Command{Kind: protocol.CommandArgv, Argv: []string{"sleep", "30"}}}, "", ExecOptions{Timeout: 100 * time.Millisecond})
	if !res.TimedOut || res.Signal != "TERM" || time.Since(start) > 5*time.Second {
		t.Fatalf("timeout: %+v after %v", res, time.Since(start))
	}
	// A process ignoring SIGTERM is killed after the grace period.
	start = time.Now()
	res, _, _ = runExec(t, ctx, &protocol.ExecSpec{Command: protocol.Command{Kind: protocol.CommandShell, Shell: "trap '' TERM; sleep 30"}}, "", ExecOptions{Timeout: 100 * time.Millisecond, KillGrace: 300 * time.Millisecond})
	if !res.TimedOut || res.Signal != "KILL" || time.Since(start) > 5*time.Second {
		t.Fatalf("kill: %+v after %v", res, time.Since(start))
	}
}

func TestExecCancel(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	go func() { time.Sleep(100 * time.Millisecond); cancel() }()
	res, _, _ := runExec(t, ctx, &protocol.ExecSpec{Command: protocol.Command{Kind: protocol.CommandArgv, Argv: []string{"sleep", "30"}}}, "", ExecOptions{})
	if !res.Cancelled || res.Signal != "TERM" {
		t.Fatalf("cancel: %+v", res)
	}
}

func TestExecBackgroundChildDoesNotBlock(t *testing.T) {
	start := time.Now()
	res, out, _ := runExec(t, context.Background(), &protocol.ExecSpec{Command: protocol.Command{Kind: protocol.CommandShell, Shell: "sleep 20 & echo started"}}, "", ExecOptions{})
	if code(res) != 0 || out != "started\n" || time.Since(start) > 10*time.Second {
		t.Fatalf("%+v %q after %v", res, out, time.Since(start))
	}
}
