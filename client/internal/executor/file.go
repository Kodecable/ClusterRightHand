// Package executor runs tasks on the node.
package executor

import (
	"bufio"
	"bytes"
	"context"
	"crypto/rand"
	"crypto/sha256"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"os/user"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"syscall"
	"time"

	"golang.org/x/sys/unix"

	"github.com/Kodecable/ClusterRightHand/client/internal/protocol"
)

const (
	maxEditSize      = 16 << 20
	defaultListLimit = 500
	maxListLimit     = 5000
	copyChunk        = 64 << 10
)

// Error is a task failure reported to crhs as TaskError{code, message}.
type Error struct{ Code, Message string }

func (e *Error) Error() string { return e.Code + ": " + e.Message }

func errf(code, format string, args ...any) *Error {
	return &Error{Code: code, Message: fmt.Sprintf(format, args...)}
}

// RunFile executes a file.* task. stdout receives the task's text output (the page of a file.read)
// and input carries the file.write content (nil for other kinds). It returns the task's structured
// result, or nil with an *Error (other errors are wrapped into Error{Code: "io_error"}).
func RunFile(ctx context.Context, spec *protocol.TaskSpec, input io.Reader, stdout io.Writer) (*protocol.TaskResult, error) {
	var result *protocol.TaskResult
	var err error
	switch spec.Kind {
	case protocol.TaskSpecFileRead:
		if spec.FileRead == nil {
			return nil, errf("invalid_spec", "file.read task has no spec")
		}
		result, err = fileRead(ctx, spec.FileRead, stdout)
	case protocol.TaskSpecFileWrite:
		if spec.FileWrite == nil {
			return nil, errf("invalid_spec", "file.write task has no spec")
		}
		result, err = fileWrite(ctx, spec.FileWrite, input, stdout)
	case protocol.TaskSpecFileEdit:
		if spec.FileEdit == nil {
			return nil, errf("invalid_spec", "file.edit task has no spec")
		}
		result, err = fileEdit(spec.FileEdit)
	case protocol.TaskSpecFileStat:
		if spec.FileStat == nil {
			return nil, errf("invalid_spec", "file.stat task has no spec")
		}
		result, err = fileStat(spec.FileStat)
	case protocol.TaskSpecFileList:
		if spec.FileList == nil {
			return nil, errf("invalid_spec", "file.list task has no spec")
		}
		result, err = fileList(ctx, spec.FileList)
	default:
		err = errf("invalid_spec", "not a file task: %q", spec.Kind)
	}
	return result, normalizeErr(err)
}

func normalizeErr(err error) error {
	var te *Error
	switch {
	case err == nil:
		return nil
	case errors.As(err, &te):
		return te
	case errors.Is(err, context.Canceled), errors.Is(err, context.DeadlineExceeded):
		return errf("cancelled", "%v", err)
	default:
		return mapErr(err)
	}
}

func mapErr(err error) *Error {
	switch {
	case errors.Is(err, fs.ErrNotExist):
		return errf("not_found", "%v", err)
	case errors.Is(err, fs.ErrPermission):
		return errf("permission_denied", "%v", err)
	case errors.Is(err, syscall.EISDIR):
		return errf("is_directory", "%v", err)
	case errors.Is(err, syscall.ENOTDIR):
		return errf("not_found", "%v", err)
	}
	return errf("io_error", "%v", err)
}

func checkPath(p string) error {
	if !filepath.IsAbs(p) || filepath.Clean(p) != p {
		return errf("invalid_spec", "path must be absolute and clean: %q", p)
	}
	return nil
}

// copyCtx copies src to dst in chunks, checking ctx between chunks.
func copyCtx(ctx context.Context, dst io.Writer, src io.Reader) (int64, error) {
	buf := make([]byte, copyChunk)
	var total int64
	for {
		if err := ctx.Err(); err != nil {
			return total, err
		}
		n, rerr := src.Read(buf)
		if n > 0 {
			m, werr := dst.Write(buf[:n])
			total += int64(m)
			if werr != nil {
				return total, werr
			}
		}
		if rerr == io.EOF {
			return total, nil
		}
		if rerr != nil {
			// A cancelled task's input reader fails because the queue was aborted. Report the
			// cancellation, not the queue error, so the task still exits as cancelled.
			if ctxErr := ctx.Err(); ctxErr != nil {
				return total, ctxErr
			}
			return total, rerr
		}
	}
}

// openReadPath opens path for reading without blocking in open(2) on a FIFO that has no writer: that
// open waits for a writer, and a cancelled task cannot interrupt it. The caller must still refuse
// the types that cannot be read to their end (checkNotSpecial).
func openReadPath(path string) (*os.File, error) {
	fd, err := unix.Open(path, unix.O_RDONLY|unix.O_NONBLOCK|unix.O_CLOEXEC, 0)
	if err != nil {
		if errors.Is(err, unix.ENXIO) {
			// A socket inode cannot be opened for reading at all (ENXIO); it is no more a regular
			// file than a FIFO.
			return nil, errf("not_regular_file", "%s is not a regular file", path)
		}
		return nil, &os.PathError{Op: "open", Path: path, Err: err}
	}
	return os.NewFile(uintptr(fd), path), nil
}

func fileRead(ctx context.Context, s *protocol.FileReadSpec, stdout io.Writer) (*protocol.TaskResult, error) {
	if err := checkPath(s.Path); err != nil {
		return nil, err
	}
	f, err := openReadPath(s.Path)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	fi, err := f.Stat()
	if err != nil {
		return nil, err
	}
	if fi.IsDir() {
		return nil, errf("is_directory", "%s is a directory", s.Path)
	}
	if err := checkNotSpecial(fi, s.Path); err != nil {
		return nil, err
	}
	if fi.Mode().IsRegular() {
		if err := clearNonblocking(f); err != nil {
			return nil, err
		}
	}
	page, err := readPage(ctx, f, s, stdout)
	if err != nil {
		return nil, err
	}
	return &protocol.TaskResult{Kind: protocol.TaskResultFileRead, FileRead: page}, nil
}

// readPage writes lineCount lines from startLine (1-based) to stdout and returns what the page holds:
// which lines they are, whether the file ended, its line count when it did, and whether the requested
// line alone is too long. It scans from the start of the file and stops at the line count or at the
// byte cap, whole lines only; it does not read the rest of the file (doc/protocol.md#任务).
func readPage(ctx context.Context, r io.Reader, s *protocol.FileReadSpec, stdout io.Writer) (*protocol.FileReadResult, error) {
	if s.StartLine < 1 || s.LineCount < 1 {
		return nil, errf("invalid_spec", "startLine and lineCount must be at least 1")
	}
	res := protocol.FileReadResult{}
	lr := &lineReader{br: bufio.NewReaderSize(r, 64<<10)}
	start, count := uint64(s.StartLine), uint64(s.LineCount)
	line := uint64(1) // the line about to be read
	// The node scans to the start line: skipped lines are discarded, never kept.
	for line < start {
		if err := ctx.Err(); err != nil {
			return nil, err
		}
		next, err := lr.next(ctx, 0, false)
		if err != nil {
			return nil, err
		}
		if !next.exists || next.last {
			// The file has no line startLine, so the scan reached its end.
			total := line - 1
			if next.exists {
				total = line
			}
			res.EOF, res.Total = true, totalPtr(total)
			return &res, nil
		}
		line++
	}
	written := uint64(0)
	pageLines := uint64(0)
	for pageLines < count {
		if err := ctx.Err(); err != nil {
			return nil, err
		}
		next, err := lr.next(ctx, protocol.FileReadMaxBytes+1, true)
		if err != nil {
			return nil, err
		}
		if !next.exists {
			total := line - 1
			res.EOF, res.Total = true, totalPtr(total)
			break
		}
		if next.tooLong || written+uint64(len(next.text)) > protocol.FileReadMaxBytes {
			// The line does not fit the page; alone on the page, it cannot be shown at all.
			res.TooLong = pageLines == 0
			break
		}
		if _, err := stdout.Write(next.text); err != nil {
			return nil, err
		}
		written += uint64(len(next.text))
		if pageLines == 0 {
			res.From = protocol.Uint(line)
		}
		res.To = protocol.Uint(line)
		pageLines++
		if next.last {
			res.EOF, res.Total = true, totalPtr(line)
			break
		}
		line++
	}
	if pageLines == count && !res.EOF {
		// The page ends on its line count: one byte tells whether the file ends there too.
		if _, err := lr.br.Peek(1); errors.Is(err, io.EOF) {
			res.EOF, res.Total = true, totalPtr(uint64(res.To))
		}
	}
	return &res, nil
}

// totalPtr is the line count a page reports; it is set only when the scan reached the end.
func totalPtr(lines uint64) *protocol.Uint {
	total := protocol.Uint(lines)
	return &total
}

// lineRead is one line of a file as lineReader found it.
type lineRead struct {
	// text is the line's bytes, its terminating newline included; nil when the caller keeps no text.
	text []byte
	// exists is false at the end of the file: there is no such line.
	exists bool
	// last means the line was the file's last one and had no terminating newline.
	last bool
	// tooLong means the kept line is longer than the limit the caller gave.
	tooLong bool
}

// lineReader reads a file line by line, keeping one line in memory at most: a line over the limit is
// reported as too long instead of being read to its end. Lines end at "\n", so a CRLF line keeps its
// "\r" (doc/protocol.md#任务).
type lineReader struct {
	br  *bufio.Reader
	buf []byte
}

// next reads the next line. With keep false its bytes are dropped, so a long line before the page
// costs nothing; with keep true they are returned up to max bytes, and tooLong is set beyond that.
// The context is checked before every chunk: one line can be arbitrarily long (a file without a
// newline, a character device that never ends), so a cancellation must not wait for its end.
func (r *lineReader) next(ctx context.Context, max int, keep bool) (lineRead, error) {
	r.buf = r.buf[:0]
	read := false
	for {
		if err := ctx.Err(); err != nil {
			return lineRead{}, err
		}
		chunk, err := r.br.ReadSlice('\n')
		read = read || len(chunk) > 0
		if keep {
			if len(r.buf)+len(chunk) > max {
				return lineRead{exists: true, tooLong: true}, nil
			}
			r.buf = append(r.buf, chunk...)
		}
		switch {
		case err == nil:
			return lineRead{text: r.buf, exists: true}, nil
		case errors.Is(err, bufio.ErrBufferFull):
			continue
		case errors.Is(err, io.EOF):
			if !read {
				return lineRead{}, nil
			}
			return lineRead{text: r.buf, exists: true, last: true}, nil
		default:
			return lineRead{}, err
		}
	}
}

// tempFile is a not-yet-published file next to its destination.
type tempFile struct {
	*os.File
	dir string
}

func createTemp(path string) (*tempFile, error) {
	dir, base := filepath.Split(path)
	dir = filepath.Clean(dir)
	for range 10 {
		var rnd [6]byte
		if _, err := rand.Read(rnd[:]); err != nil {
			return nil, err
		}
		name := filepath.Join(dir, fmt.Sprintf(".%s.crh-%x", base, rnd))
		f, err := os.OpenFile(name, os.O_WRONLY|os.O_CREATE|os.O_EXCL|unix.O_NOFOLLOW, 0o600)
		if errors.Is(err, fs.ErrExist) {
			continue
		}
		if err != nil {
			return nil, err
		}
		return &tempFile{File: f, dir: dir}, nil
	}
	return nil, errf("io_error", "cannot create temporary file in %s", dir)
}

func (t *tempFile) discard() {
	t.Close()
	os.Remove(t.Name())
}

// publish fsyncs the temp file, moves it to path and fsyncs the directory.
func (t *tempFile) publish(path string, noReplace bool) error {
	if err := t.Sync(); err != nil {
		return err
	}
	if err := t.Close(); err != nil {
		return err
	}
	var err error
	if noReplace {
		err = unix.Renameat2(unix.AT_FDCWD, t.Name(), unix.AT_FDCWD, path, unix.RENAME_NOREPLACE)
		if errors.Is(err, syscall.EEXIST) {
			return errf("exists", "%s already exists", path)
		}
	} else {
		err = os.Rename(t.Name(), path)
	}
	if err != nil {
		var le *os.LinkError
		if errors.As(err, &le) {
			err = le.Err
		}
		return err
	}
	return syncDir(t.dir)
}

func syncDir(dir string) error {
	d, err := os.Open(dir)
	if err != nil {
		return err
	}
	defer d.Close()
	return d.Sync()
}

func statIDs(fi fs.FileInfo) (uid, gid int) {
	if st, ok := fi.Sys().(*syscall.Stat_t); ok {
		return int(st.Uid), int(st.Gid)
	}
	return -1, -1
}

// statMode returns the raw mode of fi, including setuid, setgid and sticky, which fs.FileMode
// keeps as separate flags instead of permission bits.
func statMode(fi fs.FileInfo) uint32 {
	if st, ok := fi.Sys().(*syscall.Stat_t); ok {
		return uint32(st.Mode)
	}
	return uint32(fi.Mode().Perm())
}

func lookupIDs(owner, group string) (uid, gid int, err error) {
	uid, gid = -1, -1
	if owner != "" {
		u, e := user.Lookup(owner)
		if e != nil {
			return 0, 0, errf("invalid_spec", "unknown owner %q", owner)
		}
		uid, _ = strconv.Atoi(u.Uid)
	}
	if group != "" {
		g, e := user.LookupGroup(group)
		if e != nil {
			return 0, 0, errf("invalid_spec", "unknown group %q", group)
		}
		gid, _ = strconv.Atoi(g.Gid)
	}
	return uid, gid, nil
}

// resolveWriteTarget follows a symbolic link at path so that a write replaces the file the link
// points to instead of the link itself. Without this, the link's own stat (mode 0777) would decide
// the new file's mode and owner, and the rename would replace the link with a world-writable
// regular file while the target stayed untouched (for example /etc/resolv.conf).
//
// It returns the resolved path and the target's FileInfo, or a nil FileInfo when the target does
// not exist yet (a dangling link, or a path that does not exist at all), in which case the caller
// creates the target with the requested or default mode. A missing intermediate directory is left
// to the caller's create or rename, which reports it as not_found.
func resolveWriteTarget(path string) (string, fs.FileInfo, error) {
	// 40 hops is the kernel's limit on following symbolic links (MAXSYMLINKS).
	for range 40 {
		fi, err := os.Lstat(path)
		switch {
		case errors.Is(err, fs.ErrNotExist):
			return path, nil, nil
		case err != nil:
			return "", nil, err
		case fi.Mode()&fs.ModeSymlink == 0:
			return path, fi, nil
		}
		link, err := os.Readlink(path)
		if err != nil {
			return "", nil, err
		}
		if !filepath.IsAbs(link) {
			// The kernel resolves a relative target against the link's real directory, not against
			// the path used to reach it: when a component of dir is itself a symbolic link,
			// joining lexically and cleaning ".." lands somewhere else.
			dir, err := filepath.EvalSymlinks(filepath.Dir(path))
			if err != nil {
				return "", nil, err
			}
			link = filepath.Join(dir, link)
		}
		path = link
	}
	return "", nil, errf("io_error", "too many levels of symbolic links in %s", path)
}

func fileWrite(ctx context.Context, s *protocol.FileWriteSpec, input io.Reader, stdout io.Writer) (*protocol.TaskResult, error) {
	path := s.Path
	if err := checkPath(path); err != nil {
		return nil, err
	}
	if input == nil {
		input = strings.NewReader("")
	}
	uid, gid, err := lookupIDs(s.Owner, s.Group)
	if err != nil {
		return nil, err
	}
	target, existing, err := resolveWriteTarget(path)
	if err != nil {
		return nil, err
	}
	if existing != nil && existing.IsDir() {
		return nil, errf("is_directory", "%s is a directory", path)
	}
	tmp, err := createTemp(target)
	if err != nil {
		return nil, err
	}
	ok := false
	defer func() {
		if !ok {
			tmp.discard()
		}
	}()

	want := s.Content
	h := sha256.New()
	n, err := copyCtx(ctx, io.MultiWriter(tmp, h), io.LimitReader(input, int64(want.Size)+1))
	if err != nil {
		return nil, err
	}
	if uint64(n) != uint64(want.Size) || !bytes.Equal(h.Sum(nil), want.SHA256[:]) {
		return nil, errf("input_mismatch", "content does not match declared size/sha256 (got %d bytes)", n)
	}

	mode := fs.FileMode(0o644)
	switch {
	case s.Mode != 0:
		mode = editMode(uint32(s.Mode))
	case existing != nil:
		mode = editMode(statMode(existing))
	}
	if existing != nil && uid < 0 && gid < 0 {
		euid, egid := statIDs(existing)
		if err := tmp.Chown(euid, egid); err != nil && !errors.Is(err, syscall.EPERM) {
			return nil, err
		}
	} else if uid >= 0 || gid >= 0 {
		if err := tmp.Chown(uid, gid); err != nil {
			return nil, err
		}
	}
	if err := tmp.Chmod(mode); err != nil {
		return nil, err
	}
	if err := tmp.publish(target, !s.Overwrite); err != nil {
		return nil, err
	}
	ok = true
	return &protocol.TaskResult{Kind: protocol.TaskResultFileWrite, FileWrite: &protocol.FileWriteResult{
		Bytes: protocol.Uint(n), Created: existing == nil,
	}}, nil
}

// statValues is the file.stat result of an already stat'ed file.
func statValues(path string, fi fs.FileInfo) *protocol.FileStatResult {
	uid, gid := statIDs(fi)
	return &protocol.FileStatResult{
		Path:  path,
		Type:  fileType(fi.Mode()),
		Size:  protocol.Int(fi.Size()),
		Mode:  modeString(fi.Mode()),
		UID:   protocol.Int(uid),
		GID:   protocol.Int(gid),
		Owner: ownerName(uid),
		Group: groupName(gid),
		MTime: mtimeString(fi),
	}
}

func fileStat(s *protocol.FileStatSpec) (*protocol.TaskResult, error) {
	if err := checkPath(s.Path); err != nil {
		return nil, err
	}
	fi, err := os.Lstat(s.Path)
	if err != nil {
		return nil, err
	}
	out := statValues(s.Path, fi)
	if fi.Mode()&fs.ModeSymlink != 0 {
		target, err := os.Readlink(s.Path)
		if err != nil {
			return nil, err
		}
		out.LinkTarget = &target
	}
	return &protocol.TaskResult{Kind: protocol.TaskResultFileStat, FileStat: out}, nil
}

func fileList(ctx context.Context, s *protocol.FileListSpec) (*protocol.TaskResult, error) {
	if err := checkPath(s.Path); err != nil {
		return nil, err
	}
	limit := int(s.Limit)
	if limit == 0 {
		limit = defaultListLimit
	}
	limit = min(limit, maxListLimit)

	fi, err := os.Stat(s.Path)
	if err != nil {
		return nil, err
	}
	if !fi.IsDir() {
		return nil, errf("not_a_directory", "%s is not a directory", s.Path)
	}
	des, err := os.ReadDir(s.Path)
	if err != nil {
		return nil, err
	}
	sort.Slice(des, func(i, j int) bool { return des[i].Name() < des[j].Name() })
	truncated := len(des) > limit
	if truncated {
		des = des[:limit]
	}
	entries := make([]protocol.FileListEntry, 0, len(des))
	used := 0
	for _, de := range des {
		if err := ctx.Err(); err != nil {
			return nil, err
		}
		info, err := de.Info()
		if errors.Is(err, fs.ErrNotExist) {
			continue
		}
		if err != nil {
			return nil, err
		}
		entry := protocol.FileListEntry{
			Name:  de.Name(),
			Type:  fileType(info.Mode()),
			Size:  protocol.Int(info.Size()),
			Mode:  modeString(info.Mode()),
			MTime: mtimeString(info),
		}
		size := listEntrySize(entry)
		// The result travels in one task.exit frame: stop before it could outgrow it
		// (doc/protocol.md TaskResult).
		if used+size > protocol.FileListMaxBytes {
			truncated = true
			break
		}
		used += size
		entries = append(entries, entry)
	}
	return &protocol.TaskResult{Kind: protocol.TaskResultFileList, FileList: &protocol.FileListResult{
		Entries: entries, Truncated: truncated,
	}}, nil
}

// listEntrySize is a safe upper bound of the encoded size of one list entry: its fields plus the
// CBOR headers and the array of five.
func listEntrySize(e protocol.FileListEntry) int {
	return len(e.Name) + len(e.Type) + len(e.Mode) + len(e.MTime) + 24
}

func fileType(m fs.FileMode) string {
	switch {
	case m.IsRegular():
		return "file"
	case m.IsDir():
		return "dir"
	case m&fs.ModeSymlink != 0:
		return "symlink"
	}
	return "other"
}

func modeString(m fs.FileMode) string { return fmt.Sprintf("%04o", uint32(m.Perm())) }

func mtimeString(fi fs.FileInfo) string {
	return fi.ModTime().UTC().Format(time.RFC3339Nano)
}

func ownerName(uid int) string {
	if u, err := user.LookupId(strconv.Itoa(uid)); err == nil {
		return u.Username
	}
	return ""
}

func groupName(gid int) string {
	if g, err := user.LookupGroupId(strconv.Itoa(gid)); err == nil {
		return g.Name
	}
	return ""
}
