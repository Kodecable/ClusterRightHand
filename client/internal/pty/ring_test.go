package pty

import (
	"bytes"
	"testing"
)

func TestRingWrapAround(t *testing.T) {
	r := NewRing(8)
	if r.Capacity() != 8 {
		t.Fatalf("capacity = %d, want 8", r.Capacity())
	}
	r.Write([]byte("0123"))
	r.Write([]byte("45678"))
	// The ring keeps the latest eight bytes, oldest first, across the wrap.
	if got, want := string(mustSnapshot(t, r)), "12345678"; got != want {
		t.Fatalf("snapshot = %q, want %q", got, want)
	}
	if got, want := r.Len(), 8; got != want {
		t.Fatalf("len = %d, want %d", got, want)
	}
	if got, want := r.Total(), uint64(9); got != want {
		t.Fatalf("total = %d, want %d", got, want)
	}
}

func TestRingSnapshotOrder(t *testing.T) {
	r := NewRing(5)
	for _, s := range []string{"ab", "cd", "ef", "gh", "ij"} {
		r.Write([]byte(s))
	}
	if got, want := string(mustSnapshot(t, r)), "fghij"; got != want {
		t.Fatalf("snapshot = %q, want %q", got, want)
	}
	// ReadFrom returns the same suffix at its absolute offset; anything older is gone.
	for _, tc := range []struct {
		off  uint64
		want string
		ok   bool
	}{
		{0, "", false},
		{4, "", false},
		{5, "fghij", true},
		{7, "hij", true},
		{10, "", true},
	} {
		data, ok := r.ReadFrom(tc.off)
		if ok != tc.ok || string(data) != tc.want {
			t.Fatalf("ReadFrom(%d) = %q, %v; want %q, %v", tc.off, data, ok, tc.want, tc.ok)
		}
	}
}

func TestRingLargeWriteKeepsTail(t *testing.T) {
	r := NewRing(4)
	r.Write([]byte("abcdefgh"))
	if got, want := string(mustSnapshot(t, r)), "efgh"; got != want {
		t.Fatalf("snapshot = %q, want %q", got, want)
	}
	data, _ := r.ReadFrom(6)
	if got, want := string(data), "gh"; got != want {
		t.Fatalf("ReadFrom(6) = %q, want %q", got, want)
	}
}

func TestRingSnapshotIsACopy(t *testing.T) {
	r := NewRing(4)
	r.Write([]byte("abcd"))
	data := mustSnapshot(t, r)
	data[0] = 'z'
	if got := string(mustSnapshot(t, r)); got != "abcd" {
		t.Fatalf("snapshot shares memory with the ring: %q", got)
	}
	if data, _ := r.ReadFrom(0); !bytes.Equal(data, []byte("abcd")) {
		t.Fatalf("ReadFrom = %q", data)
	}
}

func TestRingCapacityClamp(t *testing.T) {
	for _, tc := range []struct {
		requested uint64
		want      int
	}{
		{0, MinScrollbackBytes},
		{1, MinScrollbackBytes},
		{MinScrollbackBytes - 1, MinScrollbackBytes},
		{MinScrollbackBytes, MinScrollbackBytes},
		{MinScrollbackBytes + 1, MinScrollbackBytes + 1},
		{MaxScrollbackBytes, MaxScrollbackBytes},
		{MaxScrollbackBytes + 1, MaxScrollbackBytes},
		{64 << 30, MaxScrollbackBytes},
	} {
		if got := clampScrollback(tc.requested); got != tc.want {
			t.Errorf("clampScrollback(%d) = %d, want %d", tc.requested, got, tc.want)
		}
	}
}

func TestRingWake(t *testing.T) {
	r := NewRing(4)
	select {
	case <-r.Wake():
		t.Fatal("a new ring signalled output")
	default:
	}
	r.Write([]byte("x"))
	select {
	case <-r.Wake():
	default:
		t.Fatal("Write did not signal Wake")
	}
	// The signal is a level, not a queue: a second write before the wake is consumed coalesces.
	r.Write([]byte("y"))
	if len(r.Wake()) != 1 {
		t.Fatalf("wake channel holds %d signals, want 1", len(r.Wake()))
	}
}

func mustSnapshot(t *testing.T, r *Ring) []byte {
	t.Helper()
	data, _ := r.Snapshot()
	return data
}

func TestRingReadAtLimit(t *testing.T) {
	r := NewRing(8)
	r.Write([]byte("abcdefghij"))
	data, ok := r.ReadAt(2, 4)
	if !ok || string(data) != "cdef" {
		t.Fatalf("ReadAt(2, 4) = %q, %v; want cdef, true", data, ok)
	}
	data, ok = r.ReadAt(9, 4)
	if !ok || string(data) != "j" {
		t.Fatalf("ReadAt(9, 4) = %q, %v; want j, true", data, ok)
	}
	if _, ok := r.ReadAt(1, 4); ok {
		t.Fatal("ReadAt of a lost offset reported ok")
	}
}
