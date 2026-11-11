package state

import (
	"encoding/hex"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

const day = 24 * time.Hour

func testID(b byte) [32]byte {
	var id [32]byte
	for i := range id {
		id[i] = b
	}
	return id
}

func testIDHex(b byte) string {
	id := testID(b)
	return hex.EncodeToString(id[:])
}

func testNow() time.Time { return time.UnixMilli(1_793_016_000_000) }

func openAt(t *testing.T, dir string, now time.Time) *Store {
	t.Helper()
	return openWith(t, dir, Options{Now: func() time.Time { return now }})
}

func openWith(t *testing.T, dir string, opts Options) *Store {
	t.Helper()
	s, err := Open(dir, opts)
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	return s
}

// clock is a mutable test clock the store reads now from.
type clock struct{ at time.Time }

func (c *clock) now() time.Time { return c.at }

// lineCount counts the non-empty lines in path.
func lineCount(t *testing.T, path string) int {
	t.Helper()
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read %s: %v", path, err)
	}
	lines := 0
	for _, line := range strings.Split(string(data), "\n") {
		if strings.TrimSpace(line) != "" {
			lines++
		}
	}
	return lines
}

func TestPersistenceAcrossRestart(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "state")
	now := testNow()
	s := openAt(t, dir, now)
	deadline := now.Add(5 * time.Minute).UnixMilli()
	if err := s.AddUsed(Record{
		TaskID: "t1", Attempt: 1, AuthorizationID: testIDHex(0x11),
		IssuedAtMS: now.Add(-time.Minute).UnixMilli(), DeadlineMS: deadline,
		SpecSHA256: "ab", AcceptedAtMS: now.UnixMilli(),
	}); err != nil {
		t.Fatalf("AddUsed: %v", err)
	}
	if err := s.AddUsed(Record{TaskID: "t2", Attempt: 2, AcceptedAtMS: now.UnixMilli()}); err != nil {
		t.Fatalf("AddUsed: %v", err)
	}
	if !s.Executed("t1") || !s.Executed("t2") || s.Executed("t3") {
		t.Fatalf("executed lookups are wrong")
	}
	if !s.Used(testID(0x11), "t1") || s.Used(testID(0x11), "t2") {
		t.Fatalf("pair lookups are wrong")
	}
	if s.Watermark() != 0 {
		t.Fatalf("watermark = %d, want none", s.Watermark())
	}
	if err := s.Close(); err != nil {
		t.Fatalf("Close: %v", err)
	}

	reopened := openAt(t, dir, now.Add(time.Minute))
	defer reopened.Close()
	if !reopened.Executed("t1") || !reopened.Executed("t2") {
		t.Fatal("used records did not survive the restart")
	}
	if !reopened.Used(testID(0x11), "t1") {
		t.Fatal("used pair did not survive the restart")
	}
}

func TestAddUsedIsAppendOnlyAndDurable(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "state")
	now := testNow()
	s := openAt(t, dir, now)
	defer s.Close()
	if err := s.AddUsed(Record{TaskID: "t1", AcceptedAtMS: now.UnixMilli()}); err != nil {
		t.Fatal(err)
	}
	if err := s.AddUsed(Record{TaskID: "t1", AcceptedAtMS: now.UnixMilli()}); err == nil {
		t.Fatal("duplicate task id accepted by the store")
	}
	// The record must already be on disk when AddUsed returns; a second store reading the
	// same directory sees it without the first one closing.
	other := openAt(t, dir, now)
	defer other.Close()
	if !other.Executed("t1") {
		t.Fatal("record is not on disk before the task would have started")
	}
	info, err := os.Stat(filepath.Join(dir, usedFileName))
	if err != nil {
		t.Fatal(err)
	}
	if mode := info.Mode().Perm(); mode != 0o600 {
		t.Fatalf("used file mode = %04o, want 0600", mode)
	}
	di, err := os.Stat(dir)
	if err != nil {
		t.Fatal(err)
	}
	if mode := di.Mode().Perm(); mode != 0700 {
		t.Fatalf("state dir mode = %04o, want 0700", mode)
	}
}

// TestUsedRetention covers the cleanup rules: a record with an authorization lives until one
// hour (at least) past its deadline, and a local approval lives for 24 hours after it was
// accepted.
func TestUsedRetention(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "state")
	clk := &clock{at: testNow()}
	s := openWith(t, dir, Options{Now: clk.now})
	defer s.Close()

	deadline := clk.at.Add(10 * time.Minute).UnixMilli()
	if err := s.AddUsed(Record{
		TaskID: "with-deadline", AuthorizationID: testIDHex(0x11),
		IssuedAtMS: clk.at.Add(-time.Minute).UnixMilli(), DeadlineMS: deadline,
		AcceptedAtMS: clk.at.UnixMilli(),
	}); err != nil {
		t.Fatal(err)
	}
	if err := s.AddUsed(Record{TaskID: "local", AcceptedAtMS: clk.at.UnixMilli()}); err != nil {
		t.Fatal(err)
	}

	// 30 minutes after the deadline: still inside the one-hour retention margin. A new
	// record prunes first; all two survive.
	clk.at = testNow().Add(40 * time.Minute)
	if err := s.AddUsed(Record{TaskID: "probe-1", AcceptedAtMS: clk.at.UnixMilli()}); err != nil {
		t.Fatal(err)
	}
	for _, task := range []string{"with-deadline", "local"} {
		if !s.Executed(task) {
			t.Fatalf("%s was dropped inside its retention window", task)
		}
	}

	// Past deadline+1h the authorized record is dropped; the 24h records survive.
	clk.at = time.UnixMilli(deadline).Add(time.Hour + time.Second)
	if err := s.AddUsed(Record{TaskID: "probe-2", AcceptedAtMS: clk.at.UnixMilli()}); err != nil {
		t.Fatal(err)
	}
	if s.Executed("with-deadline") {
		t.Fatal("an authorized record past deadline+1h was kept")
	}
	if !s.Executed("local") {
		t.Fatal("a 24h record was dropped early")
	}

	// 24 hours after acceptance the records without an authorization are dropped.
	clk.at = testNow().Add(24*time.Hour + time.Second)
	if err := s.AddUsed(Record{TaskID: "probe-3", AcceptedAtMS: clk.at.UnixMilli()}); err != nil {
		t.Fatal(err)
	}
	if s.Executed("local") {
		t.Fatal("a record older than 24h without an authorization was kept")
	}
}

// TestUsedRetentionWithLargeClockSkew covers clock_skew > 1h: the retention margin follows the
// configured skew, so a clock that stepped back by more than an hour cannot make an expired
// authorization usable again.
func TestUsedRetentionWithLargeClockSkew(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "state")
	clk := &clock{at: testNow()}
	s := openWith(t, dir, Options{Now: clk.now, ClockSkew: 3 * time.Hour})
	defer s.Close()

	deadline := clk.at.Add(10 * time.Minute).UnixMilli()
	if err := s.AddUsed(Record{
		TaskID: "skewed", AuthorizationID: testIDHex(0x11),
		IssuedAtMS: clk.at.Add(-time.Second).UnixMilli(), DeadlineMS: deadline,
		AcceptedAtMS: clk.at.UnixMilli(),
	}); err != nil {
		t.Fatal(err)
	}
	// Two hours past the deadline is inside max(1h, 3h).
	clk.at = time.UnixMilli(deadline).Add(2 * time.Hour)
	if err := s.AddUsed(Record{TaskID: "probe-1", AcceptedAtMS: clk.at.UnixMilli()}); err != nil {
		t.Fatal(err)
	}
	if !s.Executed("skewed") {
		t.Fatal("a record inside deadline+clock_skew was dropped")
	}
	clk.at = time.UnixMilli(deadline).Add(3*time.Hour + time.Second)
	if err := s.AddUsed(Record{TaskID: "probe-2", AcceptedAtMS: clk.at.UnixMilli()}); err != nil {
		t.Fatal(err)
	}
	if s.Executed("skewed") {
		t.Fatal("a record past deadline+clock_skew was kept")
	}
}

// withMaxRecords lowers the in-memory cap for one test.
func withMaxRecords(t *testing.T, limit int) {
	t.Helper()
	old := maxRecords
	maxRecords = limit
	t.Cleanup(func() { maxRecords = old })
}

// withRebuildFloor lowers the rebuild floor for one test.
func withRebuildFloor(t *testing.T, floor int) {
	t.Helper()
	old := rebuildFloor
	rebuildFloor = floor
	t.Cleanup(func() { rebuildFloor = old })
}

// authorizedRecord builds a record whose authorization is acceptable at now.
func authorizedRecord(taskID string, now time.Time, issuedAt time.Time, deadline time.Time) Record {
	return Record{
		TaskID: taskID, AuthorizationID: testIDHex(0x11),
		IssuedAtMS: issuedAt.UnixMilli(), DeadlineMS: deadline.UnixMilli(), AcceptedAtMS: now.UnixMilli(),
	}
}

// TestCapEvictionOrder covers the in-memory cap: before every AddUsed the oldest accepted
// record is evicted, and the eviction of a still acceptable authorization raises the watermark
// to its issued_at.
func TestCapEvictionOrder(t *testing.T) {
	withMaxRecords(t, 3)
	dir := filepath.Join(t.TempDir(), "state")
	now := testNow()
	s := openAt(t, dir, now)
	defer s.Close()

	for i, rec := range []Record{
		authorizedRecord("a", now, now.Add(-3*time.Minute), now.Add(time.Hour)),
		authorizedRecord("b", now, now.Add(-2*time.Minute), now.Add(time.Hour)),
		authorizedRecord("c", now, now.Add(-time.Minute), now.Add(time.Hour)),
	} {
		if err := s.AddUsed(rec); err != nil {
			t.Fatalf("AddUsed %d: %v", i, err)
		}
	}
	if s.Watermark() != 0 {
		t.Fatalf("watermark = %d before any eviction", s.Watermark())
	}
	// The fourth record evicts a, the oldest accepted.
	if err := s.AddUsed(authorizedRecord("d", now, now.Add(-30*time.Second), now.Add(time.Hour))); err != nil {
		t.Fatal(err)
	}
	if s.Executed("a") || !s.Executed("b") || !s.Executed("c") || !s.Executed("d") {
		t.Fatal("eviction did not drop exactly the oldest accepted record")
	}
	if want := now.Add(-3 * time.Minute).UnixMilli(); s.Watermark() != want {
		t.Fatalf("watermark = %d, want %d", s.Watermark(), want)
	}
	// The next one evicts b, raising the watermark further.
	if err := s.AddUsed(authorizedRecord("e", now, now.Add(-10*time.Second), now.Add(time.Hour))); err != nil {
		t.Fatal(err)
	}
	if s.Executed("b") {
		t.Fatal("the second eviction did not drop the next oldest record")
	}
	if want := now.Add(-2 * time.Minute).UnixMilli(); s.Watermark() != want {
		t.Fatalf("watermark = %d, want %d", s.Watermark(), want)
	}
}

// TestWatermarkOnlyForAcceptableAuthorizations covers what raises the watermark: only an
// evicted record with an authorization that the decision could still accept. Local approvals
// and authorizations past deadline+clock_skew do not.
func TestWatermarkOnlyForAcceptableAuthorizations(t *testing.T) {
	now := testNow()

	t.Run("local approvals never raise it", func(t *testing.T) {
		withMaxRecords(t, 2)
		s := openAt(t, filepath.Join(t.TempDir(), "state"), now)
		defer s.Close()
		for _, id := range []string{"l1", "l2", "l3"} {
			if err := s.AddUsed(Record{TaskID: id, AcceptedAtMS: now.UnixMilli()}); err != nil {
				t.Fatal(err)
			}
		}
		if s.Watermark() != 0 {
			t.Fatalf("watermark = %d, want none", s.Watermark())
		}
	})

	t.Run("an expired authorization does not raise it", func(t *testing.T) {
		withMaxRecords(t, 2)
		// clock_skew 0: the one-hour retention margin keeps the record, but the decision
		// would already refuse it.
		s := openAt(t, filepath.Join(t.TempDir(), "state"), now)
		defer s.Close()
		stale := authorizedRecord("stale", now.Add(-30*time.Minute),
			now.Add(-time.Hour), now.Add(-30*time.Minute))
		if err := s.AddUsed(stale); err != nil {
			t.Fatal(err)
		}
		if err := s.AddUsed(Record{TaskID: "local", AcceptedAtMS: now.UnixMilli()}); err != nil {
			t.Fatal(err)
		}
		if err := s.AddUsed(Record{TaskID: "third", AcceptedAtMS: now.UnixMilli()}); err != nil {
			t.Fatal(err)
		}
		if s.Executed("stale") {
			t.Fatal("the stale record was not evicted")
		}
		if s.Watermark() != 0 {
			t.Fatalf("watermark = %d, want none for an expired authorization", s.Watermark())
		}
	})
}

// TestRebuildThreshold covers the append-only file: it only grows below the threshold and is
// rewritten with exactly the live records once it reaches it.
func TestRebuildThreshold(t *testing.T) {
	withRebuildFloor(t, 2)
	dir := filepath.Join(t.TempDir(), "state")
	clk := &clock{at: testNow()}
	s := openWith(t, dir, Options{Now: clk.now})
	defer s.Close()
	usedPath := filepath.Join(dir, usedFileName)

	for _, id := range []string{"r1", "r2", "r3"} {
		if err := s.AddUsed(Record{TaskID: id, AcceptedAtMS: clk.at.UnixMilli()}); err != nil {
			t.Fatal(err)
		}
	}
	// Three live records stay below 2*max(3, 2): the file is append-only.
	if got := lineCount(t, usedPath); got != 3 {
		t.Fatalf("file has %d lines before the threshold, want 3", got)
	}

	// Let every record expire, then add one: the append is line 4, live is 1, and
	// 4 >= 2*max(1, 2), so the file shrinks to the single live record.
	clk.at = clk.at.Add(24*time.Hour + time.Minute)
	if err := s.AddUsed(Record{TaskID: "r4", AcceptedAtMS: clk.at.UnixMilli()}); err != nil {
		t.Fatal(err)
	}
	if got := lineCount(t, usedPath); got != 1 {
		t.Fatalf("file has %d lines after the rebuild, want 1", got)
	}
	if s.Executed("r1") || !s.Executed("r4") {
		t.Fatal("the rebuild did not keep exactly the live records")
	}
	data, err := os.ReadFile(usedPath)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(data), `"task_id":"r4"`) {
		t.Fatalf("the rebuilt file does not contain the live record: %q", data)
	}
}

// TestStartupLoadCapsAndRebuilds covers Open: the file is read, retention drops old records,
// the cap evicts the oldest accepted and raises the watermark, and the file is rewritten once
// with the live records.
func TestStartupLoadCapsAndRebuilds(t *testing.T) {
	withMaxRecords(t, 2)
	dir := t.TempDir()
	now := testNow()
	deadline := now.Add(time.Hour).UnixMilli()
	var buf strings.Builder
	// Oldest accepted first, in file (acceptance) order.
	for i, id := range []string{"s1", "s2", "s3"} {
		issued := now.Add(time.Duration(i-5) * time.Minute).UnixMilli()
		fmt.Fprintf(&buf, `{"task_id":%q,"authorization_id":%q,"issued_at_ms":%d,"deadline_ms":%d,"accepted_at_ms":%d}`+"\n",
			id, testIDHex(byte(0x10+i)), issued, deadline, now.UnixMilli())
	}
	// An expired record is dropped by retention before the cap.
	fmt.Fprintf(&buf, `{"task_id":"expired","authorization_id":%q,"issued_at_ms":%d,"deadline_ms":%d,"accepted_at_ms":%d}`+"\n",
		testIDHex(0x99), now.Add(-3*time.Hour).UnixMilli(), now.Add(-2*time.Hour).UnixMilli(), now.Add(-3*time.Hour).UnixMilli())
	if err := os.WriteFile(filepath.Join(dir, usedFileName), []byte(buf.String()), 0o600); err != nil {
		t.Fatal(err)
	}

	s := openAt(t, dir, now)
	defer s.Close()
	if s.Executed("expired") || s.Executed("s1") {
		t.Fatal("retention or the startup cap did not drop the oldest records")
	}
	if !s.Executed("s2") || !s.Executed("s3") {
		t.Fatal("the newest records were not loaded")
	}
	// s1 was evicted while still acceptable, so its issued_at becomes the watermark.
	if want := now.Add(-5 * time.Minute).UnixMilli(); s.Watermark() != want {
		t.Fatalf("watermark = %d, want %d", s.Watermark(), want)
	}
	if got := lineCount(t, filepath.Join(dir, usedFileName)); got != 2 {
		t.Fatalf("file has %d lines after the startup rebuild, want 2", got)
	}
}

// TestTornLastLineIsIgnored covers a crash in the middle of an append: a final line without a
// trailing newline that does not parse is the remains of a write that never returned, so its
// task never ran. It is ignored and the compacted file no longer contains it.
func TestTornLastLineIsIgnored(t *testing.T) {
	dir := t.TempDir()
	now := testNow()
	good := fmt.Sprintf(`{"task_id":"t1","accepted_at_ms":%d}`, now.UnixMilli()) + "\n"
	torn := `{"task_id":"torn","attempt":`
	if err := os.WriteFile(filepath.Join(dir, usedFileName), []byte(good+torn), 0o600); err != nil {
		t.Fatal(err)
	}
	s := openAt(t, dir, now)
	if !s.Executed("t1") {
		t.Fatal("the complete record before the torn tail was dropped")
	}
	if s.Executed("torn") {
		t.Fatal("a torn record was loaded")
	}
	if err := s.AddUsed(Record{TaskID: "t2", AcceptedAtMS: now.UnixMilli()}); err != nil {
		t.Fatal(err)
	}
	if err := s.Close(); err != nil {
		t.Fatal(err)
	}
	data, err := os.ReadFile(filepath.Join(dir, usedFileName))
	if err != nil {
		t.Fatal(err)
	}
	text := string(data)
	if !strings.Contains(text, "t1") || !strings.Contains(text, "t2") {
		t.Fatalf("kept records are missing: %q", text)
	}
	if strings.Contains(text, "torn") {
		t.Fatalf("the torn record survived the compaction: %q", text)
	}
	if !strings.HasSuffix(text, "\n") {
		t.Fatalf("the compacted file does not end with a newline: %q", text)
	}
}

// TestTornLineThatParsesIsKept covers a final line without a newline that is a complete record:
// the write may have been interrupted after the data reached the file, and the record is valid.
func TestTornLineThatParsesIsKept(t *testing.T) {
	dir := t.TempDir()
	now := testNow()
	line := fmt.Sprintf(`{"task_id":"t1","accepted_at_ms":%d}`, now.UnixMilli())
	if err := os.WriteFile(filepath.Join(dir, usedFileName), []byte(line), 0o600); err != nil {
		t.Fatal(err)
	}
	s := openAt(t, dir, now)
	defer s.Close()
	if !s.Executed("t1") {
		t.Fatal("a complete final line without a newline was dropped")
	}
}

// TestMalformedLineIsRefused covers the other side: any malformed line that is not the final,
// newline-less one stays a hard error; a malformed final line with a newline was written
// completely.
func TestMalformedLineIsRefused(t *testing.T) {
	now := testNow()
	dir := t.TempDir()
	good := fmt.Sprintf(`{"task_id":"t1","accepted_at_ms":%d}`, now.UnixMilli()) + "\n"
	if err := os.WriteFile(filepath.Join(dir, usedFileName), []byte("{not json\n"+good), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := Open(dir, Options{Now: func() time.Time { return now }}); err == nil || !strings.Contains(err.Error(), "line 1") {
		t.Fatalf("a malformed middle line: %v", err)
	}
	dir2 := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir2, usedFileName), []byte("{not json\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := Open(dir2, Options{}); err == nil || !strings.Contains(err.Error(), "line 1") {
		t.Fatalf("a malformed final line with a newline: %v", err)
	}
}

func TestCorruptFileIsRefused(t *testing.T) {
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, usedFileName), []byte("{not json\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := Open(dir, Options{}); err == nil || !strings.Contains(err.Error(), "line 1") {
		t.Fatalf("corrupt used file: %v", err)
	}
	// A live record whose authorization id is not 32 bytes of hex is corrupt too.
	dir2 := t.TempDir()
	now := testNow()
	line := fmt.Sprintf(`{"task_id":"t","authorization_id":"zz","deadline_ms":%d,"accepted_at_ms":%d}`+"\n",
		now.Add(time.Hour).UnixMilli(), now.UnixMilli())
	if err := os.WriteFile(filepath.Join(dir2, usedFileName), []byte(line), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := Open(dir2, Options{Now: func() time.Time { return now }}); err == nil || !strings.Contains(err.Error(), "authorization id") {
		t.Fatalf("corrupt authorization id: %v", err)
	}
}

func TestOpenErrors(t *testing.T) {
	if _, err := Open("", Options{}); err == nil {
		t.Fatal("empty directory accepted")
	}
	file := filepath.Join(t.TempDir(), "file")
	if err := os.WriteFile(file, []byte("x"), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := Open(file, Options{}); err == nil {
		t.Fatal("a regular file was accepted as the state directory")
	}
}

// TestNoPersist covers the in-memory-only switch: no directory or file is created, an existing
// file is not read, and duplicate detection and eviction still work.
func TestNoPersist(t *testing.T) {
	now := testNow()
	dir := filepath.Join(t.TempDir(), "state")
	s := openWith(t, dir, Options{NoPersist: true, Now: func() time.Time { return now }})
	if err := s.AddUsed(Record{TaskID: "mem-1", AcceptedAtMS: now.UnixMilli()}); err != nil {
		t.Fatalf("AddUsed: %v", err)
	}
	if !s.Executed("mem-1") {
		t.Fatal("in-memory record is not visible")
	}
	if err := s.AddUsed(Record{TaskID: "mem-1", AcceptedAtMS: now.UnixMilli()}); err == nil {
		t.Fatal("duplicate task id accepted in memory")
	}
	// The in-memory cap works without a file.
	withMaxRecords(t, 1)
	withRebuildFloor(t, 1)
	if err := s.AddUsed(Record{TaskID: "mem-2", AcceptedAtMS: now.UnixMilli()}); err != nil {
		t.Fatal(err)
	}
	if s.Executed("mem-1") || !s.Executed("mem-2") {
		t.Fatal("the in-memory cap did not evict the oldest record")
	}
	if err := s.Close(); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(dir); !os.IsNotExist(err) {
		t.Fatalf("NoPersist created the state directory: %v", err)
	}

	// An existing used file is not read either.
	dir2 := t.TempDir()
	line := fmt.Sprintf(`{"task_id":"on-disk","accepted_at_ms":%d}`+"\n", now.UnixMilli())
	if err := os.WriteFile(filepath.Join(dir2, usedFileName), []byte(line), 0o600); err != nil {
		t.Fatal(err)
	}
	memory := openWith(t, dir2, Options{NoPersist: true, Now: func() time.Time { return now }})
	defer memory.Close()
	if memory.Executed("on-disk") {
		t.Fatal("NoPersist read the used file")
	}
	if err := memory.AddUsed(Record{TaskID: "fresh", AcceptedAtMS: now.UnixMilli()}); err != nil {
		t.Fatal(err)
	}
	data, err := os.ReadFile(filepath.Join(dir2, usedFileName))
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(data), "fresh") {
		t.Fatalf("NoPersist wrote the used file: %q", data)
	}
}

// TestOldRevokedFileIsIgnored covers the removed revocation list: a leftover `revoked` file is
// never read or deleted.
func TestOldRevokedFileIsIgnored(t *testing.T) {
	dir := t.TempDir()
	now := testNow()
	revoked := []byte(`{"authorization_id":"zz","deadline_ms":1}` + "\n")
	if err := os.WriteFile(filepath.Join(dir, "revoked"), revoked, 0o600); err != nil {
		t.Fatal(err)
	}
	line := fmt.Sprintf(`{"task_id":"t1","accepted_at_ms":%d}`+"\n", now.UnixMilli())
	if err := os.WriteFile(filepath.Join(dir, usedFileName), []byte(line), 0o600); err != nil {
		t.Fatal(err)
	}
	s := openAt(t, dir, now)
	defer s.Close()
	if !s.Executed("t1") {
		t.Fatal("the used record was not loaded next to an old revoked file")
	}
	data, err := os.ReadFile(filepath.Join(dir, "revoked"))
	if err != nil {
		t.Fatalf("the old revoked file was deleted: %v", err)
	}
	if string(data) != string(revoked) {
		t.Fatalf("the old revoked file was changed: %q", data)
	}
}
