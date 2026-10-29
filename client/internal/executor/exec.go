package executor

import (
	"context"
	"errors"
	"io"
	"os"
	"os/exec"
	"strings"
	"syscall"
	"time"

	"github.com/Kodecable/ClusterRightHand/client/internal/protocol"
	"golang.org/x/sys/unix"
)

// DefaultKillGrace is how long a process group gets between SIGTERM and SIGKILL.
const DefaultKillGrace = 5 * time.Second

// pipeWait bounds how long we keep reading output after the main process exited, when a background
// child still holds stdout or stderr open.
const pipeWait = 2 * time.Second

type ExecOptions struct {
	Timeout   time.Duration // 0 = none
	KillGrace time.Duration // 0 = DefaultKillGrace
}

// Result is the outcome of a finished task.
type Result struct {
	ExitCode  *int32
	Signal    string
	Err       *Error
	TimedOut  bool
	Cancelled bool
}

// RunExec runs an exec task in its own process group. Cancelling ctx (crhs's TaskCancel) or the timeout
// sends SIGTERM to the group, then SIGKILL after the grace period.
func RunExec(ctx context.Context, spec *protocol.ExecSpec, stdin io.Reader, out *Output, opts ExecOptions) Result {
	argv, err := execArgv(spec)
	if err != nil {
		return Result{Err: err}
	}
	if spec.Cwd != "" && !strings.HasPrefix(spec.Cwd, "/") {
		return Result{Err: &Error{Code: "invalid_spec", Message: "cwd must be absolute"}}
	}
	grace := opts.KillGrace
	if grace == 0 {
		grace = DefaultKillGrace
	}

	cmd := exec.Command(argv[0], argv[1:]...)
	cmd.Dir = spec.Cwd
	if cmd.Dir == "" {
		cmd.Dir = "/"
	}
	cmd.Env = os.Environ()
	for k, v := range spec.Env {
		cmd.Env = append(cmd.Env, k+"="+v)
	}
	cmd.Stdin = stdin
	cmd.Stdout = out.Writer(protocol.StreamStdout)
	cmd.Stderr = out.Writer(protocol.StreamStderr)
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	cmd.WaitDelay = pipeWait

	if err := cmd.Start(); err != nil {
		code := "spawn_failed"
		if errors.Is(err, exec.ErrNotFound) || errors.Is(err, os.ErrNotExist) {
			code = "not_found"
		}
		return Result{Err: &Error{Code: code, Message: err.Error()}}
	}
	pgid := cmd.Process.Pid

	var timeout <-chan time.Time
	if opts.Timeout > 0 {
		t := time.NewTimer(opts.Timeout)
		defer t.Stop()
		timeout = t.C
	}
	done := make(chan error, 1)
	go func() { done <- cmd.Wait() }()

	var res Result
	var kill <-chan time.Time
	terminate := func() {
		_ = unix.Kill(-pgid, unix.SIGTERM)
		kill = time.After(grace)
	}
	ctxDone := ctx.Done()
	for {
		select {
		case <-ctxDone:
			res.Cancelled = true
			ctxDone = nil
			terminate()
		case <-timeout:
			res.TimedOut = true
			timeout = nil
			terminate()
		case <-kill:
			_ = unix.Kill(-pgid, unix.SIGKILL)
			kill = nil
		case err := <-done:
			if (res.Cancelled || res.TimedOut) && kill != nil {
				// The leader is gone; don't leave its group running past the grace period.
				go func(k <-chan time.Time) { <-k; _ = unix.Kill(-pgid, unix.SIGKILL) }(kill)
			}
			fillExit(&res, cmd.ProcessState, err)
			return res
		}
	}
}

func execArgv(spec *protocol.ExecSpec) ([]string, *Error) {
	cmd := spec.Command
	switch {
	case len(cmd.Argv) > 0 && cmd.Shell != "":
		return nil, &Error{Code: "invalid_spec", Message: "argv and shell are mutually exclusive"}
	case cmd.Kind == protocol.CommandArgv:
		if len(cmd.Argv) == 0 {
			return nil, &Error{Code: "invalid_spec", Message: "argv must not be empty"}
		}
		return cmd.Argv, nil
	case cmd.Kind == protocol.CommandShell:
		if cmd.Shell == "" {
			return nil, &Error{Code: "invalid_spec", Message: "shell must not be empty"}
		}
		return []string{"/bin/sh", "-c", cmd.Shell}, nil
	default:
		return nil, &Error{Code: "invalid_spec", Message: "command must be argv or shell"}
	}
}

func fillExit(res *Result, ps *os.ProcessState, waitErr error) {
	if ps == nil {
		res.Err = &Error{Code: "io_error", Message: waitErr.Error()}
		return
	}
	ws, ok := ps.Sys().(syscall.WaitStatus)
	switch {
	case ok && ws.Signaled():
		res.Signal = strings.TrimPrefix(unix.SignalName(ws.Signal()), "SIG")
	default:
		code := int32(ps.ExitCode())
		res.ExitCode = &code
	}
	// exec.ErrWaitDelay only means a background child kept the pipes open; the exit status is valid.
}
