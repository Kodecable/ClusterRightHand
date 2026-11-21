package upgrade

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os/exec"
)

// System is what the installer runs: systemctl and journalctl, directly and never through a shell.
// Tests replace it.
type System interface {
	// Run runs a program to completion and returns its combined output.
	Run(ctx context.Context, name string, args ...string) ([]byte, error)
	// Follow runs journalctl with args and hands each line to match until match returns true. It
	// returns nil on a match, ctx's error when ctx ends first, and an error when journalctl exits first.
	Follow(ctx context.Context, args []string, match func(line []byte) bool) error
}

// ExecSystem is the real system.
type ExecSystem struct{}

func (ExecSystem) Run(ctx context.Context, name string, args ...string) ([]byte, error) {
	return ExecRunner(ctx, name, args...)
}

func (ExecSystem) Follow(ctx context.Context, args []string, match func(line []byte) bool) error {
	run, cancel := context.WithCancel(ctx)
	defer cancel()
	cmd := exec.CommandContext(run, "journalctl", args...)
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return err
	}
	if err := cmd.Start(); err != nil {
		return fmt.Errorf("journalctl: %w", err)
	}
	scanner := bufio.NewScanner(stdout)
	scanner.Buffer(make([]byte, 64*1024), 4*1024*1024)
	matched := false
	for scanner.Scan() {
		if match(scanner.Bytes()) {
			matched = true
			break
		}
	}
	cancel()
	_ = cmd.Wait()
	switch {
	case matched:
		return nil
	case ctx.Err() != nil:
		return ctx.Err()
	default:
		return errors.New("journalctl ended before the line appeared")
	}
}

// journalMessage returns MESSAGE of one `journalctl -o json` line. journald writes a message that is
// not valid UTF-8 as an array of bytes.
func journalMessage(line []byte) string {
	var record struct {
		Message json.RawMessage `json:"MESSAGE"`
	}
	if json.Unmarshal(line, &record) != nil || len(record.Message) == 0 {
		return ""
	}
	var text string
	if json.Unmarshal(record.Message, &text) == nil {
		return text
	}
	var raw []byte
	var numbers []int
	if json.Unmarshal(record.Message, &numbers) == nil {
		for _, n := range numbers {
			raw = append(raw, byte(n))
		}
	}
	return string(raw)
}
