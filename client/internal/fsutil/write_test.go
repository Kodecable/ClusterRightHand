package fsutil

import (
	"errors"
	"os"
	"path/filepath"
	"testing"
)

func TestWriteFileReplacesWholeAndKeepsNoTemporary(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "f")
	if err := os.WriteFile(path, []byte("old"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := WriteFile(path, []byte("new"), 0o640, WriteOptions{}); err != nil {
		t.Fatal(err)
	}
	data, err := os.ReadFile(path)
	if err != nil || string(data) != "new" {
		t.Fatalf("content %q, %v", data, err)
	}
	if info, _ := os.Stat(path); info.Mode().Perm() != 0o640 {
		t.Fatalf("mode %v", info.Mode())
	}
	entries, _ := os.ReadDir(dir)
	if len(entries) != 1 {
		t.Fatalf("left behind: %v", entries)
	}
}

// A link at the old fixed temporary names is never followed: the temporary file is created exclusively
// under a random name.
func TestWriteFileNeverFollowsAPlantedLink(t *testing.T) {
	dir := t.TempDir()
	victim := filepath.Join(t.TempDir(), "victim")
	if err := os.WriteFile(victim, []byte("keep"), 0o600); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(dir, "node_id")
	for _, name := range []string{path + ".tmp", path + ".crha-new"} {
		if err := os.Symlink(victim, name); err != nil {
			t.Fatal(err)
		}
	}
	if err := WriteFile(path, []byte("id\n"), 0o644, WriteOptions{}); err != nil {
		t.Fatal(err)
	}
	if data, _ := os.ReadFile(victim); string(data) != "keep" {
		t.Fatalf("the link was followed: %q", data)
	}
}

func TestWriteFileExclusiveNeverReplaces(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "key")
	if err := WriteFile(path, []byte("first"), 0o600, WriteOptions{Exclusive: true}); err != nil {
		t.Fatal(err)
	}
	if err := WriteFile(path, []byte("second"), 0o600, WriteOptions{Exclusive: true}); !errors.Is(err, os.ErrExist) {
		t.Fatalf("err %v", err)
	}
	if data, _ := os.ReadFile(path); string(data) != "first" {
		t.Fatalf("replaced: %q", data)
	}
	if entries, _ := os.ReadDir(dir); len(entries) != 1 {
		t.Fatalf("left a temporary file: %v", entries)
	}
}
