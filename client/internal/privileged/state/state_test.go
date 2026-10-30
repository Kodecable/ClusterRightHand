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

const (
	day = 24 * time.Hour
)

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

func openAt(t *testing.T, dir string, now time.Time) *Store {
	t.Helper()
	s, err := Open(dir, Options{Now: func() time.Time { return now }})
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	return s
}

func TestPersistenceAcrossRestart(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "state")
	now := time.UnixMilli(1_793_016_000_000)
	s := openAt(t, dir, now)
	deadline := now.Add(5 * time.Minute).UnixMilli()
	if err := s.AddUsed(Record{
		TaskID: "t1", Attempt: 1, AuthorizationID: testIDHex(0x11),
		DeadlineMS: &deadline, SpecSHA256: "ab", AcceptedAtMS: now.UnixMilli(),
	}); err != nil {
		t.Fatalf("AddUsed: %v", err)
	}
	if err := s.AddUsed(Record{TaskID: "t2", Attempt: 2, AcceptedAtMS: now.UnixMilli()}); err != nil {
		t.Fatalf("AddUsed: %v", err)
	}
	revokedDeadline := now.Add(time.Hour).UnixMilli()
	if err := s.AddRevoked(testID(0x22), &revokedDeadline); err != nil {
		t.Fatalf("AddRevoked: %v", err)
	}
	if err := s.AddRevoked(testID(0x33), nil); err != nil {
		t.Fatalf("AddRevoked: %v", err)
	}
	if !s.Executed("t1") || !s.Executed("t2") || s.Executed("t3") {
		t.Fatalf("executed lookups are wrong")
	}
	if !s.Used(testID(0x11), "t1") || s.Used(testID(0x11), "t2") {
		t.Fatalf("pair lookups are wrong")
	}
	if !s.Revoked(testID(0x22)) || !s.Revoked(testID(0x33)) || s.Revoked(testID(0x44)) {
		t.Fatalf("revoked lookups are wrong")
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
	if !reopened.Revoked(testID(0x22)) || !reopened.Revoked(testID(0x33)) {
		t.Fatal("revocations did not survive the restart")
	}
}

func TestAddUsedIsAppendOnlyAndDurable(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "state")
	now := time.UnixMilli(1_793_016_000_000)
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
	if mode := di.Mode().Perm(); mode != 0o700 {
		t.Fatalf("state dir mode = %04o, want 0700", mode)
	}
}

// TestUsedRetention covers the cleanup rules: a record with a deadline lives until seven
// days after it, and a record without one lives for 30 days.
func TestUsedRetention(t *testing.T) {
	now := time.UnixMilli(1_793_016_000_000)
	dir := filepath.Join(t.TempDir(), "state")
	s := openAt(t, dir, now)
	deadline := now.UnixMilli()
	expiredDeadline := now.Add(-time.Hour).UnixMilli()
	// Ten days old at the first open, so it is still inside the 30-day window at the
	// latest check below (day 8).
	oldTask := now.Add(-10 * day).UnixMilli()
	ancientTask := now.Add(-31 * day).UnixMilli()
	for _, rec := range []Record{
		{TaskID: "with-deadline", DeadlineMS: &deadline, AcceptedAtMS: now.UnixMilli()},
		{TaskID: "deadline-expired", DeadlineMS: &expiredDeadline, AcceptedAtMS: now.Add(-time.Hour).UnixMilli()},
		{TaskID: "recent-task", AcceptedAtMS: oldTask},
		{TaskID: "ancient-task", AcceptedAtMS: ancientTask},
	} {
		if err := s.AddUsed(rec); err != nil {
			t.Fatal(err)
		}
	}
	if err := s.Close(); err != nil {
		t.Fatal(err)
	}

	// Six days past the deadline: kept. The no-deadline task is 16 days old at this
	// point: kept.
	later := now.Add(6 * day)
	s = openAt(t, dir, later)
	if !s.Executed("with-deadline") || !s.Executed("recent-task") {
		t.Fatal("records inside the retention window were dropped")
	}
	// The record whose deadline was an hour before the first open is already 6 days and
	// one hour past its deadline, still inside the seven-day margin.
	if !s.Executed("deadline-expired") {
		t.Fatal("a record inside the seven-day margin was dropped")
	}
	if s.Executed("ancient-task") {
		t.Fatal("a task record without deadline older than 30 days was kept")
	}
	if err := s.Close(); err != nil {
		t.Fatal(err)
	}

	// Eight days past the deadline: dropped.
	s = openAt(t, dir, now.Add(8*day))
	defer s.Close()
	if s.Executed("with-deadline") || s.Executed("deadline-expired") {
		t.Fatal("a record past deadline+7d was kept")
	}
	if !s.Executed("recent-task") {
		t.Fatal("an 18-day-old task record was dropped at day 8")
	}
}

func TestRevokedRetention(t *testing.T) {
	now := time.UnixMilli(1_793_016_000_000)
	dir := filepath.Join(t.TempDir(), "state")
	s := openAt(t, dir, now)
	soon := now.Add(time.Hour).UnixMilli()
	already := now.Add(-time.Minute).UnixMilli()
	if err := s.AddRevoked(testID(0x11), &soon); err != nil {
		t.Fatal(err)
	}
	if err := s.AddRevoked(testID(0x22), &already); err != nil {
		t.Fatal(err)
	}
	if err := s.AddRevoked(testID(0x33), nil); err != nil {
		t.Fatal(err)
	}
	if err := s.Close(); err != nil {
		t.Fatal(err)
	}

	// Two hours later the authorizations are past their deadline, but the seven-day retention
	// margin keeps the revocations: the node accepts the authorization until deadline+skew.
	later := openAt(t, dir, now.Add(2*time.Hour))
	if !later.Revoked(testID(0x11)) || !later.Revoked(testID(0x22)) {
		t.Fatal("a revocation inside the seven-day margin was dropped")
	}
	if !later.Revoked(testID(0x33)) {
		t.Fatal("a revocation without a deadline was dropped")
	}
	if err := later.Close(); err != nil {
		t.Fatal(err)
	}

	// Eight days past the deadlines the revocations are cleaned up.
	after := openAt(t, dir, now.Add(8*24*time.Hour))
	defer after.Close()
	if after.Revoked(testID(0x11)) || after.Revoked(testID(0x22)) {
		t.Fatal("a revocation past deadline+7d was kept")
	}
	if !after.Revoked(testID(0x33)) {
		t.Fatal("a revocation without a deadline was dropped")
	}
}

func TestAddRevokedIdempotent(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "state")
	now := time.UnixMilli(1_793_016_000_000)
	s := openAt(t, dir, now)
	defer s.Close()
	id := testID(0x11)
	deadline := now.Add(time.Hour).UnixMilli()
	if err := s.AddRevoked(id, &deadline); err != nil {
		t.Fatal(err)
	}
	if err := s.AddRevoked(id, &deadline); err != nil {
		t.Fatalf("second AddRevoked: %v", err)
	}
	// A revocation without a deadline is stronger and replaces the deadline.
	if err := s.AddRevoked(id, nil); err != nil {
		t.Fatal(err)
	}
	other := openAt(t, dir, now)
	defer other.Close()
	if !other.Revoked(id) {
		t.Fatal("revocation lost")
	}
	// 100 days later the entry must still be there: it has no deadline.
	far := openAt(t, dir, now.Add(100*24*time.Hour))
	defer far.Close()
	if !far.Revoked(id) {
		t.Fatal("a revocation without a deadline expired")
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
	dir2 := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir2, revokedFileName), []byte(`{"authorization_id":"zz"}`+"\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := Open(dir2, Options{}); err == nil || !strings.Contains(err.Error(), "authorization id") {
		t.Fatalf("corrupt revoked file: %v", err)
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

// TestAddRevokedExtendsDeadline covers the conservative merge of two revocations of one
// authorization: a later deadline must extend the earlier one, not be ignored or shorten it.
func TestAddRevokedExtendsDeadline(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "state")
	now := time.UnixMilli(1_793_016_000_000)
	s := openAt(t, dir, now)
	id := testID(0x44)
	first := now.Add(time.Hour).UnixMilli()
	second := now.Add(2 * time.Hour).UnixMilli()
	if err := s.AddRevoked(id, &first); err != nil {
		t.Fatal(err)
	}
	if err := s.AddRevoked(id, &second); err != nil {
		t.Fatal(err)
	}
	if !s.Revoked(id) {
		t.Fatal("revocation lost")
	}
	if err := s.Close(); err != nil {
		t.Fatal(err)
	}

	// Between the two deadlines the authorization stays revoked because of the extension.
	later := openAt(t, dir, now.Add(90*time.Minute))
	defer later.Close()
	if !later.Revoked(id) {
		t.Fatal("the later deadline did not extend the revocation")
	}

	// Past both deadlines the revocation is kept inside the seven-day retention margin.
	soon := openAt(t, dir, now.Add(3*time.Hour))
	if !soon.Revoked(id) {
		t.Fatal("a revocation inside the seven-day margin was dropped")
	}
	if err := soon.Close(); err != nil {
		t.Fatal(err)
	}

	// Past deadline+7d it is cleaned up.
	after := openAt(t, dir, now.Add(8*24*time.Hour))
	defer after.Close()
	if after.Revoked(id) {
		t.Fatal("a revocation past deadline+7d was kept")
	}
}

// TestTornLastLineIsIgnored covers a crash in the middle of an append: a final line without a
// trailing newline that does not parse is the remains of a write that never returned, so its
// task never ran. It is ignored and the compacted file no longer contains it.
func TestTornLastLineIsIgnored(t *testing.T) {
	dir := t.TempDir()
	now := time.UnixMilli(1_793_016_000_000)
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

// TestTornRevocationLineIsIgnored covers the same tolerance on the revocation list.
func TestTornRevocationLineIsIgnored(t *testing.T) {
	dir := t.TempDir()
	now := time.UnixMilli(1_793_016_000_000)
	deadline := now.Add(time.Hour).UnixMilli()
	good := fmt.Sprintf(`{"authorization_id":%q,"deadline_ms":%d}`, testIDHex(0x11), deadline) + "\n"
	torn := `{"authorization_id":"` + testIDHex(0x22) + `"`
	if err := os.WriteFile(filepath.Join(dir, revokedFileName), []byte(good+torn), 0o600); err != nil {
		t.Fatal(err)
	}
	s := openAt(t, dir, now)
	defer s.Close()
	if !s.Revoked(testID(0x11)) {
		t.Fatal("the complete revocation before the torn tail was dropped")
	}
	if s.Revoked(testID(0x22)) {
		t.Fatal("a torn revocation was loaded")
	}
}

// TestTornLineThatParsesIsKept covers a final line without a newline that is a complete record:
// the write may have been interrupted after the data reached the file, and the record is valid.
func TestTornLineThatParsesIsKept(t *testing.T) {
	dir := t.TempDir()
	now := time.UnixMilli(1_793_016_000_000)
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

// TestMalformedMiddleLineIsRefused covers the other side: any malformed line that is not the
// final, newline-less one stays a hard error.
func TestMalformedMiddleLineIsRefused(t *testing.T) {
	dir := t.TempDir()
	now := time.UnixMilli(1_793_016_000_000)
	good := fmt.Sprintf(`{"task_id":"t1","accepted_at_ms":%d}`, now.UnixMilli()) + "\n"
	if err := os.WriteFile(filepath.Join(dir, usedFileName), []byte("{not json\n"+good), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := Open(dir, Options{Now: func() time.Time { return now }}); err == nil || !strings.Contains(err.Error(), "line 1") {
		t.Fatalf("a malformed middle line: %v", err)
	}
	// A malformed final line that does end with a newline was written completely.
	dir2 := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir2, revokedFileName), []byte("{not json\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := Open(dir2, Options{}); err == nil || !strings.Contains(err.Error(), "line 1") {
		t.Fatalf("a malformed final line with a newline: %v", err)
	}
}
