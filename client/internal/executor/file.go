// Package executor runs tasks on the node.
package executor

import (
	"context"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"path/filepath"
	"syscall"

	"github.com/Kodecable/ClusterRightHand/client/internal/protocol"
)

const (
	maxEditSize      = 16 << 20
	defaultListLimit = 500
	maxListLimit     = 5000
	copyChunk        = 64 << 10
)

// Error is a task failure reported to crhs as TaskError{code, message}.
type Error struct{ Code, Message string }

func (e *Error) Error() string { return e.Code + ": " + e.Message }

func errf(code, format string, args ...any) *Error {
	return &Error{Code: code, Message: fmt.Sprintf(format, args...)}
}

// RunFile executes a file.* task as the unprivileged mode does: paths are opened directly, and a
// symbolic link at the end of a write or edit path is followed to its target. stdout receives the
// task's text output (the page of a file.read) and input carries the file.write content (nil for
// other kinds). It returns the task's structured result, or nil with an *Error (other errors are
// wrapped into Error{Code: "io_error"}).
func RunFile(ctx context.Context, spec *protocol.TaskSpec, input io.Reader, stdout io.Writer) (*protocol.TaskResult, error) {
	return runFileTask(ctx, spec, input, stdout, plainAccess{})
}

// RunFilePrivileged executes a file.* task the way privileged execution must: every path is opened
// with openat2(RESOLVE_BENEATH|RESOLVE_NO_SYMLINKS) from an fd for "/", and stat, read, list and
// write operate on the resulting fds. A symbolic link at any level is refused, and so is a kernel
// or sandbox that does not provide openat2; there is no fallback to path-based operations
// (doc/privilege.md "方法与目标"). It returns the task's structured result.
func RunFilePrivileged(ctx context.Context, spec *protocol.TaskSpec, input io.Reader, stdout io.Writer) (*protocol.TaskResult, error) {
	root, err := openPrivilegedFileRoot()
	if err != nil {
		return nil, normalizeErr(err)
	}
	defer root.Close()
	return runFileTask(ctx, spec, input, stdout, privilegedAccess{root: root})
}

// runFileTask executes one file task through acc, which decides how paths are resolved and opened.
// Everything after the open is the same code for both modes.
func runFileTask(ctx context.Context, spec *protocol.TaskSpec, input io.Reader, stdout io.Writer, acc fileAccess) (*protocol.TaskResult, error) {
	var result *protocol.TaskResult
	var err error
	switch spec.Kind {
	case protocol.TaskSpecFileRead:
		if spec.FileRead == nil {
			return nil, errf("invalid_spec", "file.read task has no spec")
		}
		result, err = fileRead(ctx, acc, spec.FileRead, stdout)
	case protocol.TaskSpecFileWrite:
		if spec.FileWrite == nil {
			return nil, errf("invalid_spec", "file.write task has no spec")
		}
		result, err = fileWrite(ctx, acc, spec.FileWrite, input)
	case protocol.TaskSpecFileEdit:
		if spec.FileEdit == nil {
			return nil, errf("invalid_spec", "file.edit task has no spec")
		}
		result, err = fileEdit(acc, spec.FileEdit)
	case protocol.TaskSpecFileStat:
		if spec.FileStat == nil {
			return nil, errf("invalid_spec", "file.stat task has no spec")
		}
		result, err = fileStat(acc, spec.FileStat)
	case protocol.TaskSpecFileList:
		if spec.FileList == nil {
			return nil, errf("invalid_spec", "file.list task has no spec")
		}
		result, err = fileList(ctx, acc, spec.FileList)
	default:
		err = errf("invalid_spec", "not a file task: %q", spec.Kind)
	}
	return result, normalizeErr(err)
}

func normalizeErr(err error) error {
	var te *Error
	switch {
	case err == nil:
		return nil
	case errors.As(err, &te):
		return te
	case errors.Is(err, context.Canceled), errors.Is(err, context.DeadlineExceeded):
		return errf("cancelled", "%v", err)
	default:
		return mapErr(err)
	}
}

func mapErr(err error) *Error {
	switch {
	case errors.Is(err, fs.ErrNotExist):
		return errf("not_found", "%v", err)
	case errors.Is(err, fs.ErrPermission):
		return errf("permission_denied", "%v", err)
	case errors.Is(err, syscall.EISDIR):
		return errf("is_directory", "%v", err)
	case errors.Is(err, syscall.ENOTDIR):
		return errf("not_found", "%v", err)
	}
	return errf("io_error", "%v", err)
}

func checkPath(p string) error {
	if !filepath.IsAbs(p) || filepath.Clean(p) != p {
		return errf("invalid_spec", "path must be absolute and clean: %q", p)
	}
	return nil
}

// copyCtx copies src to dst in chunks, checking ctx between chunks.
func copyCtx(ctx context.Context, dst io.Writer, src io.Reader) (int64, error) {
	buf := make([]byte, copyChunk)
	var total int64
	for {
		if err := ctx.Err(); err != nil {
			return total, err
		}
		n, rerr := src.Read(buf)
		if n > 0 {
			m, werr := dst.Write(buf[:n])
			total += int64(m)
			if werr != nil {
				return total, werr
			}
		}
		if rerr == io.EOF {
			return total, nil
		}
		if rerr != nil {
			// A cancelled task's input reader fails because the queue was aborted. Report the
			// cancellation, not the queue error, so the task still exits as cancelled.
			if ctxErr := ctx.Err(); ctxErr != nil {
				return total, ctxErr
			}
			return total, rerr
		}
	}
}
