package backup

import (
	"errors"
	"os"
	"path/filepath"
	"reflect"
	"slices"
	"testing"
	"time"
)

func write(t *testing.T, path, content string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(content), 0o640); err != nil {
		t.Fatal(err)
	}
}

func TestTakeRestoreAndModified(t *testing.T) {
	root, dir := t.TempDir(), t.TempDir()
	write(t, filepath.Join(root, "/etc/crha/crha.toml"), "old config")
	m, manifest, err := Take(Options{Root: root, Dir: dir, ID: UpgradeID("t1"), From: "1.2.0", To: "1.3.0", Units: []string{"crha.service"}},
		[]File{{Path: "/etc/crha/crha.toml", After: []byte("new config")}, {Path: "/etc/crha/added", After: []byte("x")}, {Path: "/absent"}})
	if err != nil {
		t.Fatal(err)
	}
	if m.Kind != KindUpgrade || filepath.Dir(manifest) != filepath.Join(dir, "task-t1") {
		t.Fatalf("manifest %+v at %s", m, manifest)
	}
	read, err := Read(manifest)
	if err != nil || !reflect.DeepEqual(read.Entries, m.Entries) {
		t.Fatalf("read %+v, %v", read, err)
	}
	// What the change wrote.
	write(t, filepath.Join(root, "/etc/crha/crha.toml"), "new config")
	write(t, filepath.Join(root, "/etc/crha/added"), "x")
	if mod, err := Modified(root, m); err != nil || len(mod) != 0 {
		t.Fatalf("modified %q, %v", mod, err)
	}
	write(t, filepath.Join(root, "/etc/crha/crha.toml"), "edited by hand")
	if mod, _ := Modified(root, m); !reflect.DeepEqual(mod, []string{"/etc/crha/crha.toml"}) {
		t.Fatalf("modified %q", mod)
	}
	if err := Restore(root, m); err != nil {
		t.Fatal(err)
	}
	if data, _ := os.ReadFile(filepath.Join(root, "/etc/crha/crha.toml")); string(data) != "old config" {
		t.Fatalf("restored %q", data)
	}
	if _, err := os.Stat(filepath.Join(root, "/etc/crha/added")); !errors.Is(err, os.ErrNotExist) {
		t.Fatal("a file the change added survived the restore")
	}
}

func TestPruneKeepsTheNewestOfEachKind(t *testing.T) {
	dir := t.TempDir()
	base := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	for i := 0; i < 4; i++ {
		if _, _, err := Take(Options{Dir: dir, ID: UpgradeID(string(rune('a' + i))), Now: base.Add(time.Duration(i) * time.Hour)}, nil); err != nil {
			t.Fatal(err)
		}
	}
	for i := 0; i < 7; i++ {
		when := base.Add(time.Duration(i) * time.Minute)
		if _, _, err := Take(Options{Dir: dir, ID: EnrollID(when), Now: when}, nil); err != nil {
			t.Fatal(err)
		}
	}
	// A failed upgrade's directory has no manifest, only its received binary: a fresh one stays, a
	// stale one goes, and neither counts.
	write(t, filepath.Join(dir, "task-fresh", "crha"), "binary")
	write(t, filepath.Join(dir, "task-stale", "crha"), "binary")
	now := time.Now()
	if err := os.Chtimes(filepath.Join(dir, "task-stale"), now.Add(-2*StaleAfter), now.Add(-2*StaleAfter)); err != nil {
		t.Fatal(err)
	}
	if err := Prune(dir, KindUpgrade, now, UpgradeID("a")); err != nil {
		t.Fatal(err)
	}
	if err := Prune(dir, KindEnroll, now); err != nil {
		t.Fatal(err)
	}
	entries, _ := os.ReadDir(dir)
	var names []string
	for _, e := range entries {
		names = append(names, e.Name())
	}
	upgrades, enrolls := 0, 0
	for _, n := range names {
		switch kindOf(n) {
		case KindUpgrade:
			upgrades++
		case KindEnroll:
			enrolls++
		}
	}
	// The oldest, task-a, is excepted; of the three others the newest two stay, and task-fresh.
	if upgrades != 4 || enrolls != 5 || !slices.Contains(names, "task-a") || !slices.Contains(names, "task-fresh") || slices.Contains(names, "task-stale") || slices.Contains(names, "task-b") {
		t.Fatalf("kept %q", names)
	}
	for _, want := range []string{"task-fresh", "task-d", "task-c"} {
		if _, err := os.Stat(filepath.Join(dir, want)); err != nil {
			t.Fatalf("%s was pruned", want)
		}
	}
}
