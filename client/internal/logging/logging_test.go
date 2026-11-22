package logging

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"strings"
	"sync"
	"testing"
	"time"
	"unicode"
)

// fixedTime is a local time with milliseconds, the precision the plain format prints.
var fixedTime = time.Date(2026, 11, 23, 10, 4, 5, 123_456_789, time.Local)

// handle writes one record with a fixed time through h.
func handle(t *testing.T, h slog.Handler, level slog.Level, message string, attrs ...slog.Attr) {
	t.Helper()
	r := slog.NewRecord(fixedTime, level, message, 0)
	r.AddAttrs(attrs...)
	if err := h.Handle(context.Background(), r); err != nil {
		t.Fatalf("Handle: %v", err)
	}
}

func TestPlainFormat(t *testing.T) {
	var buf bytes.Buffer
	handle(t, newHandler(&buf, false, slog.LevelDebug), slog.LevelInfo, "crha starting",
		slog.String("server", "https://crhs.example.com"), slog.Int("attempt", 2))
	want := "2026-11-23 10:04:05.123 INFO  crha starting server=https://crhs.example.com attempt=2\n"
	if got := buf.String(); got != want {
		t.Fatalf("plain record = %q, want %q", got, want)
	}
	for _, reserved := range []string{"time=", "level=", "msg="} {
		if strings.Contains(buf.String(), reserved) {
			t.Fatalf("plain record contains %q: %q", reserved, buf.String())
		}
	}
}

func TestPlainLevelWordsArePadded(t *testing.T) {
	tests := []struct {
		level slog.Level
		want  string
	}{
		{slog.LevelDebug, "2026-11-23 10:04:05.123 DEBUG message\n"},
		{slog.LevelInfo, "2026-11-23 10:04:05.123 INFO  message\n"},
		{slog.LevelWarn, "2026-11-23 10:04:05.123 WARN  message\n"},
		{slog.LevelError, "2026-11-23 10:04:05.123 ERROR message\n"},
	}
	for _, tt := range tests {
		var buf bytes.Buffer
		handle(t, newHandler(&buf, false, slog.LevelDebug), tt.level, "message")
		if got := buf.String(); got != tt.want {
			t.Errorf("level %v record = %q, want %q", tt.level, got, tt.want)
		}
	}
}

func TestPlainAttributeQuoting(t *testing.T) {
	var buf bytes.Buffer
	at := time.Date(2026, 11, 23, 2, 4, 5, 0, time.UTC)
	handle(t, newHandler(&buf, false, slog.LevelDebug), slog.LevelInfo, "message",
		slog.String("plain", "value"),
		slog.String("space", "two words"),
		slog.String("eq", "a=b"),
		slog.String("quote", `a"b`),
		slog.String("newline", "a\nb"),
		slog.String("tab", "a\tb"),
		slog.String("backslash", `a\b`),
		slog.String("unicode", "héllo"),
		slog.Int("int", -3),
		slog.Bool("bool", true),
		slog.Duration("duration", 1500*time.Millisecond),
		slog.Time("at", at),
	)
	want := `2026-11-23 10:04:05.123 INFO  message plain=value space="two words" eq="a=b" ` +
		`quote="a\"b" newline="a\nb" tab="a\tb" backslash="a\\b" unicode=héllo int=-3 bool=true ` +
		`duration=1.5s at=2026-11-23T02:04:05Z` + "\n"
	if got := buf.String(); got != want {
		t.Fatalf("record = %q\nwant     %q", got, want)
	}
	if n := strings.Count(buf.String(), "\n"); n != 1 {
		t.Fatalf("record has %d newlines, want 1: %q", n, buf.String())
	}
}

func TestMessageStaysOneLine(t *testing.T) {
	var buf bytes.Buffer
	handle(t, newHandler(&buf, false, slog.LevelDebug), slog.LevelInfo, "first\nsecond\rthird")
	got := buf.String()
	if n := strings.Count(got, "\n"); n != 1 || !strings.HasSuffix(got, "\n") {
		t.Fatalf("record has %d newlines, want one trailing: %q", n, got)
	}
	if !strings.Contains(got, `first\nsecond\rthird`) {
		t.Fatalf("record = %q, want the line breaks escaped", got)
	}
}

func TestMessageEscapesEveryControlCharacter(t *testing.T) {
	var buf bytes.Buffer
	handle(t, newHandler(&buf, false, slog.LevelDebug), slog.LevelInfo,
		"bell\x07 esc\x1b[31m tab\tdel\x7f c1\u0085 héllo")
	want := "2026-11-23 10:04:05.123 INFO  " +
		`bell\x07 esc\x1b[31m tab\tdel\x7f c1\u0085 héllo` + "\n"
	if got := buf.String(); got != want {
		t.Fatalf("record = %q\nwant     %q", got, want)
	}
	for _, r := range strings.TrimSuffix(buf.String(), "\n") {
		if unicode.IsControl(r) {
			t.Errorf("record holds a raw control character %U: %q", r, buf.String())
		}
	}

	var plain bytes.Buffer
	writeError(&plain, false, "crha: \x1b[31mboom")
	if got, want := plain.String(), `crha: \x1b[31mboom`+"\n"; got != want {
		t.Fatalf("plain error = %q, want %q", got, want)
	}
}

func TestRawJSONAttributeIsVerbatim(t *testing.T) {
	var buf bytes.Buffer
	handle(t, newHandler(&buf, false, slog.LevelDebug), slog.LevelInfo, "message",
		slog.String("task_id", "t1"),
		slog.Any("spec", json.RawMessage(`{"kind":"exec","argv":["ls","-la"]}`)))
	want := `2026-11-23 10:04:05.123 INFO  message task_id=t1 ` +
		`spec={"kind":"exec","argv":["ls","-la"]}` + "\n"
	if got := buf.String(); got != want {
		t.Fatalf("record = %q, want %q", got, want)
	}
}

func TestRawJSONAttributeIsCompactedToItsLine(t *testing.T) {
	var buf bytes.Buffer
	handle(t, newHandler(&buf, false, slog.LevelDebug), slog.LevelInfo, "message",
		slog.Any("spec", json.RawMessage("{\n  \"kind\": \"exec\",\n  \"argv\": [\"ls\", \"-la\"]\n}")))
	want := `2026-11-23 10:04:05.123 INFO  message spec={"kind":"exec","argv":["ls","-la"]}` + "\n"
	if got := buf.String(); got != want {
		t.Fatalf("record = %q, want %q", got, want)
	}
	if n := strings.Count(buf.String(), "\n"); n != 1 {
		t.Fatalf("record has %d newlines, want one trailing: %q", n, buf.String())
	}
}

func TestRawJSONAttributeFallsBackToQuoted(t *testing.T) {
	tests := []struct {
		name string
		raw  json.RawMessage
		want string
	}{
		{"truncated", json.RawMessage(`{"kind":`), `spec="{\"kind\":"`},
		{"not JSON", json.RawMessage("not json"), `spec="not json"`},
		{"empty", json.RawMessage(""), `spec=""`},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			var buf bytes.Buffer
			handle(t, newHandler(&buf, false, slog.LevelDebug), slog.LevelInfo, "message",
				slog.Any("spec", tt.raw))
			want := "2026-11-23 10:04:05.123 INFO  message " + tt.want + "\n"
			if got := buf.String(); got != want {
				t.Fatalf("record = %q, want %q", got, want)
			}
		})
	}
}

func TestGroupsUseDottedPrefixes(t *testing.T) {
	var buf bytes.Buffer
	h := newHandler(&buf, false, slog.LevelDebug)
	derived := h.WithAttrs([]slog.Attr{slog.Int("root", 1)}).WithGroup("g").
		WithAttrs([]slog.Attr{slog.Int("a", 2)}).WithGroup("h")
	handle(t, derived, slog.LevelInfo, "message", slog.Int("b", 3))
	handle(t, h, slog.LevelInfo, "group", slog.Group("g",
		slog.Int("a", 1), slog.Group("h", slog.String("b", "x"))))
	handle(t, h.WithGroup("g"), slog.LevelInfo, "inline", slog.Group("", slog.Int("x", 1)))
	want := "2026-11-23 10:04:05.123 INFO  message root=1 g.a=2 g.h.b=3\n" +
		"2026-11-23 10:04:05.123 INFO  group g.a=1 g.h.b=x\n" +
		"2026-11-23 10:04:05.123 INFO  inline g.x=1\n"
	if got := buf.String(); got != want {
		t.Fatalf("records =\n%q\nwant\n%q", got, want)
	}
}

func TestWithAttrsBeforeWithGroupKeepsItsPlace(t *testing.T) {
	var buf bytes.Buffer
	logger := slog.New(newHandler(&buf, false, slog.LevelDebug))
	logger.WithGroup("g").With("a", 1).Info("message", "b", 2)
	if got := buf.String(); !strings.Contains(got, "message g.a=1 g.b=2") {
		t.Fatalf("record = %q, want g.a=1 g.b=2", got)
	}
}

func TestJournalFormat(t *testing.T) {
	tests := []struct {
		level slog.Level
		want  string
	}{
		{slog.LevelDebug, "<7>message key=value\n"},
		{slog.LevelInfo, "<6>message key=value\n"},
		{slog.LevelWarn, "<4>message key=value\n"},
		{slog.LevelError, "<3>message key=value\n"},
	}
	for _, tt := range tests {
		var buf bytes.Buffer
		handle(t, newHandler(&buf, true, slog.LevelDebug), tt.level, "message", slog.String("key", "value"))
		got := buf.String()
		if got != tt.want {
			t.Errorf("journal level %v record = %q, want %q", tt.level, got, tt.want)
		}
		for _, unwanted := range []string{"INFO", "WARN", "ERROR", "DEBUG", "2026-", "time=", "level=", "msg="} {
			if strings.Contains(got, unwanted) {
				t.Errorf("journal record contains %q: %q", unwanted, got)
			}
		}
	}
}

func TestJournalQuotesAttributesLikePlain(t *testing.T) {
	var buf bytes.Buffer
	handle(t, newHandler(&buf, true, slog.LevelDebug), slog.LevelInfo, "message", slog.String("key", "two words"))
	want := "<6>message key=\"two words\"\n"
	if got := buf.String(); got != want {
		t.Fatalf("journal record = %q, want %q", got, want)
	}
}

func TestEnabledByLevel(t *testing.T) {
	var buf bytes.Buffer
	h := newHandler(&buf, false, slog.LevelWarn)
	if h.Enabled(context.Background(), slog.LevelInfo) {
		t.Fatal("INFO is enabled on a WARN handler")
	}
	if !h.Enabled(context.Background(), slog.LevelWarn) || !h.Enabled(context.Background(), slog.LevelError) {
		t.Fatal("WARN or ERROR is disabled on a WARN handler")
	}
	logger := slog.New(h)
	logger.Info("dropped")
	logger.Warn("kept")
	if got := buf.String(); strings.Contains(got, "dropped") || !strings.Contains(got, "WARN  kept") {
		t.Fatalf("records = %q, want only the warning", got)
	}
}

func TestNewDefaultsToInfo(t *testing.T) {
	var buf bytes.Buffer
	logger := New(&buf)
	logger.Debug("dropped")
	logger.Info("kept")
	got := buf.String()
	if strings.Contains(got, "dropped") || !strings.Contains(got, "INFO  kept") {
		t.Fatalf("records = %q, want INFO and above and the plain format", got)
	}
}

// countingWriter counts writes so a record can be shown to be one write.
type countingWriter struct {
	writes int
	buf    bytes.Buffer
}

func (w *countingWriter) Write(p []byte) (int, error) {
	w.writes++
	return w.buf.Write(p)
}

func TestOneWritePerRecord(t *testing.T) {
	w := &countingWriter{}
	logger := slog.New(newHandler(w, false, slog.LevelDebug))
	logger.With("a", 1).WithGroup("g").Info("message", "b", 2)
	if w.writes != 1 {
		t.Fatalf("%d writes for one record, want 1", w.writes)
	}
}

func TestConcurrentRecordsDoNotInterleave(t *testing.T) {
	var buf bytes.Buffer
	logger := slog.New(newHandler(&buf, false, slog.LevelDebug))
	const goroutines, records = 20, 20
	var wg sync.WaitGroup
	for i := 0; i < goroutines; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			for j := 0; j < records; j++ {
				logger.Info("concurrent message", "goroutine", i, "record", j)
			}
		}(i)
	}
	wg.Wait()
	lines := strings.Split(strings.TrimSuffix(buf.String(), "\n"), "\n")
	if len(lines) != goroutines*records {
		t.Fatalf("%d lines, want %d", len(lines), goroutines*records)
	}
	for _, line := range lines {
		if !strings.Contains(line, " INFO  concurrent message goroutine=") ||
			!strings.Contains(line, " record=") {
			t.Fatalf("interleaved record: %q", line)
		}
	}
}

func TestPrintError(t *testing.T) {
	var plain bytes.Buffer
	writeError(&plain, false, "crha: boom")
	if got, want := plain.String(), "crha: boom\n"; got != want {
		t.Fatalf("plain error = %q, want %q", got, want)
	}
	var journal bytes.Buffer
	writeError(&journal, true, "crha: boom")
	if got, want := journal.String(), "<3>crha: boom\n"; got != want {
		t.Fatalf("journal error = %q, want %q", got, want)
	}
	if got := journal.String(); strings.Contains(got, "ERROR") || strings.Contains(got, "2026") {
		t.Fatalf("journal error carries a level word or time: %q", got)
	}
}

func TestJournalStream(t *testing.T) {
	stat := func(fd int) (FdStat, error) {
		if fd != 2 {
			return FdStat{}, errors.New("not stderr")
		}
		return FdStat{Dev: 8, Ino: 123}, nil
	}
	failing := func(int) (FdStat, error) { return FdStat{}, errors.New("stat failed") }
	tests := []struct {
		name string
		env  string
		stat func(int) (FdStat, error)
		want bool
	}{
		{"matching", "8:123", stat, true},
		{"other device", "9:123", stat, false},
		{"other inode", "8:124", stat, false},
		{"missing variable", "", stat, false},
		{"no colon", "8", stat, false},
		{"empty device", ":123", stat, false},
		{"empty inode", "8:", stat, false},
		{"not numbers", "x:y", stat, false},
		{"too many parts", "8:123:4", stat, false},
		{"non-decimal", "0x8:123", stat, false},
		{"leading space", " 8:123", stat, false},
		{"stat error", "8:123", failing, false},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := journalStream(tt.env, 2, tt.stat); got != tt.want {
				t.Fatalf("journalStream(%q) = %v, want %v", tt.env, got, tt.want)
			}
		})
	}
}

func TestJournalStreamWithoutVariable(t *testing.T) {
	t.Setenv("JOURNAL_STREAM", "")
	if JournalStream(2) {
		t.Fatal("JournalStream(2) = true without JOURNAL_STREAM")
	}
}

func TestNewPlainAndNewJournalIgnoreTheEnvironment(t *testing.T) {
	// The explicit constructors must not depend on the environment even when it names a stream.
	t.Setenv("JOURNAL_STREAM", "8:123")
	var plain, journal bytes.Buffer
	NewPlain(&plain).Info("message")
	NewJournal(&journal).Info("message")
	if got := plain.String(); !strings.Contains(got, "INFO  message") {
		t.Fatalf("NewPlain record = %q, want the plain format", got)
	}
	if got, want := journal.String(), "<6>message\n"; got != want {
		t.Fatalf("NewJournal record = %q, want %q", got, want)
	}
	// A non-stderr writer is never the journal, whatever the variable says.
	var other bytes.Buffer
	New(&other).Info("message")
	if got := other.String(); !strings.Contains(got, "INFO  message") {
		t.Fatalf("New(non-stderr) record = %q, want the plain format", got)
	}
}

func TestStructuredValues(t *testing.T) {
	// Values a caller may pass as any (errors, stringers, nil) and the numeric kinds must render as
	// one token, quoted when their text would break the line.
	var buf bytes.Buffer
	logger := slog.New(newHandler(&buf, false, slog.LevelDebug))
	var nilErr error
	logger.Info("values",
		"err", errors.New("two words"),
		"nil", nilErr,
		"uint", uint64(7),
		"float", 1.25,
		"any", []int{1, 2},
	)
	got := buf.String()
	for _, want := range []string{`err="two words"`, "nil=<nil>", "uint=7", "float=1.25", "any=\"[1 2]\""} {
		if !strings.Contains(got, want) {
			t.Errorf("record = %q, want it to contain %q", got, want)
		}
	}
}

func TestAppendPriorityCustomLevels(t *testing.T) {
	tests := []struct {
		level slog.Level
		want  string
	}{
		{slog.LevelDebug - 2, "<7>"},
		{slog.LevelInfo + 2, "<6>"},
		{slog.LevelWarn + 2, "<4>"},
		{slog.LevelError + 2, "<3>"},
	}
	for _, tt := range tests {
		if got := string(appendPriority(nil, tt.level)); got != tt.want {
			t.Errorf("priority of %v = %q, want %q", tt.level, got, tt.want)
		}
	}
}

func TestHandleWriteErrorIsReturned(t *testing.T) {
	h := newHandler(errorWriter{}, false, slog.LevelDebug)
	r := slog.NewRecord(fixedTime, slog.LevelInfo, "message", 0)
	if err := h.Handle(context.Background(), r); err == nil {
		t.Fatal("Handle hid the writer's error")
	}
}

type errorWriter struct{}

func (errorWriter) Write([]byte) (int, error) { return 0, errors.New("write failed") }

func TestQuoteKeyThatBreaksKeyValue(t *testing.T) {
	var buf bytes.Buffer
	logger := slog.New(newHandler(&buf, false, slog.LevelDebug))
	logger.Info("message", "a b", 1)
	if got := buf.String(); !strings.Contains(got, `"a b"=1`) {
		t.Fatalf("record = %q, want the key quoted", got)
	}
}

// TestHandlerInterface guards the method set slog.New needs.
var _ slog.Handler = (*handler)(nil)

// TestWriterErrorIsNotPanic covers a closed writer: Handle reports it and the logger prints through.
func TestWriterErrorIsNotPanic(t *testing.T) {
	logger := slog.New(newHandler(errorWriter{}, false, slog.LevelDebug))
	logger.Info("message")
}
