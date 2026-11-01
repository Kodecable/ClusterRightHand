package executor

import (
	"errors"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
	"syscall"

	"golang.org/x/sys/unix"
)

// fileAccess opens the paths of a file task. The unprivileged access opens a path directly and
// follows a symbolic link at the end of a write or edit path; the privileged access resolves every
// path below "/" with openat2(RESOLVE_BENEATH|RESOLVE_NO_SYMLINKS) and refuses a symbolic link at
// any level (doc/privilege.md 方法与目标). Once a file or directory is open, both modes run the same
// operation on its fd.
type fileAccess interface {
	// openReading opens path for reading, without blocking in open(2) on a FIFO that has no writer:
	// that open waits for a writer, and a cancelled task cannot interrupt it.
	openReading(path string) (*os.File, error)
	// openStat opens path itself for a stat, without following a symbolic link: the unprivileged
	// mode reports the link it finds, the privileged one refuses it while resolving.
	openStat(path string) (*os.File, error)
	// openList opens the directory a listing reports and refuses the paths it must not list: a FIFO
	// or socket is not_regular_file, any other non-directory is not_a_directory. The unprivileged
	// mode stats the path first and opens it only when it is a directory: opening a character or
	// block device can have side effects (a tty raises DTR, a tape rewinds). The privileged mode
	// opens it with openat2 and stats the descriptor, as it does for every operation.
	openList(path string) (*os.File, error)
	// statEntry stats the directory entry name below dir, without following a final symbolic link.
	// The unprivileged mode names the entry path in the error, as the path-based stat did; the
	// privileged one reports the error as it did before it worked through the directory fd.
	statEntry(dir *os.File, name string) (unix.Stat_t, error)
	// openWrite resolves the destination of a write or edit of path and opens the directory it is
	// published into. edit says the destination must already exist, so a missing parent is reported
	// against the target path, as the open the unprivileged edit did; a write reports the directory
	// it could not open. The caller closes the returned directory.
	openWrite(path string, edit bool) (*writeTarget, error)
	// openExisting opens the file an edit reads, inside the directory its target was resolved to.
	openExisting(t *writeTarget) (*os.File, error)
}

// writeTarget is the destination of a write or edit: the parent directory (an fd that keeps the
// resolution it was opened with), the destination's name in it, the path to report in a message,
// and the stat of an existing destination.
type writeTarget struct {
	dir      *os.File
	name     string
	path     string
	existing *fileAttr
}

// fileAttr is what a write or edit keeps from the file it replaces: its raw mode (including setuid,
// setgid and sticky) and its owner.
type fileAttr struct {
	mode     uint32
	uid, gid int
}

// notRegular maps ENXIO, which is what opening a socket inode returns, to not_regular_file: a socket
// can no more be read to its end than a FIFO (doc/privilege.md 方法与目标).
func notRegular(err error, path string) error {
	if errors.Is(err, unix.ENXIO) {
		return errf("not_regular_file", "%s is not a regular file", path)
	}
	return err
}

// checkNotSpecial refuses a FIFO or socket: neither can be read to its end, and reading a FIFO
// may block forever even when the task is cancelled (doc/privilege.md 方法与目标).
func checkNotSpecial(fi fs.FileInfo, path string) error {
	if fi.Mode()&fs.ModeNamedPipe != 0 || fi.Mode()&fs.ModeSocket != 0 {
		return errf("not_regular_file", "%s is not a regular file", path)
	}
	return nil
}

// clearNonblocking restores blocking reads on a regular file opened with O_NONBLOCK.
func clearNonblocking(f *os.File) error {
	flags, err := unix.FcntlInt(f.Fd(), unix.F_GETFL, 0)
	if err != nil {
		return err
	}
	if flags&unix.O_NONBLOCK == 0 {
		return nil
	}
	_, err = unix.FcntlInt(f.Fd(), unix.F_SETFL, flags&^unix.O_NONBLOCK)
	return err
}

// openAt opens name in the directory fd with flags, naming the result path in an error message.
func openAt(dir *os.File, name string, flags int, path string) (*os.File, error) {
	fd, err := unix.Openat(int(dir.Fd()), name, flags|unix.O_CLOEXEC, 0)
	if err != nil {
		return nil, &os.PathError{Op: "open", Path: path, Err: err}
	}
	return os.NewFile(uintptr(fd), path), nil
}

// readLink returns the target of the symbolic link the O_PATH fd refers to.
func readLink(f *os.File) (string, error) {
	buf := make([]byte, 1<<12)
	for {
		n, err := unix.Readlinkat(int(f.Fd()), "", buf)
		if err != nil {
			return "", &os.PathError{Op: "readlink", Path: f.Name(), Err: err}
		}
		if n < len(buf) {
			return string(buf[:n]), nil
		}
		buf = make([]byte, 2*len(buf))
	}
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

// plainAccess opens paths directly. A symbolic link at the end of a write or edit path is followed
// to its target: a link is a name for its target, so the write replaces the target and keeps the
// link (resolveWriteTarget).
type plainAccess struct{}

func (plainAccess) openReading(path string) (*os.File, error) {
	fd, err := unix.Open(path, unix.O_RDONLY|unix.O_NONBLOCK|unix.O_CLOEXEC, 0)
	if err != nil {
		return nil, notRegular(&os.PathError{Op: "open", Path: path, Err: err}, path)
	}
	return os.NewFile(uintptr(fd), path), nil
}

// openStat opens the path itself, without following a final symbolic link, so the stat reports the
// link instead of its target. The error keeps saying "lstat", as the path-based stat did.
func (plainAccess) openStat(path string) (*os.File, error) {
	fd, err := unix.Open(path, unix.O_PATH|unix.O_NOFOLLOW|unix.O_CLOEXEC, 0)
	if err != nil {
		return nil, &os.PathError{Op: "lstat", Path: path, Err: err}
	}
	return os.NewFile(uintptr(fd), path), nil
}

// openList stats the path before opening it, as the path-based listing did: opening a character or
// block device can have side effects (a tty raises DTR, a tape rewinds), and a FIFO with no writer
// would wait in open(2). A final symbolic link is followed, as os.Stat and the old open did.
func (plainAccess) openList(path string) (*os.File, error) {
	fi, err := os.Stat(path)
	if err != nil {
		return nil, err
	}
	if err := checkNotSpecial(fi, path); err != nil {
		return nil, err
	}
	if !fi.IsDir() {
		if fi.Mode().IsRegular() {
			// While the listing opened the path, an unreadable regular file was reported as
			// permission_denied. Probe read permission instead of opening the file: the probe has no
			// side effects, and the message keeps the open(2) wording the task reported.
			if err := unix.Faccessat(unix.AT_FDCWD, path, unix.R_OK, unix.AT_EACCESS); err != nil {
				return nil, &os.PathError{Op: "open", Path: path, Err: err}
			}
		}
		return nil, errf("not_a_directory", "%s is not a directory", path)
	}
	// O_DIRECTORY keeps the open from succeeding if the path stopped being a directory after the
	// stat: opening a FIFO or device that replaced it would have the side effects the stat avoids.
	f, err := os.OpenFile(path, os.O_RDONLY|unix.O_DIRECTORY, 0)
	if err != nil {
		return nil, err
	}
	return f, nil
}

// statEntry stats one entry through the directory fd. The error keeps the "lstat dir/name" wording
// of the path-based stat the listing used before it worked through the fd.
func (plainAccess) statEntry(dir *os.File, name string) (unix.Stat_t, error) {
	var st unix.Stat_t
	if err := unix.Fstatat(int(dir.Fd()), name, &st, unix.AT_SYMLINK_NOFOLLOW); err != nil {
		return st, &os.PathError{Op: "lstat", Path: filepath.Join(dir.Name(), name), Err: err}
	}
	return st, nil
}

func (plainAccess) openWrite(path string, edit bool) (*writeTarget, error) {
	target, fi, err := resolveWriteTarget(path)
	if err != nil {
		return nil, err
	}
	if fi != nil && fi.IsDir() {
		return nil, errf("is_directory", "%s is a directory", path)
	}
	dir, name, err := splitParent(target)
	if err != nil {
		return nil, err
	}
	// O_PATH opens the directory with search permission alone, which creating a file in it needs;
	// reading it would need more.
	fd, err := unix.Open(dir, unix.O_PATH|unix.O_DIRECTORY|unix.O_CLOEXEC, 0)
	if err != nil {
		// An edit opens the target itself, so HEAD named the target when its parent was missing; a
		// write creates a temporary file in the parent, and the new message names the directory.
		report := dir
		if edit {
			report = target
		}
		return nil, &os.PathError{Op: "open", Path: report, Err: err}
	}
	t := &writeTarget{dir: os.NewFile(uintptr(fd), dir), name: name, path: target}
	if fi != nil {
		uid, gid := statIDs(fi)
		t.existing = &fileAttr{mode: statMode(fi), uid: uid, gid: gid}
	}
	return t, nil
}

// openExisting opens the destination for reading. A symbolic link that appeared after the target
// was resolved is followed, as a normal open does.
func (plainAccess) openExisting(t *writeTarget) (*os.File, error) {
	f, err := openAt(t.dir, t.name, unix.O_RDONLY|unix.O_NONBLOCK, t.path)
	if err != nil {
		return nil, notRegular(err, t.path)
	}
	return f, nil
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

// privilegedAccess resolves every path with openat2 from the root fd and refuses a symbolic link at
// any level (doc/privilege.md 方法与目标).
type privilegedAccess struct{ root *privilegedFileRoot }

func (a privilegedAccess) openReading(path string) (*os.File, error) {
	f, err := a.root.open(path, unix.O_RDONLY|unix.O_NONBLOCK)
	if err != nil {
		return nil, notRegular(err, path)
	}
	return f, nil
}

// openStat uses O_PATH, which is enough to fstat and cannot block on a FIFO or device.
func (a privilegedAccess) openStat(path string) (*os.File, error) {
	return a.root.open(path, unix.O_PATH)
}

// openList opens the path with openat2 and stats the descriptor, as every privileged operation does:
// the path is resolved without a symbolic link, and the type checks run on the fd.
func (a privilegedAccess) openList(path string) (*os.File, error) {
	f, err := a.openReading(path)
	if err != nil {
		return nil, err
	}
	fi, err := f.Stat()
	if err != nil {
		f.Close()
		return nil, err
	}
	if err := checkNotSpecial(fi, path); err != nil {
		f.Close()
		return nil, err
	}
	if !fi.IsDir() {
		f.Close()
		return nil, errf("not_a_directory", "%s is not a directory", path)
	}
	return f, nil
}

// statEntry reports the raw Fstatat error, as the privileged listing did before it was shared.
func (privilegedAccess) statEntry(dir *os.File, name string) (unix.Stat_t, error) {
	var st unix.Stat_t
	err := unix.Fstatat(int(dir.Fd()), name, &st, unix.AT_SYMLINK_NOFOLLOW)
	return st, err
}

func (a privilegedAccess) openWrite(path string, _ bool) (*writeTarget, error) {
	dir, name, err := splitParent(path)
	if err != nil {
		return nil, err
	}
	// The parent directory is resolved the same way; only then is the destination touched, and only
	// through the directory fd, so a symlink anywhere on the way in cannot redirect the write. O_PATH
	// does not require read permission on the directory, which creating a file does not need either.
	dfd, err := a.root.open(dir, unix.O_PATH|unix.O_DIRECTORY)
	if err != nil {
		return nil, err
	}
	t := &writeTarget{dir: dfd, name: name, path: path}
	var st unix.Stat_t
	switch err := unix.Fstatat(int(dfd.Fd()), name, &st, unix.AT_SYMLINK_NOFOLLOW); {
	case err == nil:
		switch st.Mode & unix.S_IFMT {
		case unix.S_IFLNK:
			dfd.Close()
			return nil, errf("symlink_not_allowed", "%s is a symbolic link", path)
		case unix.S_IFDIR:
			dfd.Close()
			return nil, errf("is_directory", "%s is a directory", path)
		}
		t.existing = &fileAttr{mode: st.Mode, uid: int(st.Uid), gid: int(st.Gid)}
	case errors.Is(err, unix.ENOENT):
	default:
		dfd.Close()
		return nil, err
	}
	return t, nil
}

// openExisting opens the destination for reading. O_NOFOLLOW covers the race between the stat check
// in openWrite and this open: the final component is never followed, and the parent comes from the
// already resolved directory fd. O_NONBLOCK keeps the open from waiting for a FIFO writer that a
// cancellation cannot wake (doc/privilege.md 方法与目标).
func (a privilegedAccess) openExisting(t *writeTarget) (*os.File, error) {
	f, err := openAt(t.dir, t.name, unix.O_RDONLY|unix.O_NOFOLLOW|unix.O_NONBLOCK, t.path)
	if err != nil {
		switch {
		case errors.Is(err, unix.ELOOP):
			return nil, errf("symlink_not_allowed", "%s is a symbolic link", t.path)
		case errors.Is(err, unix.ENOENT) && t.existing == nil:
			// HEAD's privileged edit failed at the stat of the missing file and reported the bare
			// errno; keep that message now that the open reports the missing file.
			return nil, unix.ENOENT
		}
		return nil, notRegular(err, t.path)
	}
	return f, nil
}

// statMode returns the raw mode of fi, including setuid, setgid and sticky, which fs.FileMode
// keeps as separate flags instead of permission bits.
func statMode(fi fs.FileInfo) uint32 {
	if st, ok := fi.Sys().(*syscall.Stat_t); ok {
		return uint32(st.Mode)
	}
	return uint32(fi.Mode().Perm())
}

// statIDs returns the owner of fi, or -1 when the platform does not report it.
func statIDs(fi fs.FileInfo) (uid, gid int) {
	if st, ok := fi.Sys().(*syscall.Stat_t); ok {
		return int(st.Uid), int(st.Gid)
	}
	return -1, -1
}
