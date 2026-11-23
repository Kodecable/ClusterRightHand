// Package audit writes the privileged mode's local log, one JSON object per line
// (doc/design/privilege.md "The privileged mode"). Every line is appended to the log file, the
// durable copy, with its time and, for an accepted task or terminal, the full spec. A record can also be
// mirrored through crha's logger as one human-readable line: the event and its fields, but never
// the time (the line has its own) and never the full spec (the file keeps it).
package audit

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/Kodecable/ClusterRightHand/client/internal/protocol"
)

// Options configures Open.
type Options struct {
	// Logger, when non-nil, mirrors every record as one human-readable line in addition to the
	// file. nil means no mirror: the file is the only copy.
	Logger *slog.Logger
	// Now returns the current time; nil means time.Now. Tests use it to make records
	// deterministic.
	Now func() time.Time
}

// Record is one local-log line. A caller fills the fields its event has; the zero value
// of the others is omitted so the line stays readable.
type Record struct {
	Event string `json:"event"`
	Time  string `json:"time"`

	TaskID  string        `json:"task_id,omitempty"`
	Attempt protocol.Uint `json:"attempt,omitempty"`
	// Entry is the name of the trust entry that accepted the task.
	Entry string `json:"entry,omitempty"`
	// AuthorizationID is the hex authorization id the task was executed under.
	AuthorizationID string `json:"authorization_id,omitempty"`
	// SpecSHA256 is the hex hash of the accepted task spec.
	SpecSHA256 string `json:"spec_sha256,omitempty"`
	// Spec is the full task specification of an accepted task or terminal, as protocol.TaskSpec.
	Spec *protocol.TaskSpec `json:"spec,omitempty"`
	// PTYID is the terminal a terminal event is about. A privileged terminal's local-log records
	// use it where a task's records carry TaskID: the terminal id stands in for the task id in the
	// authorization and the used list (doc/design/pty.md "Privilege").
	PTYID string `json:"pty_id,omitempty"`

	// Code, Step and Message describe a refusal: the task.start error code, the
	// verification step of doc/design/privilege.md "Validation flow" and its message.
	Code    string `json:"code,omitempty"`
	Step    int    `json:"step,omitempty"`
	Message string `json:"message,omitempty"`

	// ExitCode is the code a terminal's process ended with (terminal.exited, and terminal.closed
	// when it ended before the close).
	ExitCode *int `json:"exit_code,omitempty"`

	// Outcome fields of a finished task.
	Outcome    string `json:"outcome,omitempty"`
	TimedOut   bool   `json:"timed_out,omitempty"`
	Cancelled  bool   `json:"cancelled,omitempty"`
	OutputEnd  uint64 `json:"output_end,omitempty"`
	DurationMS int64  `json:"duration_ms,omitempty"`

	// UID is the local uid that opened or closed an approval window, or that opened the window a
	// task was accepted through.
	UID *uint32 `json:"uid,omitempty"`
	// UntilMS is the window's deadline, logged when a window opens, closes or expires.
	UntilMS int64 `json:"until_ms,omitempty"`
	// Detail carries free-form context, for example why a reload failed.
	Detail string `json:"detail,omitempty"`
}

// logFile is the append-only log; tests replace it with a fake to observe Sync.
type logFile interface {
	Write([]byte) (int, error)
	Sync() error
	Close() error
}

// Logger appends records to the local log file and mirrors them. It is safe for
// concurrent use.
type Logger struct {
	path   string
	mirror *slog.Logger
	now    func() time.Time

	mu   sync.Mutex
	file logFile
}

// Open opens (creating if needed) the log at path with mode 0600. The parent directory
// is created with mode 0750, because journald and an administrator need to read the
// directory even though only the privileged user may write the file.
func Open(path string, opts Options) (*Logger, error) {
	if path == "" {
		return nil, fmt.Errorf("audit: empty log path")
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o750); err != nil {
		return nil, fmt.Errorf("audit: create %s: %w", filepath.Dir(path), err)
	}
	f, err := os.OpenFile(path, os.O_WRONLY|os.O_APPEND|os.O_CREATE, 0o600)
	if err != nil {
		return nil, fmt.Errorf("audit: open %s: %w", path, err)
	}
	// An existing file keeps its mode; an audit log that someone made group-readable is
	// not this package's call to rewrite, but the mode at creation must be 0600.
	if err := f.Chmod(0o600); err != nil {
		f.Close()
		return nil, fmt.Errorf("audit: chmod %s: %w", path, err)
	}
	now := opts.Now
	if now == nil {
		now = time.Now
	}
	return &Logger{path: path, mirror: opts.Logger, now: now, file: f}, nil
}

// Path returns the log file path.
func (l *Logger) Path() string { return l.path }

// Log appends one record and syncs it before Log returns, so a task is logged
// before it starts even if the machine loses power. The mirror is best effort: a
// missing journal or a failing logger does not affect the durable file.
func (l *Logger) Log(rec Record) error {
	if rec.Event == "" {
		return fmt.Errorf("audit: record has no event")
	}
	l.mu.Lock()
	defer l.mu.Unlock()
	if l.file == nil {
		return fmt.Errorf("audit: log is closed")
	}
	if rec.Time == "" {
		now := l.now
		if now == nil {
			now = time.Now
		}
		rec.Time = now().UTC().Format(time.RFC3339Nano)
	}
	data, err := json.Marshal(rec)
	if err != nil {
		return fmt.Errorf("audit: encode %q: %w", rec.Event, err)
	}
	data = append(data, '\n')

	if _, err := l.file.Write(data); err != nil {
		return fmt.Errorf("audit: append: %w", err)
	}
	if err := l.file.Sync(); err != nil {
		return fmt.Errorf("audit: sync: %w", err)
	}
	if l.mirror != nil {
		level := slog.LevelInfo
		if failureEvent(rec.Event) {
			level = slog.LevelWarn
		}
		l.mirror.LogAttrs(context.Background(), level, "audit "+rec.Event, mirrorAttrs(rec)...)
	}
	return nil
}

// failureEvent reports whether an event is a refusal or a failure: those are mirrored at Warn, the
// rest at Info.
func failureEvent(event string) bool {
	return strings.HasSuffix(event, ".refused") ||
		strings.HasSuffix(event, ".failed") || strings.HasSuffix(event, "_failed") ||
		strings.HasSuffix(event, ".undelivered")
}

// mirrorAttrs are the attributes of a mirrored record: the set fields, in a fixed order, and never
// the time or the full spec.
func mirrorAttrs(rec Record) []slog.Attr {
	attrs := make([]slog.Attr, 0, 16)
	if rec.TaskID != "" {
		attrs = append(attrs, slog.String("task_id", rec.TaskID))
	}
	if rec.PTYID != "" {
		attrs = append(attrs, slog.String("pty_id", rec.PTYID))
	}
	if rec.Attempt != 0 {
		attrs = append(attrs, slog.Uint64("attempt", uint64(rec.Attempt)))
	}
	if rec.Entry != "" {
		attrs = append(attrs, slog.String("entry", rec.Entry))
	}
	if rec.AuthorizationID != "" {
		attrs = append(attrs, slog.String("authorization_id", rec.AuthorizationID))
	}
	if rec.SpecSHA256 != "" {
		attrs = append(attrs, slog.String("spec_sha256", rec.SpecSHA256))
	}
	if rec.Code != "" {
		attrs = append(attrs, slog.String("code", rec.Code))
	}
	if rec.Step != 0 {
		attrs = append(attrs, slog.Int("step", rec.Step))
	}
	if rec.Message != "" {
		attrs = append(attrs, slog.String("message", rec.Message))
	}
	if rec.ExitCode != nil {
		attrs = append(attrs, slog.Int("exit_code", *rec.ExitCode))
	}
	if rec.Outcome != "" {
		attrs = append(attrs, slog.String("outcome", rec.Outcome))
	}
	if rec.TimedOut {
		attrs = append(attrs, slog.Bool("timed_out", true))
	}
	if rec.Cancelled {
		attrs = append(attrs, slog.Bool("cancelled", true))
	}
	if rec.OutputEnd != 0 {
		attrs = append(attrs, slog.Uint64("output_end", rec.OutputEnd))
	}
	if rec.DurationMS != 0 {
		attrs = append(attrs, slog.Int64("duration_ms", rec.DurationMS))
	}
	if rec.UID != nil {
		attrs = append(attrs, slog.Uint64("uid", uint64(*rec.UID)))
	}
	if rec.UntilMS != 0 {
		attrs = append(attrs, slog.Int64("until_ms", rec.UntilMS))
	}
	if rec.Detail != "" {
		attrs = append(attrs, slog.String("detail", rec.Detail))
	}
	return attrs
}

// Close closes the log file.
func (l *Logger) Close() error {
	l.mu.Lock()
	defer l.mu.Unlock()
	if l.file == nil {
		return nil
	}
	err := l.file.Close()
	l.file = nil
	return err
}
