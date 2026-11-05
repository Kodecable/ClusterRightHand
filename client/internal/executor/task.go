package executor

import (
	"context"
	"errors"
	"io"
	"time"

	"github.com/Kodecable/ClusterRightHand/client/internal/execenv"
	"github.com/Kodecable/ClusterRightHand/client/internal/protocol"
)

// Sink receives a task's output: one stream, stdout and stderr together. *Output implements it;
// privileged execution uses a forward-only sink that turns output into crh-priv events instead of
// keeping it.
type Sink interface {
	Writer() io.Writer
}

// TaskOptions is the execution environment of one task. Privileged execution (the native helper and
// the privileged daemon) fixes PATH and resolves file paths with openat2; unprivileged execution
// keeps the path-based file operations. Env is the environment the crha process resolved when it
// started (doc/execution-plane.md#exec-的执行环境).
type TaskOptions struct {
	Timeout    time.Duration // exec timeout; 0 = none
	KillGrace  time.Duration // SIGTERM-to-SIGKILL grace of exec; 0 = DefaultKillGrace
	Privileged bool
	Env        *execenv.Environment
}

// RunTask executes spec to completion and writes its output to out. The Result carries the outcome
// fields of task.exit; the caller closes out and adds the final stream ends and the output file
// once every writer has stopped.
func RunTask(ctx context.Context, spec *protocol.TaskSpec, in io.Reader, out Sink, opts TaskOptions) Result {
	if spec.Kind == protocol.TaskSpecExec {
		if spec.Exec == nil {
			return Result{Err: errf("invalid_spec", "exec task has no spec")}
		}
		return RunExec(ctx, spec.Exec, in, out, ExecOptions{
			Timeout: opts.Timeout, KillGrace: opts.KillGrace, Privileged: opts.Privileged, Env: opts.Env,
		})
	}
	var result *protocol.TaskResult
	var err error
	if opts.Privileged {
		result, err = RunFilePrivileged(ctx, spec, in, out.Writer())
	} else {
		result, err = RunFile(ctx, spec, in, out.Writer())
	}
	return fileResult(result, err)
}

// fileResult converts a file task's result and error into a Result. A file task that ran has exit
// code 0 and carries its structured result.
func fileResult(result *protocol.TaskResult, err error) Result {
	if err == nil {
		code := int32(0)
		return Result{ExitCode: &code, TaskResult: result}
	}
	var e *Error
	if errors.As(err, &e) {
		return Result{Err: e, Cancelled: e.Code == "cancelled"}
	}
	return Result{Err: &Error{Code: "io_error", Message: err.Error()}}
}

// Outcome returns the task.exit outcome of a finished task.
func (r Result) Outcome() protocol.Outcome {
	switch {
	case r.Err != nil:
		return protocol.Outcome{
			Kind:  protocol.OutcomeError,
			Error: &protocol.Error{Code: r.Err.Code, Message: protocol.ErrorMessage(r.Err.Message)},
		}
	case r.Signal != "":
		return protocol.Outcome{Kind: protocol.OutcomeSignal, Signal: protocol.CleanText(r.Signal)}
	case r.ExitCode != nil:
		return protocol.Outcome{Kind: protocol.OutcomeCode, Code: protocol.Int(*r.ExitCode)}
	default:
		// RunExec always fills one of the three fields; guard a programmatic Result anyway.
		return protocol.Outcome{
			Kind:  protocol.OutcomeError,
			Error: &protocol.Error{Code: "internal_error", Message: "task finished without an outcome"},
		}
	}
}
