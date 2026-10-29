// Package state persists the privileged mode's used and revoked lists
// (doc/privilege.md 授权, 吊销, 时钟).
//
// Both lists are append-only JSON lines. A record is written and fsync'd before the task
// it describes starts, so a crash can lose neither the fact that an authorization was
// used nor a revocation. At startup the lists are loaded and compacted: used records are
// dropped once they are older than the authorization deadline plus seven days (or, for a
// task id without a deadline, once they are 30 days old), and expired revocations are
// dropped. Everything is kept in memory for the lookups the authorization decision does.
package state

import (
	"bufio"
	"bytes"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sync"
	"time"
)

const (
	usedFileName    = "used"
	revokedFileName = "revoked"
	// usedRetention is how long a used record is kept past the authorization's deadline.
	// The margin covers a clock that stepped back by up to seven days: without it, a
	// one-shot authorization could be used again after the clock recovers
	// (doc/privilege.md 时钟).
	usedRetention = 7 * 24 * time.Hour
	// taskRetention bounds a used record without a deadline: such a task id is remembered
	// for 30 days. crhs never resends an accepted task, so this list is a defence in depth
	// against a restarting daemon rather than the only replay protection; the bound keeps
	// the file from growing without limit.
	taskRetention = 30 * 24 * time.Hour
)

// ErrAlreadyRecorded reports that a task id is already in the used list.
var ErrAlreadyRecorded = errors.New("state: task is already recorded")

// Record is one line of the used list: a task that ran, the authorization that allowed it
// (absent for a local approval) and the authorization's deadline.
type Record struct {
	TaskID  string `json:"task_id"`
	Attempt uint64 `json:"attempt,omitempty"`
	// AuthorizationID is the hex authorization id; empty when the task was approved
	// locally instead.
	AuthorizationID string `json:"authorization_id,omitempty"`
	// DeadlineMS is the authorization's deadline in Unix milliseconds; nil means the
	// authorization has no deadline.
	DeadlineMS *int64 `json:"deadline_ms,omitempty"`
	// SpecSHA256 is the hex hash of the executed spec, for auditing and for correlating
	// the record with the local log.
	SpecSHA256 string `json:"spec_sha256,omitempty"`
	// AcceptedAtMS is when the privileged mode accepted the task.
	AcceptedAtMS int64 `json:"accepted_at_ms"`
}

type revocationRecord struct {
	AuthorizationID string `json:"authorization_id"`
	DeadlineMS      *int64 `json:"deadline_ms,omitempty"`
	AddedAtMS       int64  `json:"added_at_ms"`
}

type pair struct {
	authorizationID [32]byte
	taskID          string
}

// Options configures Open.
type Options struct {
	// Now returns the current time; nil means time.Now. Tests use it to exercise the
	// retention rules.
	Now func() time.Time
}

// Store is the persistent used and revoked state of the privileged mode. It is safe for
// concurrent use.
type Store struct {
	dir         string
	usedPath    string
	revokedPath string
	now         func() time.Time

	mu          sync.Mutex
	usedFile    *os.File
	revokedFile *os.File
	executed    map[string]Record
	pairs       map[pair]struct{}
	revoked     map[[32]byte]*int64
}

// Open loads the lists in dir, drops records the retention rules no longer cover, rewrites
// the compacted files and opens them for appending. dir is created with mode 0700 when it
// does not exist.
func Open(dir string, opts Options) (*Store, error) {
	if dir == "" {
		return nil, errors.New("state: empty directory")
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
	s := &Store{
		dir:         dir,
		usedPath:    filepath.Join(dir, usedFileName),
		revokedPath: filepath.Join(dir, revokedFileName),
		now:         opts.Now,
	}
	if s.now == nil {
		s.now = time.Now
	}
	if err := s.load(); err != nil {
		return nil, err
	}
	if err := s.compact(); err != nil {
		return nil, err
	}
	if s.usedFile, err = openAppend(s.usedPath); err != nil {
		return nil, err
	}
	if s.revokedFile, err = openAppend(s.revokedPath); err != nil {
		s.usedFile.Close()
		return nil, err
	}
	return s, nil
}

// load reads both lists and applies the retention rules. A line that cannot be parsed is a
// hard error: silently dropping it could forget a used authorization or a revocation.
func (s *Store) load() error {
	s.executed = make(map[string]Record)
	s.pairs = make(map[pair]struct{})
	s.revoked = make(map[[32]byte]*int64)
	now := s.now()

	if err := forEachLine(s.usedPath, func(line []byte, n int) error {
		var rec Record
		if err := json.Unmarshal(line, &rec); err != nil {
			return fmt.Errorf("line %d: %w", n, err)
		}
		if rec.TaskID == "" {
			return fmt.Errorf("line %d: missing task_id", n)
		}
		if !keepUsed(rec, now) {
			return nil
		}
		if _, dup := s.executed[rec.TaskID]; dup {
			return nil
		}
		s.executed[rec.TaskID] = rec
		if rec.AuthorizationID == "" {
			return nil
		}
		id, err := parseID(rec.AuthorizationID)
		if err != nil {
			return fmt.Errorf("line %d: %w", n, err)
		}
		s.pairs[pair{authorizationID: id, taskID: rec.TaskID}] = struct{}{}
		return nil
	}); err != nil {
		return fmt.Errorf("state: %s: %w", s.usedPath, err)
	}

	if err := forEachLine(s.revokedPath, func(line []byte, n int) error {
		var rec revocationRecord
		if err := json.Unmarshal(line, &rec); err != nil {
			return fmt.Errorf("line %d: %w", n, err)
		}
		id, err := parseID(rec.AuthorizationID)
		if err != nil {
			return fmt.Errorf("line %d: %w", n, err)
		}
		if rec.DeadlineMS != nil && now.After(time.UnixMilli(*rec.DeadlineMS)) {
			return nil // the authorization the revocation belonged to has expired
		}
		if existing, ok := s.revoked[id]; ok {
			s.revoked[id] = strongerDeadline(existing, rec.DeadlineMS)
		} else {
			s.revoked[id] = rec.DeadlineMS
		}
		return nil
	}); err != nil {
		return fmt.Errorf("state: %s: %w", s.revokedPath, err)
	}
	return nil
}

// keepUsed applies the retention rules of the used list.
func keepUsed(rec Record, now time.Time) bool {
	if rec.DeadlineMS != nil {
		deadline := time.UnixMilli(*rec.DeadlineMS)
		return !now.After(deadline.Add(usedRetention))
	}
	return !now.After(time.UnixMilli(rec.AcceptedAtMS).Add(taskRetention))
}

// compact rewrites both lists with the records that remain after loading. The files are
// replaced atomically and the directory is fsynced, so a crash cannot leave a half-written
// list behind.
func (s *Store) compact() error {
	var used bytes.Buffer
	for _, rec := range s.executed {
		if err := writeLine(&used, rec); err != nil {
			return fmt.Errorf("state: encode used record: %w", err)
		}
	}
	var revoked bytes.Buffer
	for id, deadline := range s.revoked {
		rec := revocationRecord{AuthorizationID: hex.EncodeToString(id[:]), DeadlineMS: deadline}
		if err := writeLine(&revoked, rec); err != nil {
			return fmt.Errorf("state: encode revocation: %w", err)
		}
	}
	if err := replaceFile(s.usedPath, used.Bytes()); err != nil {
		return err
	}
	return replaceFile(s.revokedPath, revoked.Bytes())
}

// Executed reports whether the task id already ran on this node.
func (s *Store) Executed(taskID string) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	_, ok := s.executed[taskID]
	return ok
}

// Used reports whether (authorization id, task id) is already in the used list.
func (s *Store) Used(authorizationID [32]byte, taskID string) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	_, ok := s.pairs[pair{authorizationID: authorizationID, taskID: taskID}]
	return ok
}

// Revoked reports whether the authorization id is revoked.
func (s *Store) Revoked(authorizationID [32]byte) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	_, ok := s.revoked[authorizationID]
	return ok
}

// AddUsed records an accepted task and fsyncs the record before returning. The caller must
// not start the task before AddUsed succeeds (doc/privilege.md 校验流程, step 10).
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
	data, err := encodeLine(rec)
	if err != nil {
		return fmt.Errorf("state: encode used record: %w", err)
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if _, dup := s.executed[rec.TaskID]; dup {
		return fmt.Errorf("%w: %s", ErrAlreadyRecorded, rec.TaskID)
	}
	if err := appendLine(s.usedFile, data); err != nil {
		return err
	}
	s.executed[rec.TaskID] = rec
	if rec.AuthorizationID != "" {
		s.pairs[pair{authorizationID: id, taskID: rec.TaskID}] = struct{}{}
	}
	return nil
}

// AddRevoked appends a revocation and fsyncs it. Adding the same authorization id again
// is idempotent; a revocation without a deadline is stronger than one with a deadline and
// replaces it.
func (s *Store) AddRevoked(authorizationID [32]byte, deadlineMS *int64) error {
	rec := revocationRecord{
		AuthorizationID: hex.EncodeToString(authorizationID[:]),
		DeadlineMS:      deadlineMS,
		AddedAtMS:       s.now().UnixMilli(),
	}
	data, err := encodeLine(rec)
	if err != nil {
		return fmt.Errorf("state: encode revocation: %w", err)
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	existing, ok := s.revoked[authorizationID]
	merged := deadlineMS
	if ok {
		merged = strongerDeadline(existing, deadlineMS)
		if existing == nil || (merged != nil && *merged == *existing) {
			return nil // already revoked at least as strongly
		}
	}
	if err := appendLine(s.revokedFile, data); err != nil {
		return err
	}
	s.revoked[authorizationID] = merged
	return nil
}

// strongerDeadline returns the stricter of two revocation deadlines: no deadline is forever
// and beats any deadline, and a later deadline beats an earlier one. Two revocations of one
// authorization must not make it usable again by ending earlier than either asked for.
func strongerDeadline(a, b *int64) *int64 {
	switch {
	case a == nil || b == nil:
		return nil
	case *b > *a:
		return b
	default:
		return a
	}
}

// Close closes the underlying files.
func (s *Store) Close() error {
	s.mu.Lock()
	defer s.mu.Unlock()
	var first error
	if s.usedFile != nil {
		first = s.usedFile.Close()
		s.usedFile = nil
	}
	if s.revokedFile != nil {
		if err := s.revokedFile.Close(); err != nil && first == nil {
			first = err
		}
		s.revokedFile = nil
	}
	return first
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

// forEachLine calls fn for every non-empty line of path. A missing file has no lines.
func forEachLine(path string, fn func(line []byte, n int) error) error {
	f, err := os.Open(path)
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	if err != nil {
		return err
	}
	defer f.Close()
	scanner := bufio.NewScanner(f)
	scanner.Buffer(make([]byte, 0, 64<<10), 1<<20)
	for n := 1; scanner.Scan(); n++ {
		line := bytes.TrimSpace(scanner.Bytes())
		if len(line) == 0 {
			continue
		}
		if err := fn(line, n); err != nil {
			return err
		}
	}
	return scanner.Err()
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
