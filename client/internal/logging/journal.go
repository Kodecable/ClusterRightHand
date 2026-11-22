package logging

import (
	"os"
	"strconv"
	"strings"
)

// journalStreamEnv is the variable systemd sets for a unit's process when the journal collects its
// output, as "<dev>:<ino>" of that stream.
const journalStreamEnv = "JOURNAL_STREAM"

// FdStat is the device and inode of an open file, the two numbers journald puts in
// JOURNAL_STREAM.
type FdStat struct {
	Dev uint64
	Ino uint64
}

// JournalStream reports whether fd is the systemd journal's stream, using systemd's documented
// rule: JOURNAL_STREAM is "<dev>:<ino>" and both equal the device and inode of fd. A variable that
// is missing, malformed, or of another stream means no. A child whose stderr is a pipe inherits
// JOURNAL_STREAM but fails the comparison, which is correct.
func JournalStream(fd int) bool {
	return journalStream(os.Getenv(journalStreamEnv), fd, fdStat)
}

// journalStream is JournalStream with the environment value and the stat injected, so tests can
// exercise the rule without a journal.
func journalStream(env string, fd int, stat func(int) (FdStat, error)) bool {
	devText, inoText, ok := strings.Cut(env, ":")
	if !ok || devText == "" || inoText == "" {
		return false
	}
	dev, err := strconv.ParseUint(devText, 10, 64)
	if err != nil {
		return false
	}
	ino, err := strconv.ParseUint(inoText, 10, 64)
	if err != nil {
		return false
	}
	got, err := stat(fd)
	if err != nil {
		return false
	}
	return got.Dev == dev && got.Ino == ino
}
