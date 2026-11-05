// Package audit writes the privileged mode's local log, one JSON object per line
// (doc/privilege.md 特权模式: 本地日志). Every line is appended to the log file, which
// systemd's journald collects from stderr as well, and mirrored to a second writer
// (normally stderr) so the same records appear in journald.
package audit

import (
	"encoding/json"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"sync"
	"time"

	"github.com/Kodecable/ClusterRightHand/client/internal/protocol"
)

// Options configures Open.
type Options struct {
	// Mirror receives every record in addition to the file. nil means os.Stderr.
	Mirror io.Writer
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
	// Spec is the full task specification of an accepted task, as protocol.TaskSpec.
	Spec *protocol.TaskSpec `json:"spec,omitempty"`

	// Code, Step and Message describe a refusal: the task.start error code, the
	// verification step of doc/privilege.md 校验流程 and its message.
	Code    string `json:"code,omitempty"`
	Step    int    `json:"step,omitempty"`
	Message string `json:"message,omitempty"`

	// Outcome fields of a finished task.
	Outcome    string `json:"outcome,omitempty"`
	TimedOut   bool   `json:"timed_out,omitempty"`
	Cancelled  bool   `json:"cancelled,omitempty"`
	OutputEnd  uint64 `json:"output_end,omitempty"`
	DurationMS int64  `json:"duration_ms,omitempty"`

	// UID is the approver of a local approve/deny.
	UID *uint32 `json:"uid,omitempty"`
	// Detail carries free-form context, for example why a reload failed.
	Detail string `json:"detail,omitempty"`
}

// Logger appends records to the local log file and mirrors them. It is safe for
// concurrent use.
type Logger struct {
	path   string
	mirror io.Writer
	now    func() time.Time

	mu   sync.Mutex
	file *os.File
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
	mirror := opts.Mirror
	if mirror == nil {
		mirror = os.Stderr
	}
	now := opts.Now
	if now == nil {
		now = time.Now
	}
	return &Logger{path: path, mirror: mirror, now: now, file: f}, nil
}

// Path returns the log file path.
func (l *Logger) Path() string { return l.path }

// Log appends one record. The record is written and flushed before Log returns, so a
// task is logged before it starts. A mirror write failure is ignored: journald may not
// be there, and the file is the durable copy.
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
	if l.mirror != nil {
		_, _ = l.mirror.Write(data)
	}
	return nil
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
