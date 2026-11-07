package executor

import (
	"context"
	"errors"
	"io"
	"os"
	"os/exec"
	"slices"
	"strings"
	"syscall"
	"time"

	"github.com/Kodecable/ClusterRightHand/client/internal/execenv"
	"github.com/Kodecable/ClusterRightHand/client/internal/protocol"
	"golang.org/x/sys/unix"
)

// DefaultKillGrace is how long a process group gets between SIGTERM and SIGKILL.
const DefaultKillGrace = 5 * time.Second

// PrivilegedPath is the fixed PATH of privileged execution, owned by the environment package.
const PrivilegedPath = execenv.PrivilegedPath

// pipeWait bounds how long we keep reading output after the main process exited, when a background
// child still holds stdout or stderr open.
const pipeWait = 2 * time.Second

type ExecOptions struct {
	Timeout   time.Duration // 0 = none
	KillGrace time.Duration // 0 = DefaultKillGrace
	// Privileged selects the privileged execution environment: a fixed PATH, the root identity and
	// the task's env applied on top of it instead of crha's environment, with bare command names
	// resolved against PrivilegedPath. The caller is responsible for the target identity; this option
	// does not change the uid the process runs as.
	Privileged bool
	// Env is the environment resolved when the crha process started (execenv.Resolve). nil resolves
	// it for this task, which only tests and programmatic callers do: the modes themselves resolve at
	// start and let a failure end the process (doc/execution-plane.md#exec-的执行环境).
	Env *execenv.Environment
	// noPidFD forces the pgid fallback of process reaping, for tests: no pidfd is requested and
	// group signals use kill(-pgid).
	noPidFD bool
}

// Result is the outcome of a finished task.
type Result struct {
	ExitCode  *int32
	Signal    string
	Err       *Error
	TimedOut  bool
	Cancelled bool
	// TaskResult is the task's structured result, nil for a kind that reports none and for a task
	// that failed (doc/protocol.md TaskResult).
	TaskResult *protocol.TaskResult
}

// RunExec runs an exec task in its own process group. When the task ends, normally or through
// cancellation or the timeout, the rest of its process group is killed before the leader is
// reaped, so background children cannot outlive the task. Cancelling ctx (crhs's TaskCancel) or the
// timeout sends SIGTERM to the group, then SIGKILL after the grace period.
func RunExec(ctx context.Context, spec *protocol.ExecSpec, stdin io.Reader, out Sink, opts ExecOptions) Result {
	environment := opts.Env
	if environment == nil {
		resolved, err := execenv.Resolve(execenv.Options{Privileged: opts.Privileged})
		if err != nil {
			return Result{Err: &Error{Code: protocol.CodeInternalError, Message: err.Error()}}
		}
		environment = resolved
	}
	argv, err := execArgv(spec, environment.Shell)
	if err != nil {
		return Result{Err: err}
	}
	if spec.Cwd != "" && !strings.HasPrefix(spec.Cwd, "/") {
		return Result{Err: &Error{Code: protocol.CodeInvalidSpec, Message: "cwd must be absolute"}}
	}
	grace := opts.KillGrace
	if grace == 0 {
		grace = DefaultKillGrace
	}

	name := argv[0]
	env, err := taskEnv(environment, spec.Env, opts.Privileged)
	if err != nil {
		return Result{Err: err}
	}
	if opts.Privileged {
		if name, err = resolvePrivileged(argv[0]); err != nil {
			return Result{Err: err}
		}
	}

	cmd := exec.Command(name, argv[1:]...)
	cmd.Dir = spec.Cwd
	if cmd.Dir == "" {
		cmd.Dir = "/"
	}
	cmd.Env = env
	cmd.Stdin = stdin
	// One writer for both descriptors: os/exec gives them a single pipe when Stdout and Stderr are
	// the same value, so the bytes interleave in write order (doc/execution-plane.md#输出).
	output := out.Writer()
	cmd.Stdout = output
	cmd.Stderr = output
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	pidfd := -1
	if !opts.noPidFD && pidfdWorks() {
		cmd.SysProcAttr.PidFD = &pidfd
	}
	cmd.WaitDelay = pipeWait

	if err := cmd.Start(); err != nil {
		code := protocol.CodeSpawnFailed
		if errors.Is(err, exec.ErrNotFound) || errors.Is(err, os.ErrNotExist) {
			code = protocol.CodeNotFound
		}
		return Result{Err: &Error{Code: code, Message: err.Error()}}
	}
	if pidfd >= 0 {
		defer unix.Close(pidfd)
	}
	return newTaskProcess(cmd, pidfd).run(ctx, opts.Timeout, grace)
}

// taskEnv builds the environment of one task from the resolved environment and the task's own
// variables (doc/execution-plane.md#exec-的执行环境). A privileged task keeps the fixed PATH and never
// receives crha's own CRHA_TASK_* variables; a non-privileged task may override everything, PATH
// included. Variables are sorted so the environment does not depend on map iteration order.
func taskEnv(environment *execenv.Environment, extra map[string]string, privileged bool) ([]string, *Error) {
	values := map[string]string{
		"PATH":    environment.Path,
		"HOME":    environment.Home,
		"USER":    environment.User,
		"LOGNAME": environment.Logname,
		"SHELL":   environment.Shell,
		"LANG":    execenv.Locale,
		"LC_ALL":  execenv.Locale,
	}
	if privileged {
		values["PATH"] = PrivilegedPath
	}
	for k, v := range extra {
		if k == "" || strings.ContainsAny(k, "=\x00") {
			return nil, errf(protocol.CodeInvalidSpec, "invalid environment variable name %q", k)
		}
		if strings.ContainsRune(v, 0) {
			return nil, errf(protocol.CodeInvalidSpec, "environment variable %q contains a NUL byte", k)
		}
		if execenv.IsOverride(k) {
			continue // crha's own variables never reach a task
		}
		if privileged && k == "PATH" {
			continue // the fixed PATH always wins
		}
		values[k] = v
	}
	keys := make([]string, 0, len(values))
	for k := range values {
		keys = append(keys, k)
	}
	slices.Sort(keys)
	env := make([]string, 0, len(keys))
	for _, k := range keys {
		env = append(env, k+"="+values[k])
	}
	return env, nil
}

// resolvePrivileged resolves a bare command name against PrivilegedPath. exec.Command would consult
// crha's own PATH, which would make the fixed PATH ineffective for command lookup.
func resolvePrivileged(name string) (string, *Error) {
	if strings.ContainsRune(name, '/') {
		return name, nil
	}
	found, err := execenv.LookPathIn(PrivilegedPath, name)
	if err != nil {
		return "", errf(protocol.CodeNotFound, "executable %q not found in PATH", name)
	}
	return found, nil
}

// execArgv returns the argv of the task. A `shell` command runs on the shell this node discovered
// (doc/execution-plane.md#exec-的执行环境); authorization, rule matching and display keep rendering it
// as /bin/sh -c, which is done by those layers, not here.
func execArgv(spec *protocol.ExecSpec, sh string) ([]string, *Error) {
	cmd := spec.Command
	switch {
	case len(cmd.Argv) > 0 && cmd.Shell != "":
		return nil, &Error{Code: protocol.CodeInvalidSpec, Message: "argv and shell are mutually exclusive"}
	case cmd.Kind == protocol.CommandArgv:
		if len(cmd.Argv) == 0 {
			return nil, &Error{Code: protocol.CodeInvalidSpec, Message: "argv must not be empty"}
		}
		return cmd.Argv, nil
	case cmd.Kind == protocol.CommandShell:
		if cmd.Shell == "" {
			return nil, &Error{Code: protocol.CodeInvalidSpec, Message: "shell must not be empty"}
		}
		return []string{sh, "-c", cmd.Shell}, nil
	default:
		return nil, &Error{Code: protocol.CodeInvalidSpec, Message: "command must be argv or shell"}
	}
}

func fillExit(res *Result, ps *os.ProcessState, waitErr error) {
	if ps == nil {
		res.Err = &Error{Code: protocol.CodeIOError, Message: waitErr.Error()}
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
