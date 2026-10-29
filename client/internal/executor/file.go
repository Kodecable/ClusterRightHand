// Package executor runs tasks on the node.
package executor

import (
	"bytes"
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/json"
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

// RunFile executes a file.* task. stdout receives the task's output stream; input carries the
// file.write content (nil for other kinds). It returns nil or an *Error (other errors are wrapped
// into Error{Code: "io_error"}).
func RunFile(ctx context.Context, spec *protocol.TaskSpec, input io.Reader, stdout io.Writer) error {
	var err error
	switch spec.Kind {
	case protocol.TaskSpecFileRead:
		if spec.FileRead == nil {
			return errf("invalid_spec", "file.read task has no spec")
		}
		err = fileRead(ctx, spec.FileRead, stdout)
	case protocol.TaskSpecFileWrite:
		if spec.FileWrite == nil {
			return errf("invalid_spec", "file.write task has no spec")
		}
		err = fileWrite(ctx, spec.FileWrite, input, stdout)
	case protocol.TaskSpecFileEdit:
		if spec.FileEdit == nil {
			return errf("invalid_spec", "file.edit task has no spec")
		}
		err = fileEdit(spec.FileEdit, stdout)
	case protocol.TaskSpecFileStat:
		if spec.FileStat == nil {
			return errf("invalid_spec", "file.stat task has no spec")
		}
		err = fileStat(spec.FileStat, stdout)
	case protocol.TaskSpecFileList:
		if spec.FileList == nil {
			return errf("invalid_spec", "file.list task has no spec")
		}
		err = fileList(ctx, spec.FileList, stdout)
	default:
		err = errf("invalid_spec", "not a file task: %q", spec.Kind)
	}
	return normalizeErr(err)
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

func writeJSON(w io.Writer, v any) error {
	b, err := json.Marshal(v)
	if err != nil {
		return err
	}
	_, err = w.Write(b)
	return err
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

func fileRead(ctx context.Context, s *protocol.FileReadSpec, stdout io.Writer) error {
	if err := checkPath(s.Path); err != nil {
		return err
	}
	f, err := os.Open(s.Path)
	if err != nil {
		return err
	}
	defer f.Close()
	fi, err := f.Stat()
	if err != nil {
		return err
	}
	if fi.IsDir() {
		return errf("is_directory", "%s is a directory", s.Path)
	}
	var r io.Reader = io.NewSectionReader(f, int64(s.Offset), 1<<62)
	if s.Limit > 0 {
		r = io.LimitReader(r, int64(s.Limit))
	}
	_, err = copyCtx(ctx, stdout, r)
	return err
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

func fileWrite(ctx context.Context, s *protocol.FileWriteSpec, input io.Reader, stdout io.Writer) error {
	path := s.Path
	if err := checkPath(path); err != nil {
		return err
	}
	if input == nil {
		input = strings.NewReader("")
	}
	uid, gid, err := lookupIDs(s.Owner, s.Group)
	if err != nil {
		return err
	}
	existing, err := os.Lstat(path)
	switch {
	case err == nil && existing.IsDir():
		return errf("is_directory", "%s is a directory", path)
	case err != nil && !errors.Is(err, fs.ErrNotExist):
		return err
	case err != nil:
		existing = nil
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

	want := s.Content
	h := sha256.New()
	n, err := copyCtx(ctx, io.MultiWriter(tmp, h), io.LimitReader(input, int64(want.Size)+1))
	if err != nil {
		return err
	}
	if uint64(n) != uint64(want.Size) || !bytes.Equal(h.Sum(nil), want.SHA256[:]) {
		return errf("input_mismatch", "content does not match declared size/sha256 (got %d bytes)", n)
	}

	mode := fs.FileMode(0o644)
	switch {
	case s.Mode != 0:
		mode = fs.FileMode(s.Mode) & 0o7777
	case existing != nil:
		mode = existing.Mode() & 0o7777
	}
	if existing != nil && uid < 0 && gid < 0 {
		euid, egid := statIDs(existing)
		if err := tmp.Chown(euid, egid); err != nil && !errors.Is(err, syscall.EPERM) {
			return err
		}
	} else if uid >= 0 || gid >= 0 {
		if err := tmp.Chown(uid, gid); err != nil {
			return err
		}
	}
	if err := tmp.Chmod(mode); err != nil {
		return err
	}
	if err := tmp.publish(path, !s.Overwrite); err != nil {
		return err
	}
	ok = true
	return writeJSON(stdout, map[string]any{"bytes": n, "created": existing == nil})
}

func fileStat(s *protocol.FileStatSpec, stdout io.Writer) error {
	if err := checkPath(s.Path); err != nil {
		return err
	}
	fi, err := os.Lstat(s.Path)
	if err != nil {
		return err
	}
	uid, gid := statIDs(fi)
	out := map[string]any{
		"path":  s.Path,
		"type":  fileType(fi.Mode()),
		"size":  fi.Size(),
		"mode":  modeString(fi.Mode()),
		"uid":   uid,
		"gid":   gid,
		"owner": ownerName(uid),
		"group": groupName(gid),
		"mtime": mtimeString(fi),
	}
	if fi.Mode()&fs.ModeSymlink != 0 {
		target, err := os.Readlink(s.Path)
		if err != nil {
			return err
		}
		out["link_target"] = target
	}
	return writeJSON(stdout, out)
}

type listEntry struct {
	Name  string `json:"name"`
	Type  string `json:"type"`
	Size  int64  `json:"size"`
	Mode  string `json:"mode"`
	Mtime string `json:"mtime"`
}

func fileList(ctx context.Context, s *protocol.FileListSpec, stdout io.Writer) error {
	if err := checkPath(s.Path); err != nil {
		return err
	}
	limit := int(s.Limit)
	if limit == 0 {
		limit = defaultListLimit
	}
	limit = min(limit, maxListLimit)

	fi, err := os.Stat(s.Path)
	if err != nil {
		return err
	}
	if !fi.IsDir() {
		return errf("not_a_directory", "%s is not a directory", s.Path)
	}
	des, err := os.ReadDir(s.Path)
	if err != nil {
		return err
	}
	sort.Slice(des, func(i, j int) bool { return des[i].Name() < des[j].Name() })
	truncated := len(des) > limit
	if truncated {
		des = des[:limit]
	}
	entries := make([]listEntry, 0, len(des))
	for _, de := range des {
		if err := ctx.Err(); err != nil {
			return err
		}
		info, err := de.Info()
		if errors.Is(err, fs.ErrNotExist) {
			continue
		}
		if err != nil {
			return err
		}
		entries = append(entries, listEntry{
			Name:  de.Name(),
			Type:  fileType(info.Mode()),
			Size:  info.Size(),
			Mode:  modeString(info.Mode()),
			Mtime: mtimeString(info),
		})
	}
	return writeJSON(stdout, map[string]any{"entries": entries, "truncated": truncated})
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
