package executor

import (
	"bytes"
	"errors"
	"io"
	"io/fs"
	"os"
	"sort"
	"strings"

	"github.com/Kodecable/ClusterRightHand/client/internal/proto/crhv1"
)

var utf8BOM = []byte{0xEF, 0xBB, 0xBF}

func fileEdit(s *crhv1.FileEditSpec, stdout io.Writer) error {
	path := s.GetPath()
	if err := checkPath(path); err != nil {
		return err
	}
	if len(s.GetEdits()) == 0 {
		return errf("invalid_spec", "edits must not be empty")
	}
	f, err := os.Open(path)
	if err != nil {
		return err
	}
	defer f.Close()
	fi, err := f.Stat()
	if err != nil {
		return err
	}
	if fi.IsDir() {
		return errf("is_directory", "%s is a directory", path)
	}
	if fi.Size() > maxEditSize {
		return errf("too_large", "%s is %d bytes, limit is %d", path, fi.Size(), maxEditSize)
	}
	raw, err := io.ReadAll(io.LimitReader(f, maxEditSize+1))
	if err != nil {
		return err
	}
	if len(raw) > maxEditSize {
		return errf("too_large", "%s exceeds %d bytes", path, maxEditSize)
	}

	var bom []byte
	if bytes.HasPrefix(raw, utf8BOM) {
		bom, raw = utf8BOM, raw[len(utf8BOM):]
	}
	text := string(raw)
	ending := detectLineEnding(text)
	out, err := applyEdits(normalizeToLF(text), s.GetEdits(), path)
	if err != nil {
		return err
	}
	if ending == "\r\n" {
		out = strings.ReplaceAll(out, "\n", "\r\n")
	}

	tmp, err := createTemp(path)
	if err != nil {
		return err
	}
	ok := false
	defer func() {
		if !ok {
			tmp.discard()
		}
	}()
	if _, err := tmp.Write(append(bom[:len(bom):len(bom)], out...)); err != nil {
		return err
	}
	uid, gid := statIDs(fi)
	if err := tmp.Chown(uid, gid); err != nil && !errors.Is(err, os.ErrPermission) {
		return err
	}
	if err := tmp.Chmod(fi.Mode() & (fs.ModePerm | fs.ModeSetuid | fs.ModeSetgid | fs.ModeSticky)); err != nil {
		return err
	}
	if err := tmp.publish(path, false); err != nil {
		return err
	}
	ok = true
	return writeJSON(stdout, map[string]any{"replacements": len(s.GetEdits())})
}

func detectLineEnding(s string) string {
	lf := strings.IndexByte(s, '\n')
	crlf := strings.Index(s, "\r\n")
	if lf == -1 || crlf == -1 || crlf > lf {
		return "\n"
	}
	return "\r\n"
}

func normalizeToLF(s string) string {
	s = strings.ReplaceAll(s, "\r\n", "\n")
	return strings.ReplaceAll(s, "\r", "\n")
}

type matchedEdit struct {
	index, start, length int
	newText              string
}

// applyEdits matches every edit against the original content (exactly once, without overlap)
// and applies them all at once.
func applyEdits(content string, edits []*crhv1.Edit, path string) (string, error) {
	var matched []matchedEdit
	for i, e := range edits {
		old := normalizeToLF(e.GetOldText())
		if old == "" {
			return "", errf("invalid_spec", "edits[%d].old_text must not be empty in %s", i, path)
		}
		idx := strings.Index(content, old)
		if idx < 0 {
			return "", errf("edit_no_match", "could not find edits[%d] in %s; old_text must match exactly including whitespace and newlines", i, path)
		}
		if n := strings.Count(content, old); n > 1 {
			return "", errf("edit_ambiguous", "found %d occurrences of edits[%d] in %s; add more context to make it unique", n, i, path)
		}
		matched = append(matched, matchedEdit{i, idx, len(old), normalizeToLF(e.GetNewText())})
	}
	sort.Slice(matched, func(a, b int) bool { return matched[a].start < matched[b].start })
	for i := 1; i < len(matched); i++ {
		if p, c := matched[i-1], matched[i]; p.start+p.length > c.start {
			return "", errf("edit_overlap", "edits[%d] and edits[%d] overlap in %s", p.index, c.index, path)
		}
	}
	var b strings.Builder
	pos := 0
	for _, m := range matched {
		b.WriteString(content[pos:m.start])
		b.WriteString(m.newText)
		pos = m.start + m.length
	}
	b.WriteString(content[pos:])
	out := b.String()
	if out == content {
		return "", errf("edit_no_change", "no changes made to %s; the replacements produced identical content", path)
	}
	return out, nil
}
