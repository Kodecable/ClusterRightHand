// Package state persists the privileged mode's used list (doc/design/privilege.md "Authorizations", doc/design/privilege.md "Clock").
//
// The list is an append-only JSON-lines file. A record is written and fsync'd before the
// task it describes starts, so a crash cannot lose the fact that an authorization was used.
// The file is compacted once it has twice as many lines as the list has live records: the
// live records are rewritten to a temporary file that atomically replaces the old one, so the
// file never grows without bound. At startup the list is loaded, the retention and size rules
// are applied, and the compacted file is written once. A final line that was torn by a crash
// and does not parse is ignored, because that append never became durable.
//
// In memory the list is capped. Evicting a record whose authorization is still acceptable
// raises a watermark: an authorization issued at or before the watermark must be signed again,
// so eviction cannot make a used pair usable again while the process runs. The watermark is
// memory only, and compaction writes only the live records: after a restart the watermark is
// rebuilt from those records, so a record that was both evicted and compacted away leaves no
// trace and its authorization can be used again until its deadline. That is the documented
// trade-off of the used list (doc/design/privilege.md "Used list"), not a guarantee across restarts.
package state

import (
	"bufio"
	"bytes"
	"container/list"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"os"
	"path/filepath"
	"sync"
	"time"
)

const (
	usedFileName = "used"
	// localRetention is how long a record without an authorization is kept: a local approval
	// (or a legacy record whose authorization has no deadline).
	localRetention = 24 * time.Hour
	// minRetentionMargin is the least time a record with an authorization is kept past its
	// deadline. A larger clock_skew extends it, so a one-shot authorization cannot be used
	// again after the clock stepped back by up to the configured skew (doc/design/privilege.md "Clock").
	minRetentionMargin = time.Hour
)

// maxRecords bounds the in-memory used list. It is a variable so tests can lower it.
var maxRecords = 8192

// rebuildFloor is the live count below which the file is rebuilt at 2*rebuildFloor lines, so
// a small list does not rewrite its file on every append. It is a variable so tests can lower
// it.
var rebuildFloor = 1024

// ErrAlreadyRecorded reports that a task id is already in the used list.
var ErrAlreadyRecorded = errors.New("state: task is already recorded")

// Record is one line of the used list: a task that ran, the authorization that allowed it
// (absent for a local approval), the authorization's times and the spec hash.
type Record struct {
	TaskID  string `json:"task_id"`
	Attempt uint64 `json:"attempt,omitempty"`
	// AuthorizationID is the hex authorization id; empty when the task was approved
	// locally instead.
	AuthorizationID string `json:"authorization_id,omitempty"`
	// IssuedAtMS is the authorization's issued_at in Unix milliseconds. It is zero (and
	// omitted) for a local approval, which has no authorization.
	IssuedAtMS int64 `json:"issued_at_ms,omitempty"`
	// DeadlineMS is the authorization's deadline in Unix milliseconds; nil means the
	// authorization has no deadline (only a legacy record can).
	DeadlineMS *int64 `json:"deadline_ms,omitempty"`
	// SpecSHA256 is the hex hash of the executed spec, for auditing and for correlating
	// the record with the local log.
	SpecSHA256 string `json:"spec_sha256,omitempty"`
	// AcceptedAtMS is when the privileged mode accepted the task.
	AcceptedAtMS int64 `json:"accepted_at_ms"`
}

type pair struct {
	authorizationID [32]byte
	taskID          string
}

// entry is one used record and the parsed authorization id of a non-local record.
type entry struct {
	rec Record
	id  [32]byte
}

// Options configures Open.
type Options struct {
	// Now returns the current time; nil means time.Now. Tests use it to exercise the
	// retention rules.
	Now func() time.Time
	// Logger receives warnings, such as a torn final record that was ignored; nil discards them.
	Logger *slog.Logger
	// ClockSkew is the privileged mode's clock_skew. A record with an authorization is kept
	// until its deadline plus max(1h, ClockSkew), so eviction never happens while the
	// authorization decision could still accept it.
	ClockSkew time.Duration
	// NoPersist keeps the used list in memory only: no file is read or written and the
	// directory is not created. Retention, the size cap, the watermark and duplicate
	// detection work as usual, but a restart forgets every record.
	NoPersist bool
}

// Store is the used state of the privileged mode. It is safe for concurrent use.
type Store struct {
	dir       string
	usedPath  string
	now       func() time.Time
	log       *slog.Logger
	skew      time.Duration
	noPersist bool

	mu     sync.Mutex
	used   *os.File
	exec   map[string]*list.Element
	pairs  map[pair]*list.Element
	order  *list.List // acceptance order, oldest first
	lines  int        // lines currently in the used file
	markMS int64      // used-list watermark, 0 = none
}

// Open loads the used list in dir, drops the records the retention rules no longer cover,
// applies the in-memory cap, rewrites the compacted file and opens it for appending. dir is
// created with mode 0700 when it does not exist. With Options.NoPersist the file is never
// touched and the list starts empty.
func Open(dir string, opts Options) (*Store, error) {
	if dir == "" {
		return nil, errors.New("state: empty directory")
	}
	s := &Store{
		dir:       dir,
		usedPath:  filepath.Join(dir, usedFileName),
		now:       opts.Now,
		log:       opts.Logger,
		skew:      opts.ClockSkew,
		noPersist: opts.NoPersist,
		exec:      make(map[string]*list.Element),
		pairs:     make(map[pair]*list.Element),
		order:     list.New(),
	}
	if s.now == nil {
		s.now = time.Now
	}
	if s.log == nil {
		s.log = slog.New(slog.DiscardHandler)
	}
	if s.noPersist {
		return s, nil
	}
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return nil, fmt.Errorf("state: create %s: %w", dir, err)
	}
	fi, err := os.Stat(dir)
	if err != nil {
		return nil, fmt.Errorf("state: %w", err)
	}
	if !fi.IsDir() {
		return nil, fmt.Errorf("state: %s is not a directory", dir)
	}
	if err := s.load(); err != nil {
		return nil, err
	}
	if err := s.compact(); err != nil {
		return nil, err
	}
	if s.used, err = openAppend(s.usedPath); err != nil {
		return nil, err
	}
	return s, nil
}

// load reads the used list, applies the retention rules and the size cap in acceptance order,
// and leaves the live records in memory. A line that cannot be parsed is a hard error:
// silently dropping it could forget a used authorization. The one exception is the final line
// of a file written without a trailing newline and not parseable: it is the torn remains of an
// append that never completed, so its task never ran and the record can be ignored and
// compacted away.
func (s *Store) load() error {
	now := s.now()
	if err := forEachLine(s.usedPath, func(line []byte, n int, torn bool) error {
		var rec Record
		if err := json.Unmarshal(line, &rec); err != nil {
			return s.tolerateTorn(s.usedPath, n, torn, err)
		}
		if rec.TaskID == "" {
			return s.tolerateTorn(s.usedPath, n, torn, errors.New("missing task_id"))
		}
		if !s.keep(rec, now) {
			return nil
		}
		var id [32]byte
		if rec.AuthorizationID != "" {
			var err error
			if id, err = parseID(rec.AuthorizationID); err != nil {
				return s.tolerateTorn(s.usedPath, n, torn, err)
			}
		}
		if _, dup := s.exec[rec.TaskID]; dup {
			return nil
		}
		// Mirror AddUsed: an eviction of a still acceptable authorization raises the
		// watermark before the new record goes in.
		s.makeRoom(now)
		s.add(&entry{rec: rec, id: id})
		return nil
	}); err != nil {
		return fmt.Errorf("state: %s: %w", s.usedPath, err)
	}
	return nil
}

// keep applies the retention rules: a record with an authorization and a deadline is kept
// until deadline+max(1h, clock_skew); a local approval (and a legacy record without a
// deadline) is kept 24h after it was accepted.
func (s *Store) keep(rec Record, now time.Time) bool {
	if rec.AuthorizationID != "" && rec.DeadlineMS != nil {
		return !now.After(time.UnixMilli(*rec.DeadlineMS).Add(s.retentionMargin()))
	}
	return !now.After(time.UnixMilli(rec.AcceptedAtMS).Add(localRetention))
}

// retentionMargin is max(1h, clock_skew).
func (s *Store) retentionMargin() time.Duration {
	if s.skew > minRetentionMargin {
		return s.skew
	}
	return minRetentionMargin
}

// compact rewrites the used file with the records that remain after loading. The file is
// replaced atomically and the directory is fsynced, so a crash cannot leave a half-written
// list behind.
func (s *Store) compact() error {
	var buf bytes.Buffer
	for elem := s.order.Front(); elem != nil; elem = elem.Next() {
		if err := writeLine(&buf, elem.Value.(*entry).rec); err != nil {
			return fmt.Errorf("state: encode used record: %w", err)
		}
	}
	if err := replaceFile(s.usedPath, buf.Bytes()); err != nil {
		return err
	}
	s.lines = s.order.Len()
	return nil
}

// Executed reports whether the task id already ran on this node.
func (s *Store) Executed(taskID string) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	_, ok := s.exec[taskID]
	return ok
}

// Used reports whether (authorization id, task id) is already in the used list.
func (s *Store) Used(authorizationID [32]byte, taskID string) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	_, ok := s.pairs[pair{authorizationID: authorizationID, taskID: taskID}]
	return ok
}

// Watermark returns the used-list watermark in Unix milliseconds, or 0 when no authorization
// was evicted while still acceptable.
func (s *Store) Watermark() int64 {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.markMS
}

// Watermarked reports whether an authorization issued at issuedAtMS predates the used-list
// watermark. Such an authorization was evicted from the in-memory list while still acceptable
// and must be signed again, or its used pair could be replayed.
func (s *Store) Watermarked(issuedAtMS int64) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.markMS > 0 && issuedAtMS <= s.markMS
}

// AddUsed records an accepted task and fsyncs the record before returning (unless the store
// is in memory only). The caller must not start the task before AddUsed succeeds
// (doc/design/privilege.md "Validation flow", step 9).
func (s *Store) AddUsed(rec Record) error {
	if rec.TaskID == "" {
		return errors.New("state: used record has no task id")
	}
	var id [32]byte
	if rec.AuthorizationID != "" {
		var err error
		if id, err = parseID(rec.AuthorizationID); err != nil {
			return fmt.Errorf("state: used record: %w", err)
		}
	}
	var data []byte
	if !s.noPersist {
		var err error
		if data, err = encodeLine(rec); err != nil {
			return fmt.Errorf("state: encode used record: %w", err)
		}
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	now := s.now()
	// Housekeeping first, exactly as at startup: expired records leave and the oldest
	// accepted records make room under the cap before the new record is appended.
	s.prune(now)
	if _, dup := s.exec[rec.TaskID]; dup {
		return fmt.Errorf("%w: %s", ErrAlreadyRecorded, rec.TaskID)
	}
	s.makeRoom(now)
	if !s.noPersist {
		if err := appendLine(s.used, data); err != nil {
			return err
		}
		s.lines++
	}
	s.add(&entry{rec: rec, id: id})
	if !s.noPersist && s.lines >= 2*max(s.order.Len(), rebuildFloor) {
		// The record is already durable. A rebuild that fails leaves the append-only file
		// intact and is retried after a later append, unless the file cannot be reopened.
		if err := s.rebuild(); err != nil {
			return err
		}
	}
	return nil
}

// add puts e in the maps and at the end of the acceptance order.
func (s *Store) add(e *entry) {
	elem := s.order.PushBack(e)
	s.exec[e.rec.TaskID] = elem
	if e.rec.AuthorizationID != "" {
		s.pairs[pair{authorizationID: e.id, taskID: e.rec.TaskID}] = elem
	}
}

// remove drops one list element and its lookups.
func (s *Store) remove(elem *list.Element) {
	e := elem.Value.(*entry)
	delete(s.exec, e.rec.TaskID)
	if e.rec.AuthorizationID != "" {
		delete(s.pairs, pair{authorizationID: e.id, taskID: e.rec.TaskID})
	}
	s.order.Remove(elem)
}

// prune drops the records the retention rules no longer cover. A dropped record does not
// raise the watermark: it is no longer acceptable anyway.
func (s *Store) prune(now time.Time) {
	for elem := s.order.Front(); elem != nil; {
		next := elem.Next()
		if !s.keep(elem.Value.(*entry).rec, now) {
			s.remove(elem)
		}
		elem = next
	}
}

// makeRoom evicts the oldest accepted records until one more fits under the cap. An evicted
// authorization that is still acceptable raises the watermark to its issued_at, so it cannot
// be reused after its used pair is forgotten. Local approvals never raise it, and an
// authorization past deadline+clock_skew is not acceptable any more, so it does not either.
func (s *Store) makeRoom(now time.Time) {
	for s.order.Len() >= maxRecords {
		front := s.order.Front()
		if front == nil {
			return
		}
		e := front.Value.(*entry)
		if e.rec.AuthorizationID != "" && e.rec.DeadlineMS != nil {
			deadline := time.UnixMilli(*e.rec.DeadlineMS)
			if !now.After(deadline.Add(s.skew)) && e.rec.IssuedAtMS > s.markMS {
				s.markMS = e.rec.IssuedAtMS
			}
		}
		s.remove(front)
	}
}

// rebuild rewrites the used file with the live records, in acceptance order, and reopens it
// for appending. A failed replacement leaves the append-only file valid, so it is only
// logged; the next append retries. A file that was replaced but cannot be reopened is a hard
// error: appending to the old, unlinked file would silently lose records.
func (s *Store) rebuild() error {
	var buf bytes.Buffer
	for elem := s.order.Front(); elem != nil; elem = elem.Next() {
		if err := writeLine(&buf, elem.Value.(*entry).rec); err != nil {
			return fmt.Errorf("state: encode used record: %w", err)
		}
	}
	if err := replaceFile(s.usedPath, buf.Bytes()); err != nil {
		s.log.Warn("compacting the used list failed; it will be retried", "err", err)
		return nil
	}
	file, err := openAppend(s.usedPath)
	if err != nil {
		if s.used != nil {
			_ = s.used.Close()
			s.used = nil
		}
		return err
	}
	if s.used != nil {
		_ = s.used.Close()
	}
	s.used = file
	s.lines = s.order.Len()
	return nil
}

// Close closes the underlying file.
func (s *Store) Close() error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.used == nil {
		return nil
	}
	err := s.used.Close()
	s.used = nil
	return err
}

func parseID(text string) ([32]byte, error) {
	var id [32]byte
	raw, err := hex.DecodeString(text)
	if err != nil || len(raw) != len(id) {
		return id, fmt.Errorf("authorization id %q is not 32 bytes of hex", text)
	}
	copy(id[:], raw)
	return id, nil
}

func encodeLine(v any) ([]byte, error) {
	data, err := json.Marshal(v)
	if err != nil {
		return nil, err
	}
	return append(data, '\n'), nil
}

func writeLine(buf *bytes.Buffer, v any) error {
	data, err := encodeLine(v)
	if err != nil {
		return err
	}
	_, err = buf.Write(data)
	return err
}

// maxLine bounds one line of a state file.
const maxLine = 1 << 20

// forEachLine calls fn for every non-empty line of path. A missing file has no lines. torn
// reports a line that ended without a trailing newline: only the file's final line can, and it
// is the remains of an append that was never fsync'd.
func forEachLine(path string, fn func(line []byte, n int, torn bool) error) error {
	f, err := os.Open(path)
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	if err != nil {
		return err
	}
	defer f.Close()
	reader := bufio.NewReaderSize(f, 64<<10)
	for n := 1; ; n++ {
		line, readErr := reader.ReadBytes('\n')
		if len(line) > maxLine {
			return fmt.Errorf("line %d: longer than %d bytes", n, maxLine)
		}
		torn := readErr == io.EOF
		if trimmed := bytes.TrimSpace(line); len(trimmed) > 0 {
			if err := fn(trimmed, n, torn); err != nil {
				return err
			}
		}
		if readErr != nil {
			if errors.Is(readErr, io.EOF) {
				return nil
			}
			return readErr
		}
	}
}

// tolerateTorn turns the parse error of a file's final, newline-less line into a warning: the
// append that produced it never returned, so the task it records never took effect, and
// compact rewrites the file without it. Any other malformed line stays an error.
func (s *Store) tolerateTorn(path string, n int, torn bool, err error) error {
	if !torn {
		return fmt.Errorf("line %d: %w", n, err)
	}
	s.log.Warn("ignoring a torn final state record", "file", path, "line", n, "err", err)
	return nil
}

// openAppend opens path for appending, creating it with mode 0600.
func openAppend(path string) (*os.File, error) {
	f, err := os.OpenFile(path, os.O_WRONLY|os.O_APPEND|os.O_CREATE, 0o600)
	if err != nil {
		return nil, fmt.Errorf("state: open %s: %w", path, err)
	}
	return f, nil
}

// appendLine writes data and fsyncs it. The write must be durable before the task starts,
// so it must not be buffered in userspace.
func appendLine(f *os.File, data []byte) error {
	if f == nil {
		return errors.New("state: store is closed")
	}
	if _, err := f.Write(data); err != nil {
		return fmt.Errorf("state: append: %w", err)
	}
	if err := f.Sync(); err != nil {
		return fmt.Errorf("state: sync: %w", err)
	}
	return nil
}

// replaceFile atomically replaces path with data and fsyncs the directory.
func replaceFile(path string, data []byte) error {
	tmp := path + ".tmp"
	f, err := os.OpenFile(tmp, os.O_WRONLY|os.O_CREATE|os.O_TRUNC, 0o600)
	if err != nil {
		return fmt.Errorf("state: write %s: %w", tmp, err)
	}
	if _, err := f.Write(data); err != nil {
		f.Close()
		os.Remove(tmp)
		return fmt.Errorf("state: write %s: %w", tmp, err)
	}
	if err := f.Sync(); err != nil {
		f.Close()
		os.Remove(tmp)
		return fmt.Errorf("state: sync %s: %w", tmp, err)
	}
	if err := f.Close(); err != nil {
		os.Remove(tmp)
		return fmt.Errorf("state: close %s: %w", tmp, err)
	}
	if err := os.Rename(tmp, path); err != nil {
		os.Remove(tmp)
		return fmt.Errorf("state: replace %s: %w", path, err)
	}
	return syncDir(filepath.Dir(path))
}

// syncDir fsyncs a directory so a rename is durable.
func syncDir(dir string) error {
	d, err := os.Open(dir)
	if err != nil {
		return fmt.Errorf("state: open %s: %w", dir, err)
	}
	defer d.Close()
	if err := d.Sync(); err != nil {
		return fmt.Errorf("state: sync %s: %w", dir, err)
	}
	return nil
}
