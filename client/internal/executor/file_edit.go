package executor

import (
	"bytes"
	"errors"
	"io"
	"os"
	"sort"
	"strings"

	"golang.org/x/sys/unix"

	"github.com/Kodecable/ClusterRightHand/client/internal/protocol"
)

var utf8BOM = []byte{0xEF, 0xBB, 0xBF}

// fileEdit executes a file.edit task: it opens a regular file as the mode permits, applies every
// edit to the original content at once, and publishes the result with the file's own mode and owner.
func fileEdit(acc fileAccess, s *protocol.FileEditSpec) (*protocol.TaskResult, error) {
	path := s.Path
	if err := checkPath(path); err != nil {
		return nil, err
	}
	if len(s.Edits) == 0 {
		return nil, errf(protocol.CodeInvalidSpec, "edits must not be empty")
	}
	t, err := acc.openWrite(path, true)
	if err != nil {
		return nil, err
	}
	defer t.dir.Close()
	f, err := acc.openExisting(t)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	fi, err := f.Stat()
	if err != nil {
		return nil, err
	}
	if err := checkRegular(fi, path); err != nil {
		return nil, err
	}
	if err := clearNonblocking(f); err != nil {
		return nil, err
	}
	if fi.Size() > maxEditSize {
		return nil, errf(protocol.CodeTooLarge, "%s is %d bytes, limit is %d", path, fi.Size(), maxEditSize)
	}
	raw, err := io.ReadAll(io.LimitReader(f, maxEditSize+1))
	if err != nil {
		return nil, err
	}
	if len(raw) > maxEditSize {
		return nil, errf(protocol.CodeTooLarge, "%s exceeds %d bytes", path, maxEditSize)
	}

	var bom []byte
	if bytes.HasPrefix(raw, utf8BOM) {
		bom, raw = utf8BOM, raw[len(utf8BOM):]
	}
	text := string(raw)
	ending := detectLineEnding(text)
	out, err := applyEdits(text, s.Edits, ending, path)
	if err != nil {
		return nil, err
	}

	tmpName, tmp, err := createTempAt(t.dir, t.name)
	if err != nil {
		return nil, err
	}
	ok := false
	defer func() {
		if !ok {
			tmp.Close()
			_ = unix.Unlinkat(int(t.dir.Fd()), tmpName, 0)
		}
	}()
	if _, err := tmp.Write(append(bom[:len(bom):len(bom)], out...)); err != nil {
		return nil, err
	}
	uid, gid := statIDs(fi)
	ownerKept, groupKept := true, true
	if err := tmp.Chown(uid, gid); err != nil {
		if !errors.Is(err, os.ErrPermission) {
			return nil, err
		}
		// Best effort: only root can usually restore another owner. The mode must not keep bits that
		// would grant that owner's rights to this file's actual owner.
		ownerKept, groupKept = false, false
	}
	if err := tmp.Chmod(modeAfterOwnerRestore(editMode(statMode(fi)), ownerKept, groupKept)); err != nil {
		return nil, err
	}
	if err := publishAt(t.dir, tmpName, tmp, t.name, path, false); err != nil {
		return nil, err
	}
	ok = true
	return &protocol.TaskResult{Kind: protocol.TaskResultFileEdit, FileEdit: &protocol.FileEditResult{
		Replacements: protocol.Uint(len(s.Edits)),
	}}, nil
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

// normalizeWithOffsets applies normalizeToLF and maps every normalized byte offset back to the
// original, so an edit can replace only the bytes its match came from.
func normalizeWithOffsets(s string) (string, []int) {
	var b strings.Builder
	b.Grow(len(s))
	offsets := make([]int, 0, len(s)+1)
	for i := 0; i < len(s); {
		offsets = append(offsets, i)
		if s[i] == '\r' {
			b.WriteByte('\n')
			if i+1 < len(s) && s[i+1] == '\n' {
				i += 2
			} else {
				i++
			}
			continue
		}
		b.WriteByte(s[i])
		i++
	}
	offsets = append(offsets, len(s))
	return b.String(), offsets
}

// applyEdits matches every edit against the original content (exactly once, without overlap) and
// applies them all at once. Matching treats CRLF and LF as equal; only the matched span changes, so
// a lone CR elsewhere in the file is left byte-for-byte, and the replacement uses the file's ending.
func applyEdits(content string, edits []protocol.Edit, ending, path string) (string, error) {
	normalized, offsets := normalizeWithOffsets(content)
	var matched []matchedEdit
	for i := range edits {
		e := &edits[i]
		old := normalizeToLF(e.OldText)
		if old == "" {
			return "", errf(protocol.CodeInvalidSpec, "edits[%d].old_text must not be empty in %s", i, path)
		}
		idx := strings.Index(normalized, old)
		if idx < 0 {
			return "", errf(protocol.CodeEditNoMatch, "could not find edits[%d] in %s; old_text must match exactly including whitespace and newlines", i, path)
		}
		if n := strings.Count(normalized, old); n > 1 {
			return "", errf(protocol.CodeEditAmbiguous, "found %d occurrences of edits[%d] in %s; add more context to make it unique", n, i, path)
		}
		start, end := offsets[idx], offsets[idx+len(old)]
		newText := strings.ReplaceAll(normalizeToLF(e.NewText), "\n", ending)
		matched = append(matched, matchedEdit{i, start, end - start, newText})
	}
	sort.Slice(matched, func(a, b int) bool { return matched[a].start < matched[b].start })
	for i := 1; i < len(matched); i++ {
		if p, c := matched[i-1], matched[i]; p.start+p.length > c.start {
			return "", errf(protocol.CodeEditOverlap, "edits[%d] and edits[%d] overlap in %s", p.index, c.index, path)
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
		return "", errf(protocol.CodeEditNoChange, "no changes made to %s; the replacements produced identical content", path)
	}
	return out, nil
}
