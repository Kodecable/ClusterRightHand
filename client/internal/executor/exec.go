package executor

import (
	"context"
	"errors"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"slices"
	"strings"
	"syscall"
	"time"

	"github.com/Kodecable/ClusterRightHand/client/internal/protocol"
	"golang.org/x/sys/unix"
)

// DefaultKillGrace is how long a process group gets between SIGTERM and SIGKILL.
const DefaultKillGrace = 5 * time.Second

// PrivilegedPath is the fixed PATH of privileged execution. It is not inherited from crha's
// environment, so a bare command name always resolves the same way and a task cannot point PATH at
// a binary of its own (doc/privilege.md "方法与目标").
const PrivilegedPath = "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"

// pipeWait bounds how long we keep reading output after the main process exited, when a background
// child still holds stdout or stderr open.
const pipeWait = 2 * time.Second

type ExecOptions struct {
	Timeout   time.Duration // 0 = none
	KillGrace time.Duration // 0 = DefaultKillGrace
	// Privileged selects the privileged execution environment: a fixed PATH, the task's env applied
	// on top of it instead of crha's environment, and bare command names resolved against
	// PrivilegedPath. The caller is responsible for the target identity; this option does not
	// change the uid the process runs as.
	Privileged bool
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
func RunExec(ctx context.Context, spec *protocol.ExecSpec, stdin io.Reader, out Sink, opts ExecOptions) Result {
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

	name := argv[0]
	var env []string
	if opts.Privileged {
		if env, err = privilegedEnv(spec.Env); err != nil {
			return Result{Err: err}
		}
		if name, err = resolvePrivileged(argv[0]); err != nil {
			return Result{Err: err}
		}
	} else {
		env = os.Environ()
		for k, v := range spec.Env {
			env = append(env, k+"="+v)
		}
	}

	cmd := exec.Command(name, argv[1:]...)
	cmd.Dir = spec.Cwd
	if cmd.Dir == "" {
		cmd.Dir = "/"
	}
	cmd.Env = env
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

// privilegedEnv builds the environment of a privileged task: the fixed PATH plus the task's own
// variables, never PATH from the task. Variables are sorted so the environment does not depend on
// map iteration order.
func privilegedEnv(taskEnv map[string]string) ([]string, *Error) {
	env := make([]string, 0, len(taskEnv)+1)
	env = append(env, "PATH="+PrivilegedPath)
	keys := make([]string, 0, len(taskEnv))
	for k, v := range taskEnv {
		if k == "" || strings.ContainsAny(k, "=\x00") {
			return nil, errf("invalid_spec", "invalid environment variable name %q", k)
		}
		if strings.ContainsRune(v, 0) {
			return nil, errf("invalid_spec", "environment variable %q contains a NUL byte", k)
		}
		if k == "PATH" {
			continue // the fixed PATH always wins
		}
		keys = append(keys, k)
	}
	slices.Sort(keys)
	for _, k := range keys {
		env = append(env, k+"="+taskEnv[k])
	}
	return env, nil
}

// resolvePrivileged resolves a bare command name against PrivilegedPath. exec.Command would consult
// crha's own PATH, which would make the fixed PATH ineffective for command lookup.
func resolvePrivileged(name string) (string, *Error) {
	if strings.ContainsRune(name, '/') {
		return name, nil
	}
	for _, dir := range filepath.SplitList(PrivilegedPath) {
		candidate := filepath.Join(dir, name)
		fi, err := os.Stat(candidate)
		if err != nil || fi.IsDir() || fi.Mode()&0o111 == 0 {
			continue
		}
		return candidate, nil
	}
	return "", errf("not_found", "executable %q not found in PATH", name)
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
