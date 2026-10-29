package executor

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/Kodecable/ClusterRightHand/client/internal/protocol"
)

func run(t *testing.T, kind any, input io.Reader) (map[string]any, error) {
	t.Helper()
	spec := &protocol.TaskSpec{}
	switch k := kind.(type) {
	case *protocol.FileReadSpec:
		spec.Kind, spec.FileRead = protocol.TaskSpecFileRead, k
	case *protocol.FileWriteSpec:
		spec.Kind, spec.FileWrite = protocol.TaskSpecFileWrite, k
	case *protocol.FileEditSpec:
		spec.Kind, spec.FileEdit = protocol.TaskSpecFileEdit, k
	case *protocol.FileStatSpec:
		spec.Kind, spec.FileStat = protocol.TaskSpecFileStat, k
	case *protocol.FileListSpec:
		spec.Kind, spec.FileList = protocol.TaskSpecFileList, k
	}
	var out bytes.Buffer
	err := RunFile(context.Background(), spec, input, &out)
	if err != nil {
		return nil, err
	}
	var m map[string]any
	if out.Len() > 0 && json.Unmarshal(out.Bytes(), &m) != nil {
		m = map[string]any{"raw": out.String()}
	}
	return m, nil
}

func wantCode(t *testing.T, err error, code string) {
	t.Helper()
	var e *Error
	if !errors.As(err, &e) || e.Code != code {
		t.Fatalf("want error code %q, got %v", code, err)
	}
}

func writeFile(t *testing.T, path, content string, mode os.FileMode) {
	t.Helper()
	if err := os.WriteFile(path, []byte(content), mode); err != nil {
		t.Fatal(err)
	}
	os.Chmod(path, mode)
}

func readFileStr(t *testing.T, path string) string {
	t.Helper()
	b, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	return string(b)
}

func writeSpec(path, content string) *protocol.FileWriteSpec {
	sum := sha256.Sum256([]byte(content))
	return &protocol.FileWriteSpec{Path: path, Content: protocol.InputRef{Size: protocol.Uint(len(content)), SHA256: protocol.Hash(sum)}}
}

func noTemps(t *testing.T, dir string) {
	t.Helper()
	des, _ := os.ReadDir(dir)
	for _, de := range des {
		if strings.Contains(de.Name(), ".crh-") {
			t.Fatalf("leftover temp file %s", de.Name())
		}
	}
}

func TestFileInvalidPath(t *testing.T) {
	for _, p := range []string{"rel/path", "/a/../b", "/a//b", "/a/"} {
		_, err := run(t, &protocol.FileStatSpec{Path: p}, nil)
		wantCode(t, err, "invalid_spec")
	}
}

func TestFileRead(t *testing.T) {
	dir := t.TempDir()
	p := filepath.Join(dir, "f")
	writeFile(t, p, "0123456789", 0o644)

	read := func(off, lim uint64) string {
		var out bytes.Buffer
		spec := &protocol.TaskSpec{Kind: protocol.TaskSpecFileRead, FileRead: &protocol.FileReadSpec{Path: p, Offset: protocol.Uint(off), Limit: protocol.Uint(lim)}}
		if err := RunFile(context.Background(), spec, nil, &out); err != nil {
			t.Fatal(err)
		}
		return out.String()
	}
	if got := read(0, 0); got != "0123456789" {
		t.Fatalf("full: %q", got)
	}
	if got := read(3, 4); got != "3456" {
		t.Fatalf("range: %q", got)
	}
	if got := read(8, 100); got != "89" {
		t.Fatalf("tail: %q", got)
	}
	if got := read(20, 0); got != "" {
		t.Fatalf("past eof: %q", got)
	}

	_, err := run(t, &protocol.FileReadSpec{Path: dir}, nil)
	wantCode(t, err, "is_directory")
	_, err = run(t, &protocol.FileReadSpec{Path: filepath.Join(dir, "nope")}, nil)
	wantCode(t, err, "not_found")
}

func TestFileReadCancelled(t *testing.T) {
	p := filepath.Join(t.TempDir(), "f")
	writeFile(t, p, "x", 0o644)
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	spec := &protocol.TaskSpec{Kind: protocol.TaskSpecFileRead, FileRead: &protocol.FileReadSpec{Path: p}}
	wantCode(t, RunFile(ctx, spec, nil, io.Discard), "cancelled")
}

func TestFileWriteCreate(t *testing.T) {
	dir := t.TempDir()
	p := filepath.Join(dir, "new")
	out, err := run(t, writeSpec(p, "hello"), strings.NewReader("hello"))
	if err != nil {
		t.Fatal(err)
	}
	if out["bytes"] != float64(5) || out["created"] != true {
		t.Fatalf("out: %v", out)
	}
	if readFileStr(t, p) != "hello" {
		t.Fatal("content")
	}
	if fi, _ := os.Stat(p); fi.Mode().Perm() != 0o644 {
		t.Fatalf("mode %v", fi.Mode())
	}
	noTemps(t, dir)
}

func TestFileWriteExplicitMode(t *testing.T) {
	p := filepath.Join(t.TempDir(), "new")
	s := writeSpec(p, "x")
	s.Mode = 0o600
	if _, err := run(t, s, strings.NewReader("x")); err != nil {
		t.Fatal(err)
	}
	if fi, _ := os.Stat(p); fi.Mode().Perm() != 0o600 {
		t.Fatalf("mode %v", fi.Mode())
	}
}

func TestFileWriteExists(t *testing.T) {
	dir := t.TempDir()
	p := filepath.Join(dir, "f")
	writeFile(t, p, "old", 0o644)
	_, err := run(t, writeSpec(p, "new"), strings.NewReader("new"))
	wantCode(t, err, "exists")
	if readFileStr(t, p) != "old" {
		t.Fatal("file was modified")
	}
	noTemps(t, dir)
}

func TestFileWriteOverwriteKeepsMode(t *testing.T) {
	dir := t.TempDir()
	p := filepath.Join(dir, "f")
	writeFile(t, p, "old", 0o640)
	s := writeSpec(p, "new")
	s.Overwrite = true
	out, err := run(t, s, strings.NewReader("new"))
	if err != nil {
		t.Fatal(err)
	}
	if out["created"] != false {
		t.Fatalf("out: %v", out)
	}
	if readFileStr(t, p) != "new" {
		t.Fatal("content")
	}
	if fi, _ := os.Stat(p); fi.Mode().Perm() != 0o640 {
		t.Fatalf("mode %v", fi.Mode())
	}
	noTemps(t, dir)
}

func TestFileWriteMismatch(t *testing.T) {
	dir := t.TempDir()
	p := filepath.Join(dir, "f")
	for name, in := range map[string]string{"short": "hel", "long": "hello!!", "hash": "jello"} {
		t.Run(name, func(t *testing.T) {
			_, err := run(t, writeSpec(p, "hello"), strings.NewReader(in))
			wantCode(t, err, "input_mismatch")
			if _, err := os.Lstat(p); !os.IsNotExist(err) {
				t.Fatal("target created")
			}
			noTemps(t, dir)
		})
	}
}

func TestFileWriteErrors(t *testing.T) {
	dir := t.TempDir()
	_, err := run(t, writeSpec(filepath.Join(dir, "missing", "f"), "x"), strings.NewReader("x"))
	wantCode(t, err, "not_found")

	s := writeSpec(dir, "x")
	s.Overwrite = true
	_, err = run(t, s, strings.NewReader("x"))
	wantCode(t, err, "is_directory")

	s = writeSpec(filepath.Join(dir, "f"), "x")
	s.Owner = "no-such-user-crh"
	_, err = run(t, s, strings.NewReader("x"))
	wantCode(t, err, "invalid_spec")
	noTemps(t, dir)
}

func edit(t *testing.T, path string, pairs ...string) (map[string]any, error) {
	t.Helper()
	s := &protocol.FileEditSpec{Path: path}
	for i := 0; i < len(pairs); i += 2 {
		s.Edits = append(s.Edits, protocol.Edit{OldText: pairs[i], NewText: pairs[i+1]})
	}
	return run(t, s, nil)
}

func TestFileEditBasic(t *testing.T) {
	dir := t.TempDir()
	p := filepath.Join(dir, "f")
	writeFile(t, p, "alpha\nbeta\ngamma\n", 0o750)
	out, err := edit(t, p, "gamma", "GAMMA", "alpha", "ALPHA")
	if err != nil {
		t.Fatal(err)
	}
	if out["replacements"] != float64(2) {
		t.Fatalf("out: %v", out)
	}
	if got := readFileStr(t, p); got != "ALPHA\nbeta\nGAMMA\n" {
		t.Fatalf("got %q", got)
	}
	if fi, _ := os.Stat(p); fi.Mode().Perm() != 0o750 {
		t.Fatalf("mode %v", fi.Mode())
	}
	noTemps(t, dir)
}

func TestFileEditAgainstOriginal(t *testing.T) {
	p := filepath.Join(t.TempDir(), "f")
	writeFile(t, p, "a b\n", 0o644)
	// the second edit's old text only exists in the first edit's replacement
	_, err := edit(t, p, "a", "b", "x", "y")
	wantCode(t, err, "edit_no_match")
	// swap: both match the original
	if _, err := edit(t, p, "a", "b", "b", "a"); err != nil {
		t.Fatal(err)
	}
	if got := readFileStr(t, p); got != "b a\n" {
		t.Fatalf("got %q", got)
	}
}

func TestFileEditCRLF(t *testing.T) {
	p := filepath.Join(t.TempDir(), "f")
	writeFile(t, p, "one\r\ntwo\r\nthree\r\n", 0o644)
	if _, err := edit(t, p, "one\ntwo", "1\n2\n2.5"); err != nil {
		t.Fatal(err)
	}
	if got := readFileStr(t, p); got != "1\r\n2\r\n2.5\r\nthree\r\n" {
		t.Fatalf("got %q", got)
	}
}

func TestFileEditBOM(t *testing.T) {
	p := filepath.Join(t.TempDir(), "f")
	writeFile(t, p, "\xEF\xBB\xBFhello\n", 0o644)
	if _, err := edit(t, p, "hello", "bye"); err != nil {
		t.Fatal(err)
	}
	if got := readFileStr(t, p); got != "\xEF\xBB\xBFbye\n" {
		t.Fatalf("got %q", got)
	}
}

func TestFileEditErrors(t *testing.T) {
	dir := t.TempDir()
	p := filepath.Join(dir, "f")
	writeFile(t, p, "foo bar foo\nbaz\n", 0o644)

	_, err := edit(t, p, "nothing", "x")
	wantCode(t, err, "edit_no_match")
	_, err = edit(t, p, "foo", "x")
	wantCode(t, err, "edit_ambiguous")
	_, err = edit(t, p, "bar foo", "x", "foo bar", "y")
	wantCode(t, err, "edit_overlap")
	_, err = edit(t, p, "", "x")
	wantCode(t, err, "invalid_spec")
	_, err = edit(t, p)
	wantCode(t, err, "invalid_spec")
	_, err = edit(t, p, "baz", "baz")
	wantCode(t, err, "edit_no_change")
	_, err = edit(t, filepath.Join(dir, "missing"), "a", "b")
	wantCode(t, err, "not_found")
	_, err = edit(t, dir, "a", "b")
	wantCode(t, err, "is_directory")

	if got := readFileStr(t, p); got != "foo bar foo\nbaz\n" {
		t.Fatalf("file modified: %q", got)
	}
	noTemps(t, dir)

	_, err = edit(t, p, "bar", "x", "foo bar foo", "y")
	wantCode(t, err, "edit_overlap")
}

func TestFileEditTooLarge(t *testing.T) {
	p := filepath.Join(t.TempDir(), "big")
	f, _ := os.Create(p)
	f.Truncate(maxEditSize + 1)
	f.Close()
	_, err := edit(t, p, "a", "b")
	wantCode(t, err, "too_large")
}

func TestFileStat(t *testing.T) {
	dir := t.TempDir()
	p := filepath.Join(dir, "f")
	writeFile(t, p, "abc", 0o640)
	out, err := run(t, &protocol.FileStatSpec{Path: p}, nil)
	if err != nil {
		t.Fatal(err)
	}
	if out["type"] != "file" || out["size"] != float64(3) || out["mode"] != "0640" || out["path"] != p {
		t.Fatalf("out: %v", out)
	}
	if _, ok := out["link_target"]; ok {
		t.Fatal("unexpected link_target")
	}
	if _, err := os.Stat(p); err != nil || out["mtime"] == "" {
		t.Fatal("mtime")
	}

	out, _ = run(t, &protocol.FileStatSpec{Path: dir}, nil)
	if out["type"] != "dir" {
		t.Fatalf("out: %v", out)
	}

	_, err = run(t, &protocol.FileStatSpec{Path: filepath.Join(dir, "nope")}, nil)
	wantCode(t, err, "not_found")
}

func TestFileStatSymlink(t *testing.T) {
	dir := t.TempDir()
	l := filepath.Join(dir, "l")
	if err := os.Symlink("/nonexistent/target", l); err != nil {
		t.Fatal(err)
	}
	out, err := run(t, &protocol.FileStatSpec{Path: l}, nil)
	if err != nil {
		t.Fatal(err)
	}
	if out["type"] != "symlink" || out["link_target"] != "/nonexistent/target" {
		t.Fatalf("out: %v", out)
	}
}

func TestFileList(t *testing.T) {
	dir := t.TempDir()
	for _, n := range []string{"c", "a", "b", "d"} {
		writeFile(t, filepath.Join(dir, n), n, 0o644)
	}
	os.Mkdir(filepath.Join(dir, "sub"), 0o755)
	os.Symlink("a", filepath.Join(dir, "ln"))

	names := func(out map[string]any) []string {
		var ns []string
		for _, e := range out["entries"].([]any) {
			ns = append(ns, e.(map[string]any)["name"].(string))
		}
		return ns
	}
	out, err := run(t, &protocol.FileListSpec{Path: dir}, nil)
	if err != nil {
		t.Fatal(err)
	}
	if got := fmt.Sprint(names(out)); got != "[a b c d ln sub]" || out["truncated"] != false {
		t.Fatalf("got %s %v", got, out["truncated"])
	}
	types := map[string]string{}
	for _, e := range out["entries"].([]any) {
		m := e.(map[string]any)
		types[m["name"].(string)] = m["type"].(string)
	}
	if types["a"] != "file" || types["sub"] != "dir" || types["ln"] != "symlink" {
		t.Fatalf("types: %v", types)
	}

	out, _ = run(t, &protocol.FileListSpec{Path: dir, Limit: 2}, nil)
	if got := fmt.Sprint(names(out)); got != "[a b]" || out["truncated"] != true {
		t.Fatalf("got %s %v", got, out["truncated"])
	}
	out, _ = run(t, &protocol.FileListSpec{Path: dir, Limit: 6}, nil)
	if out["truncated"] != false {
		t.Fatal("exact limit must not truncate")
	}

	_, err = run(t, &protocol.FileListSpec{Path: filepath.Join(dir, "a")}, nil)
	wantCode(t, err, "not_a_directory")
	_, err = run(t, &protocol.FileListSpec{Path: filepath.Join(dir, "nope")}, nil)
	wantCode(t, err, "not_found")
}

func TestFileListEmpty(t *testing.T) {
	out, err := run(t, &protocol.FileListSpec{Path: t.TempDir()}, nil)
	if err != nil {
		t.Fatal(err)
	}
	if es, ok := out["entries"].([]any); !ok || len(es) != 0 {
		t.Fatalf("entries: %v", out["entries"])
	}
}
