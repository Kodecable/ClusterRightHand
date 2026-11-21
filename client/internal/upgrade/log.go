package upgrade

import (
	"bufio"
	"bytes"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"time"
)

// MaxLogLines bounds the upgrade log; each write drops the oldest lines past it.
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
	lines, _ := readLines(l.Path)
	lines = append(lines, line)
	if len(lines) > MaxLogLines {
		lines = lines[len(lines)-MaxLogLines:]
	}
	tmp := l.Path + ".tmp"
	_ = os.Remove(tmp)
	if err := os.WriteFile(tmp, append(bytes.Join(lines, []byte("\n")), '\n'), 0o644); err != nil {
		return fmt.Errorf("write the upgrade log: %w", err)
	}
	if err := os.Rename(tmp, l.Path); err != nil {
		return fmt.Errorf("write the upgrade log: %w", err)
	}
	return nil
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
