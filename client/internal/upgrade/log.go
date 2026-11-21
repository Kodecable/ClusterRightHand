package upgrade

import (
	"bufio"
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"time"

	"github.com/Kodecable/ClusterRightHand/client/internal/fsutil"
)

// MaxLogLines bounds the upgrade log; each write drops the oldest lines past it, but not the lines of a
// backup that still exists.
const MaxLogLines = 128

// Outcomes end an upgrade in the log.
const (
	OutcomeActivated  = "activated"
	OutcomeRolledBack = "rolled_back"
	OutcomeFailed     = "failed"
)

// Entry is one line of the upgrade log (doc/design/distribution.md "Upgrade log").
type Entry struct {
	TS        string `json:"ts"`
	UpgradeID string `json:"upgrade_id"`
	From      string `json:"from"`
	To        string `json:"to"`
	Level     string `json:"level"`
	Step      string `json:"step"`
	Msg       string `json:"msg"`
	// Manifest is the backup manifest, on the line that records the backup.
	Manifest string `json:"manifest,omitempty"`
}

// Log appends to the upgrade log. Only a process that holds the install lock writes it (the installer,
// or a rollback by hand), since each write rewrites the whole file; the write replaces the file by a
// rename in a directory only root can write, so readers always see a whole file.
type Log struct {
	Path      string
	UpgradeID string
	From, To  string
	// Now is the clock (tests).
	Now func() time.Time
}

// Write appends one entry, trimming the log to MaxLogLines.
func (l *Log) Write(level, step, msg string) error {
	return l.write(Entry{Level: level, Step: step, Msg: msg})
}

// WriteManifest records where this upgrade's backup manifest is.
func (l *Log) WriteManifest(manifest string) error {
	return l.write(Entry{Level: "info", Step: "backed_up", Msg: "backed up the files the upgrade replaces", Manifest: manifest})
}

func (l *Log) write(e Entry) error {
	now := time.Now
	if l.Now != nil {
		now = l.Now
	}
	e.TS = now().UTC().Format(time.RFC3339Nano)
	e.UpgradeID, e.From, e.To = l.UpgradeID, l.From, l.To
	line, err := json.Marshal(e)
	if err != nil {
		return err
	}
	// A log that cannot be read is not replaced: losing this line is better than the lines a rollback
	// needs.
	lines, err := readLines(l.Path)
	if err != nil && !errors.Is(err, os.ErrNotExist) {
		return fmt.Errorf("read the upgrade log: %w", err)
	}
	lines = trimLog(append(lines, line), manifestExists)
	if err := fsutil.WriteFile(l.Path, append(bytes.Join(lines, []byte("\n")), '\n'), 0o644, fsutil.WriteOptions{}); err != nil {
		return fmt.Errorf("write the upgrade log: %w", err)
	}
	return nil
}

func manifestExists(path string) bool {
	_, err := os.Stat(path)
	return err == nil
}

// trimLog drops the oldest lines past MaxLogLines, but never the lines of an upgrade whose backup still
// exists, nor the line just written: those alone may take the log past MaxLogLines. Which backups
// exist is the installer's prune decision (it keeps the backup a rollback by hand needs), so the log
// keeps what a rollback can still use, however many attempts failed since, and no more than the backups
// kept.
func trimLog(lines [][]byte, backedUp func(manifest string) bool) [][]byte {
	if len(lines) <= MaxLogLines {
		return lines
	}
	ids := make([]string, len(lines))
	needed := map[string]bool{}
	for i, line := range lines {
		var e Entry
		if json.Unmarshal(line, &e) == nil {
			ids[i] = e.UpgradeID
			if e.Manifest != "" && backedUp(e.Manifest) {
				needed[e.UpgradeID] = true
			}
		}
	}
	last := len(lines) - 1
	drop := len(lines) - MaxLogLines
	out := make([][]byte, 0, MaxLogLines)
	for i, line := range lines {
		if drop > 0 && i != last && !needed[ids[i]] {
			drop--
			continue
		}
		out = append(out, line)
	}
	// The lines a rollback can still use are bounded by the backups kept, so the log stays small.
	return out
}

func readLines(path string) ([][]byte, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	var lines [][]byte
	scanner := bufio.NewScanner(bytes.NewReader(data))
	scanner.Buffer(make([]byte, 64*1024), 1024*1024)
	for scanner.Scan() {
		if line := bytes.TrimSpace(scanner.Bytes()); len(line) > 0 {
			lines = append(lines, append([]byte(nil), line...))
		}
	}
	return lines, scanner.Err()
}

// ReadLog returns the entries of the upgrade log; a line that is not an entry is skipped.
func ReadLog(dir string) ([]Entry, error) {
	lines, err := readLines(filepath.Join(dir, LogName))
	if err != nil {
		return nil, err
	}
	entries := make([]Entry, 0, len(lines))
	for _, line := range lines {
		var e Entry
		if json.Unmarshal(line, &e) == nil {
			entries = append(entries, e)
		}
	}
	return entries, nil
}
