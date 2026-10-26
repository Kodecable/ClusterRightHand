package janitor

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

var base = time.Date(2026, 1, 10, 0, 0, 0, 0, time.UTC)

func name(n int) string { return fmt.Sprintf("0190a000-0000-7000-8000-%012d.log", n) }

func write(t *testing.T, dir, file string, size int, age time.Duration) string {
	t.Helper()
	p := filepath.Join(dir, file)
	if err := os.WriteFile(p, []byte(strings.Repeat("x", size)), 0o600); err != nil {
		t.Fatal(err)
	}
	mt := base.Add(-age)
	if err := os.Chtimes(p, mt, mt); err != nil {
		t.Fatal(err)
	}
	return p
}

func exists(p string) bool {
	_, err := os.Lstat(p)
	return err == nil
}

func opts(dir string) Options {
	return Options{Dir: dir, Now: func() time.Time { return base }}
}

func TestExpiry(t *testing.T) {
	dir := t.TempDir()
	old := write(t, dir, name(1), 10, 48*time.Hour)
	fresh := write(t, dir, name(2), 10, time.Hour)
	o := opts(dir)
	o.MaxAge = 24 * time.Hour
	files, bytes, err := Sweep(o)
	if err != nil || files != 1 || bytes != 10 {
		t.Fatalf("got %d %d %v", files, bytes, err)
	}
	if exists(old) || !exists(fresh) {
		t.Fatal("wrong files removed")
	}
}

func TestMaxTotalOldestFirst(t *testing.T) {
	dir := t.TempDir()
	a := write(t, dir, name(1), 10, 3*time.Hour)
	b := write(t, dir, name(2), 10, 2*time.Hour)
	c := write(t, dir, name(3), 10, time.Hour)
	o := opts(dir)
	o.MaxTotal = 15
	files, bytes, err := Sweep(o)
	if err != nil || files != 2 || bytes != 20 {
		t.Fatalf("got %d %d %v", files, bytes, err)
	}
	if exists(a) || exists(b) || !exists(c) {
		t.Fatal("wrong files removed")
	}
}

func TestInUse(t *testing.T) {
	dir := t.TempDir()
	a := write(t, dir, name(1), 10, 100*time.Hour)
	b := write(t, dir, name(2), 10, 2*time.Hour)
	c := write(t, dir, name(3), 10, time.Hour)
	o := opts(dir)
	o.MaxAge = 24 * time.Hour
	o.MaxTotal = 5
	o.InUse = func() map[string]bool { return map[string]bool{a: true, b: true} }
	files, _, err := Sweep(o)
	if err != nil || files != 1 {
		t.Fatalf("got %d %v", files, err)
	}
	if !exists(a) || !exists(b) || exists(c) {
		t.Fatal("wrong files removed")
	}
}

func TestIgnoresUnrelated(t *testing.T) {
	dir := t.TempDir()
	other := write(t, dir, "notes.txt", 10, 1000*time.Hour)
	badName := write(t, dir, "0190A000-0000-7000-8000-000000000001.log", 10, 1000*time.Hour)
	target := write(t, t.TempDir(), name(9), 10, 1000*time.Hour)
	link := filepath.Join(dir, name(1))
	if err := os.Symlink(target, link); err != nil {
		t.Fatal(err)
	}
	sub := filepath.Join(dir, name(2))
	if err := os.Mkdir(sub, 0o700); err != nil {
		t.Fatal(err)
	}
	inner := write(t, sub, name(3), 10, 1000*time.Hour)
	o := opts(dir)
	o.MaxAge = time.Hour
	o.MaxTotal = 1
	files, _, err := Sweep(o)
	if err != nil || files != 0 {
		t.Fatalf("got %d %v", files, err)
	}
	for _, p := range []string{other, badName, target, inner, sub} {
		if !exists(p) {
			t.Fatalf("%s removed", p)
		}
	}
	if _, err := os.Lstat(link); err != nil {
		t.Fatal("symlink removed")
	}
}

func TestMissingDir(t *testing.T) {
	o := opts(filepath.Join(t.TempDir(), "nope"))
	o.MaxAge = time.Hour
	if files, bytes, err := Sweep(o); err != nil || files != 0 || bytes != 0 {
		t.Fatalf("got %d %d %v", files, bytes, err)
	}
}

func TestRunStopsOnCancel(t *testing.T) {
	dir := t.TempDir()
	old := write(t, dir, name(1), 10, 48*time.Hour)
	o := opts(dir)
	o.MaxAge = time.Hour
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() {
		Run(ctx, o, 10*time.Millisecond)
		close(done)
	}()
	deadline := time.Now().Add(5 * time.Second)
	for exists(old) && time.Now().Before(deadline) {
		time.Sleep(5 * time.Millisecond)
	}
	if exists(old) {
		t.Fatal("initial sweep did not run")
	}
	cancel()
	select {
	case <-done:
	case <-time.After(5 * time.Second):
		t.Fatal("Run did not stop")
	}
}
