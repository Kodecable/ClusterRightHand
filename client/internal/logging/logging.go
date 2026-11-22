// Package logging writes crha's log records in one human-readable format.
//
// Two modes share the same text. On a terminal or in a file a record starts with the local time, a
// fixed-width level word and the message:
//
//	2026-11-23 10:04:05.123 INFO  crha starting server=https://crhs.example.com
//
// When stderr is the systemd journal's stream, journald stamps the time and the level, so the record
// carries neither: it starts with the sd-daemon priority prefix (`<6>` for INFO) and the message:
//
//	<6>crha starting server=https://crhs.example.com
//
// Attributes follow the message as key=value. A value is quoted, in Go syntax, when it contains a
// space, '=', '"', a backslash or a control character; a newline therefore becomes `\n` and a record
// is always one line. The literal keys `time=`, `level=` and `msg=` never mark a record: both
// formats put the time, the level and the message where the format says, never as attributes.
//
// An attribute whose value is a json.RawMessage is written verbatim after key= when it is valid
// JSON, with the whitespace compacted away, so a task's full specification stays readable:
//
//	2026-11-23 10:04:05.123 INFO  native helper task.start task_id=t1 spec={"kind":"exec","argv":["ls","-la"]}
//
// A JSON value is self-delimiting, so the record stays parseable. A value that is not valid JSON, or
// that still contains a line break after compaction, is written as a quoted Go string instead.
//
// Messages are text, not attributes: every control character in a message is escaped too (`\t`,
// `\x1b`, `\u0085`), so terminal escape sequences and other controls never reach the terminal or the
// journal as themselves. Ordinary text, including non-ASCII, is unchanged.
package logging

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"os"
	"strconv"
	"strings"
	"sync"
	"time"
	"unicode"
	"unicode/utf8"
)

// DefaultLevel is the level below which a logger made here drops records, like slog's TextHandler.
const DefaultLevel = slog.LevelInfo

// plainTimeFormat is local time with millisecond precision.
const plainTimeFormat = "2006-01-02 15:04:05.000"

// levelWidth is the width the level word is padded to, so messages line up.
const levelWidth = 5

// New returns a logger writing human-readable lines to w. It uses the journal format when w is the
// process's stderr and file descriptor 2 is the journal's stream (see JournalStream); otherwise it
// uses the plain format.
func New(w io.Writer) *slog.Logger {
	return slog.New(newHandler(w, isJournalWriter(w), DefaultLevel))
}

// NewPlain returns a logger in the terminal/file format, whatever w is.
func NewPlain(w io.Writer) *slog.Logger {
	return slog.New(newHandler(w, false, DefaultLevel))
}

// NewJournal returns a logger in journald's format, whatever w is.
func NewJournal(w io.Writer) *slog.Logger {
	return slog.New(newHandler(w, true, DefaultLevel))
}

// isJournalWriter reports whether w is the process's stderr and stderr is the journal's stream. A
// copy of the file descriptor or a pipe to the journal is not the journal: journald sets
// JOURNAL_STREAM for a process whose stderr it collects, and a child that gets a pipe inherits the
// variable while its own fd 2 no longer matches.
func isJournalWriter(w io.Writer) bool {
	return w == os.Stderr && JournalStream(int(os.Stderr.Fd()))
}

// PrintError writes one line at error priority. It is for a process's final failure message, not a
// regular record: even on a terminal the line keeps its bare human text (`crha: <error>`, no
// timestamp and no level word). When w is the journal's stream the line carries journald's error
// priority prefix, `<3>`.
func PrintError(w io.Writer, message string) {
	writeError(w, isJournalWriter(w), message)
}

// writeError is PrintError with the format decided by the caller, so tests can exercise both.
func writeError(w io.Writer, journal bool, message string) {
	var buf []byte
	if journal {
		buf = append(buf, "<3>"...)
	}
	buf = appendMessage(buf, message)
	buf = append(buf, '\n')
	_, _ = w.Write(buf)
}

// handler is one slog.Handler in one of the two formats. It builds a whole record in memory and
// writes it with a single Write, so records from concurrent goroutines never interleave.
type handler struct {
	// mu is shared by every handler derived with WithAttrs or WithGroup.
	mu      *sync.Mutex
	w       io.Writer
	journal bool
	level   slog.Level
	// pre holds WithAttrs attributes, already qualified with the groups in effect there. Each
	// element is one rendered key=value chunk.
	pre []string
	// groups is the group path added by WithGroup, which qualifies record attributes.
	groups []string
}

func newHandler(w io.Writer, journal bool, level slog.Level) *handler {
	return &handler{mu: new(sync.Mutex), w: w, journal: journal, level: level}
}

// Enabled implements slog.Handler.
func (h *handler) Enabled(_ context.Context, level slog.Level) bool {
	return level >= h.level
}

// WithAttrs implements slog.Handler. It renders the attributes now, under the groups in effect, so
// a later WithGroup does not requalify them.
func (h *handler) WithAttrs(attrs []slog.Attr) slog.Handler {
	if len(attrs) == 0 {
		return h
	}
	out := h.clone()
	out.pre = make([]string, len(h.pre), len(h.pre)+len(attrs))
	copy(out.pre, h.pre)
	for _, a := range attrs {
		out.pre = appendAttr(out.pre, h.groups, a)
	}
	return out
}

// WithGroup implements slog.Handler. An empty name is ignored, as in slog's own handlers.
func (h *handler) WithGroup(name string) slog.Handler {
	if name == "" {
		return h
	}
	out := h.clone()
	out.groups = appendGroup(h.groups, name)
	return out
}

func (h *handler) clone() *handler {
	out := *h
	return &out
}

// Handle implements slog.Handler.
func (h *handler) Handle(_ context.Context, r slog.Record) error {
	var buf []byte
	if h.journal {
		buf = appendPriority(buf, r.Level)
	} else {
		buf = append(buf, r.Time.Format(plainTimeFormat)...)
		buf = append(buf, ' ')
		word := levelWord(r.Level)
		buf = append(buf, word...)
		for i := len(word); i < levelWidth; i++ {
			buf = append(buf, ' ')
		}
		buf = append(buf, ' ')
	}
	buf = appendMessage(buf, r.Message)
	for _, a := range h.pre {
		buf = append(buf, ' ')
		buf = append(buf, a...)
	}
	var attrs []string
	r.Attrs(func(a slog.Attr) bool {
		attrs = appendAttr(attrs, h.groups, a)
		return true
	})
	for _, a := range attrs {
		buf = append(buf, ' ')
		buf = append(buf, a...)
	}
	buf = append(buf, '\n')
	h.mu.Lock()
	defer h.mu.Unlock()
	_, err := h.w.Write(buf)
	return err
}

// appendAttr appends a's rendered key=value chunks to dst. A group expands into its members,
// qualified by the group's key; a group attribute with an empty key is inlined, as slog defines.
func appendAttr(dst []string, groups []string, a slog.Attr) []string {
	a.Value = a.Value.Resolve()
	if a.Value.Kind() == slog.KindGroup {
		members := a.Value.Group()
		if len(members) == 0 {
			return dst
		}
		inner := groups
		if a.Key != "" {
			inner = appendGroup(groups, a.Key)
		}
		for _, member := range members {
			dst = appendAttr(dst, inner, member)
		}
		return dst
	}
	if a.Key == "" {
		return dst
	}
	var b []byte
	b = appendText(b, qualify(groups, a.Key))
	b = append(b, '=')
	b = appendValue(b, a.Value)
	return append(dst, string(b))
}

func qualify(groups []string, key string) string {
	if len(groups) == 0 {
		return key
	}
	return strings.Join(groups, ".") + "." + key
}

// appendGroup returns groups plus name without aliasing groups' backing array.
func appendGroup(groups []string, name string) []string {
	out := make([]string, len(groups)+1)
	copy(out, groups)
	out[len(groups)] = name
	return out
}

// appendValue renders a non-group value. Strings are quoted only when they need it; numbers and
// booleans are bare; a json.RawMessage is valid JSON written as it is.
func appendValue(buf []byte, v slog.Value) []byte {
	if v.Kind() == slog.KindAny {
		if raw, ok := v.Any().(json.RawMessage); ok {
			return appendRawJSON(buf, raw)
		}
	}
	switch v.Kind() {
	case slog.KindString:
		return appendText(buf, v.String())
	case slog.KindInt64:
		return strconv.AppendInt(buf, v.Int64(), 10)
	case slog.KindUint64:
		return strconv.AppendUint(buf, v.Uint64(), 10)
	case slog.KindFloat64:
		return strconv.AppendFloat(buf, v.Float64(), 'g', -1, 64)
	case slog.KindBool:
		return strconv.AppendBool(buf, v.Bool())
	case slog.KindDuration:
		return appendText(buf, v.Duration().String())
	case slog.KindTime:
		return appendText(buf, v.Time().Format(time.RFC3339Nano))
	default:
		return appendText(buf, fmt.Sprint(v.Any()))
	}
}

// appendRawJSON appends raw as a JSON value when it is valid, single-line JSON, and as a quoted Go
// string otherwise. Compacting first drops the whitespace between tokens, and valid JSON cannot
// contain a raw line break, but a check keeps the one-record-per-line rule unconditional. The value
// needs no quoting: a JSON object or array delimits itself, and the next ` key=` after it is outside
// the value.
func appendRawJSON(buf []byte, raw json.RawMessage) []byte {
	var compact bytes.Buffer
	if err := json.Compact(&compact, raw); err != nil {
		return strconv.AppendQuote(buf, string(raw))
	}
	data := compact.Bytes()
	if bytes.IndexByte(data, '\n') >= 0 || bytes.IndexByte(data, '\r') >= 0 {
		return strconv.AppendQuote(buf, string(raw))
	}
	return append(buf, data...)
}

// appendText appends s, quoted in Go syntax when it would otherwise break the line's shape or
// its key=value form.
func appendText(buf []byte, s string) []byte {
	if !needsQuoting(s) {
		return append(buf, s...)
	}
	return strconv.AppendQuote(buf, s)
}

// needsQuoting reports whether s has a character that forces quoting: a separator, a quote that
// the Go syntax must escape, or a control character (a newline would end the record).
func needsQuoting(s string) bool {
	for _, r := range s {
		if r == ' ' || r == '=' || r == '"' || r == '\\' || unicode.IsControl(r) {
			return true
		}
	}
	return false
}

// appendMessage appends the message. It is human text, so it is not quoted, but every control
// character is escaped: a line break would end the record, and an escape sequence (ESC) would reach
// the terminal or the journal as itself. Ordinary text, non-ASCII included, is unchanged.
func appendMessage(buf []byte, message string) []byte {
	for i := 0; i < len(message); {
		r, size := utf8.DecodeRuneInString(message[i:])
		if r == utf8.RuneError && size == 1 {
			// An invalid byte is not a control character; keep it rather than rewrite the text.
			buf = append(buf, message[i])
			i++
			continue
		}
		i += size
		switch r {
		case '\n':
			buf = append(buf, '\\', 'n')
		case '\r':
			buf = append(buf, '\\', 'r')
		case '\t':
			buf = append(buf, '\\', 't')
		default:
			if unicode.IsControl(r) {
				buf = appendControlEscape(buf, r)
			} else {
				buf = utf8.AppendRune(buf, r)
			}
		}
	}
	return buf
}

// appendControlEscape appends r as a Go escape: \xNN for a C0 control or DEL, \uNNNN for a C1
// control, whose UTF-8 bytes the \x form would not represent.
func appendControlEscape(buf []byte, r rune) []byte {
	if r < 0x80 {
		return append(buf, fmt.Sprintf("\\x%02x", r)...)
	}
	return append(buf, fmt.Sprintf("\\u%04x", r)...)
}

// appendPriority appends journald's sd-daemon priority prefix for level.
func appendPriority(buf []byte, level slog.Level) []byte {
	buf = append(buf, '<')
	buf = strconv.AppendInt(buf, int64(priority(level)), 10)
	return append(buf, '>')
}

// priority maps a level onto a syslog priority, as journald expects from sd-daemon's `<N>` prefix.
func priority(level slog.Level) int {
	switch {
	case level < slog.LevelInfo:
		return 7 // debug
	case level < slog.LevelWarn:
		return 6 // info
	case level < slog.LevelError:
		return 4 // warning
	default:
		return 3 // error
	}
}

// levelWord is the plain format's level name; Handle pads it to levelWidth.
func levelWord(level slog.Level) string {
	switch {
	case level < slog.LevelInfo:
		return "DEBUG"
	case level < slog.LevelWarn:
		return "INFO"
	case level < slog.LevelError:
		return "WARN"
	default:
		return "ERROR"
	}
}
