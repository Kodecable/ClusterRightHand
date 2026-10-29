package executor

import (
	"bytes"
	"context"
	"crypto/rand"
	"crypto/sha256"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"syscall"
	"time"

	"golang.org/x/sys/unix"

	"github.com/Kodecable/ClusterRightHand/client/internal/protocol"
)

// RunFilePrivileged executes a file.* task the way privileged execution must: every path is opened
// with openat2(RESOLVE_BENEATH|RESOLVE_NO_SYMLINKS) from an fd for "/", and stat, read, list and
// write operate on the resulting fds. A symbolic link at any level is refused, and so is a kernel
// or sandbox that does not provide openat2; there is no fallback to path-based operations
// (doc/privilege.md "方法与目标").
func RunFilePrivileged(ctx context.Context, spec *protocol.TaskSpec, input io.Reader, stdout io.Writer) error {
	var err error
	switch spec.Kind {
	case protocol.TaskSpecFileRead:
		if spec.FileRead == nil {
			return errf("invalid_spec", "file.read task has no spec")
		}
		err = fileReadPrivileged(ctx, spec.FileRead, stdout)
	case protocol.TaskSpecFileWrite:
		if spec.FileWrite == nil {
			return errf("invalid_spec", "file.write task has no spec")
		}
		err = fileWritePrivileged(ctx, spec.FileWrite, input, stdout)
	case protocol.TaskSpecFileEdit:
		if spec.FileEdit == nil {
			return errf("invalid_spec", "file.edit task has no spec")
		}
		err = fileEditPrivileged(spec.FileEdit, stdout)
	case protocol.TaskSpecFileStat:
		if spec.FileStat == nil {
			return errf("invalid_spec", "file.stat task has no spec")
		}
		err = fileStatPrivileged(spec.FileStat, stdout)
	case protocol.TaskSpecFileList:
		if spec.FileList == nil {
			return errf("invalid_spec", "file.list task has no spec")
		}
		err = fileListPrivileged(ctx, spec.FileList, stdout)
	default:
		err = errf("invalid_spec", "not a file task: %q", spec.Kind)
	}
	return normalizeErr(err)
}

// privilegedFileRoot is an fd for "/" that privileged file tasks resolve their paths from.
type privilegedFileRoot struct{ f *os.File }

func openPrivilegedFileRoot() (*privilegedFileRoot, error) {
	fd, err := unix.Open("/", unix.O_PATH|unix.O_DIRECTORY|unix.O_CLOEXEC, 0)
	if err != nil {
		return nil, &os.PathError{Op: "open", Path: "/", Err: err}
	}
	return &privilegedFileRoot{f: os.NewFile(uintptr(fd), "/")}, nil
}

func (r *privilegedFileRoot) Close() { r.f.Close() }

// open resolves p, which must be absolute and clean, below "/". RESOLVE_BENEATH makes ".." escapes
// impossible and RESOLVE_NO_SYMLINKS refuses a symbolic link at any level, including the last one.
func (r *privilegedFileRoot) open(p string, flags int) (*os.File, error) {
	how := unix.OpenHow{
		Flags:   uint64(flags | unix.O_CLOEXEC),
		Resolve: unix.RESOLVE_BENEATH | unix.RESOLVE_NO_SYMLINKS,
	}
	fd, err := unix.Openat2(int(r.f.Fd()), beneath(p), &how)
	if err != nil {
		return nil, openat2Error(p, err)
	}
	return os.NewFile(uintptr(fd), p), nil
}

// beneath makes an absolute path relative to "/": openat2 resolves a relative path below the root
// fd, and "." names the root itself.
func beneath(p string) string {
	rel := strings.TrimPrefix(p, "/")
	if rel == "" {
		return "."
	}
	return rel
}

// openat2Error maps the failures that mean the path cannot be resolved safely. It fails closed:
// ENOSYS (a kernel before 5.6) and EPERM (a seccomp filter) make the operation unsupported instead
// of falling back to lstat and open.
func openat2Error(p string, err error) error {
	switch {
	case errors.Is(err, unix.ELOOP):
		return errf("symlink_not_allowed", "%s contains a symbolic link", p)
	case errors.Is(err, unix.ENOSYS), errors.Is(err, unix.EPERM):
		return errf("openat2_unavailable", "cannot resolve %s safely: openat2 with RESOLVE_BENEATH|RESOLVE_NO_SYMLINKS is unavailable (%v)", p, err)
	}
	return err
}

func fileReadPrivileged(ctx context.Context, s *protocol.FileReadSpec, stdout io.Writer) error {
	if err := checkPath(s.Path); err != nil {
		return err
	}
	root, err := openPrivilegedFileRoot()
	if err != nil {
		return err
	}
	defer root.Close()
	f, err := root.open(s.Path, unix.O_RDONLY)
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

func fileStatPrivileged(s *protocol.FileStatSpec, stdout io.Writer) error {
	if err := checkPath(s.Path); err != nil {
		return err
	}
	root, err := openPrivilegedFileRoot()
	if err != nil {
		return err
	}
	defer root.Close()
	// O_PATH is enough to fstat and cannot block on a FIFO or device.
	f, err := root.open(s.Path, unix.O_PATH)
	if err != nil {
		return err
	}
	defer f.Close()
	fi, err := f.Stat()
	if err != nil {
		return err
	}
	return writeJSON(stdout, statValues(s.Path, fi))
}

func fileListPrivileged(ctx context.Context, s *protocol.FileListSpec, stdout io.Writer) error {
	if err := checkPath(s.Path); err != nil {
		return err
	}
	limit := int(s.Limit)
	if limit == 0 {
		limit = defaultListLimit
	}
	limit = min(limit, maxListLimit)

	root, err := openPrivilegedFileRoot()
	if err != nil {
		return err
	}
	defer root.Close()
	dir, err := root.open(s.Path, unix.O_RDONLY)
	if err != nil {
		return err
	}
	defer dir.Close()
	fi, err := dir.Stat()
	if err != nil {
		return err
	}
	if !fi.IsDir() {
		return errf("not_a_directory", "%s is not a directory", s.Path)
	}
	des, err := dir.ReadDir(-1)
	if err != nil {
		return err
	}
	sort.Slice(des, func(i, j int) bool { return des[i].Name() < des[j].Name() })
	truncated := len(des) > limit
	if truncated {
		des = des[:limit]
	}
	dirfd := int(dir.Fd())
	entries := make([]listEntry, 0, len(des))
	for _, de := range des {
		if err := ctx.Err(); err != nil {
			return err
		}
		// Stat every entry through the directory fd: DirEntry.Info would resolve the name by path
		// again, outside the fd the directory was opened with.
		var st unix.Stat_t
		err := unix.Fstatat(dirfd, de.Name(), &st, unix.AT_SYMLINK_NOFOLLOW)
		if errors.Is(err, unix.ENOENT) {
			continue
		}
		if err != nil {
			return err
		}
		mode := fileMode(st.Mode)
		entries = append(entries, listEntry{
			Name:  de.Name(),
			Type:  fileType(mode),
			Size:  st.Size,
			Mode:  modeString(mode),
			Mtime: mtimeFromStat(&st),
		})
	}
	return writeJSON(stdout, map[string]any{"entries": entries, "truncated": truncated})
}

func fileWritePrivileged(ctx context.Context, s *protocol.FileWriteSpec, input io.Reader, stdout io.Writer) error {
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
	root, err := openPrivilegedFileRoot()
	if err != nil {
		return err
	}
	defer root.Close()
	dir, base, err := splitParent(path)
	if err != nil {
		return err
	}
	// The parent directory is resolved the same way; only then is the destination touched, and only
	// through the directory fd, so a symlink anywhere on the way in cannot redirect the write. O_PATH
	// does not require read permission on the directory, which creating a file does not need either.
	dfd, err := root.open(dir, unix.O_PATH|unix.O_DIRECTORY)
	if err != nil {
		return err
	}
	defer dfd.Close()

	var existing *unix.Stat_t
	var st unix.Stat_t
	switch err := unix.Fstatat(int(dfd.Fd()), base, &st, unix.AT_SYMLINK_NOFOLLOW); {
	case err == nil:
		switch st.Mode & unix.S_IFMT {
		case unix.S_IFLNK:
			return errf("symlink_not_allowed", "%s is a symbolic link", path)
		case unix.S_IFDIR:
			return errf("is_directory", "%s is a directory", path)
		}
		existing = &st
	case errors.Is(err, unix.ENOENT):
	default:
		return err
	}

	tmpName, tmp, err := createTempAt(dfd, base)
	if err != nil {
		return err
	}
	ok := false
	defer func() {
		if !ok {
			tmp.Close()
			_ = unix.Unlinkat(int(dfd.Fd()), tmpName, 0)
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
		mode = fs.FileMode(existing.Mode) & 0o7777
	}
	if existing != nil && uid < 0 && gid < 0 {
		if err := tmp.Chown(int(existing.Uid), int(existing.Gid)); err != nil && !errors.Is(err, syscall.EPERM) {
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
	if err := publishAt(dfd, tmpName, tmp, base, path, !s.Overwrite); err != nil {
		return err
	}
	ok = true
	return writeJSON(stdout, map[string]any{"bytes": n, "created": existing == nil})
}

func fileEditPrivileged(s *protocol.FileEditSpec, stdout io.Writer) error {
	path := s.Path
	if err := checkPath(path); err != nil {
		return err
	}
	if len(s.Edits) == 0 {
		return errf("invalid_spec", "edits must not be empty")
	}
	root, err := openPrivilegedFileRoot()
	if err != nil {
		return err
	}
	defer root.Close()
	dir, base, err := splitParent(path)
	if err != nil {
		return err
	}
	dfd, err := root.open(dir, unix.O_PATH|unix.O_DIRECTORY)
	if err != nil {
		return err
	}
	defer dfd.Close()

	var st unix.Stat_t
	if err := unix.Fstatat(int(dfd.Fd()), base, &st, unix.AT_SYMLINK_NOFOLLOW); err != nil {
		return err
	}
	switch st.Mode & unix.S_IFMT {
	case unix.S_IFLNK:
		return errf("symlink_not_allowed", "%s is a symbolic link", path)
	case unix.S_IFDIR:
		return errf("is_directory", "%s is a directory", path)
	}
	// O_NOFOLLOW covers the race between the check above and the open: the final component is never
	// followed, and the parent comes from the already resolved directory fd.
	fd, err := unix.Openat(int(dfd.Fd()), base, unix.O_RDONLY|unix.O_NOFOLLOW|unix.O_CLOEXEC, 0)
	if err != nil {
		if errors.Is(err, unix.ELOOP) {
			return errf("symlink_not_allowed", "%s is a symbolic link", path)
		}
		return &os.PathError{Op: "open", Path: path, Err: err}
	}
	f := os.NewFile(uintptr(fd), path)
	defer f.Close()
	fi, err := f.Stat()
	if err != nil {
		return err
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
	out, err := applyEdits(normalizeToLF(text), s.Edits, path)
	if err != nil {
		return err
	}
	if ending == "\r\n" {
		out = strings.ReplaceAll(out, "\n", "\r\n")
	}

	tmpName, tmp, err := createTempAt(dfd, base)
	if err != nil {
		return err
	}
	ok := false
	defer func() {
		if !ok {
			tmp.Close()
			_ = unix.Unlinkat(int(dfd.Fd()), tmpName, 0)
		}
	}()
	if _, err := tmp.Write(append(bom[:len(bom):len(bom)], out...)); err != nil {
		return err
	}
	if err := tmp.Chown(int(st.Uid), int(st.Gid)); err != nil && !errors.Is(err, os.ErrPermission) {
		return err
	}
	if err := tmp.Chmod(editMode(st.Mode)); err != nil {
		return err
	}
	if err := publishAt(dfd, tmpName, tmp, base, path, false); err != nil {
		return err
	}
	ok = true
	return writeJSON(stdout, map[string]any{"replacements": len(s.Edits)})
}

// splitParent splits an absolute and clean path into its parent directory and final name. The name
// is one path component, so the directory fd alone determines where the operation happens.
func splitParent(p string) (dir, base string, err error) {
	dir, base = filepath.Split(p)
	if base == "" || strings.ContainsRune(base, '/') || base == "." || base == ".." {
		return "", "", errf("is_directory", "%s is a directory", p)
	}
	return filepath.Clean(dir), base, nil
}

// createTempAt creates a not-yet-published file in the directory fd, named after the destination
// like the unprivileged path does.
func createTempAt(dir *os.File, base string) (string, *os.File, error) {
	dirfd := int(dir.Fd())
	for range 10 {
		var rnd [6]byte
		if _, err := rand.Read(rnd[:]); err != nil {
			return "", nil, err
		}
		name := fmt.Sprintf(".%s.crh-%x", base, rnd)
		fd, err := unix.Openat(dirfd, name, unix.O_WRONLY|unix.O_CREAT|unix.O_EXCL|unix.O_NOFOLLOW|unix.O_CLOEXEC, 0o600)
		if errors.Is(err, unix.EEXIST) {
			continue
		}
		if err != nil {
			return "", nil, &os.PathError{Op: "open", Path: filepath.Join(dir.Name(), name), Err: err}
		}
		return name, os.NewFile(uintptr(fd), name), nil
	}
	return "", nil, errf("io_error", "cannot create a temporary file in %s", dir.Name())
}

// publishAt fsyncs and closes tmp, renames it to base in the directory fd and fsyncs the directory.
// With noReplace it never replaces an existing destination.
func publishAt(dir *os.File, tmpName string, tmp *os.File, base, path string, noReplace bool) error {
	if err := tmp.Sync(); err != nil {
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	flags := 0
	if noReplace {
		flags = unix.RENAME_NOREPLACE
	}
	dirfd := int(dir.Fd())
	if err := unix.Renameat2(dirfd, tmpName, dirfd, base, uint(flags)); err != nil {
		if errors.Is(err, unix.EEXIST) {
			return errf("exists", "%s already exists", path)
		}
		return &os.LinkError{Op: "rename", Old: tmpName, New: path, Err: err}
	}
	return syncDirectory(dirfd)
}

// syncDirectory fsyncs the directory a file was published in. dirfd may be an O_PATH fd, which
// cannot be fsynced; a directory that cannot be opened for reading is skipped, because writing in it
// does not need read permission.
func syncDirectory(dirfd int) error {
	fd, err := unix.Openat(dirfd, ".", unix.O_RDONLY|unix.O_DIRECTORY|unix.O_CLOEXEC, 0)
	if err != nil {
		if errors.Is(err, unix.EACCES) || errors.Is(err, unix.EPERM) {
			return nil
		}
		return err
	}
	defer unix.Close(fd)
	return unix.Fsync(fd)
}

// editMode returns the mode a file.edit keeps: the permission bits plus setuid, setgid and sticky.
func editMode(mode uint32) fs.FileMode {
	m := fs.FileMode(mode & 0o777)
	if mode&unix.S_ISUID != 0 {
		m |= fs.ModeSetuid
	}
	if mode&unix.S_ISGID != 0 {
		m |= fs.ModeSetgid
	}
	if mode&unix.S_ISVTX != 0 {
		m |= fs.ModeSticky
	}
	return m
}

// fileMode converts a raw stat mode to the fs.FileMode flags the listing helpers understand.
func fileMode(mode uint32) fs.FileMode {
	m := editMode(mode)
	switch mode & unix.S_IFMT {
	case unix.S_IFDIR:
		m |= fs.ModeDir
	case unix.S_IFLNK:
		m |= fs.ModeSymlink
	case unix.S_IFIFO:
		m |= fs.ModeNamedPipe
	case unix.S_IFSOCK:
		m |= fs.ModeSocket
	case unix.S_IFCHR:
		m |= fs.ModeDevice | fs.ModeCharDevice
	case unix.S_IFBLK:
		m |= fs.ModeDevice
	}
	return m
}

func mtimeFromStat(st *unix.Stat_t) string {
	return time.Unix(st.Mtim.Sec, st.Mtim.Nsec).UTC().Format(time.RFC3339Nano)
}
