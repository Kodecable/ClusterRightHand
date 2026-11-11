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
	"os/user"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"

	"golang.org/x/sys/unix"

	"github.com/Kodecable/ClusterRightHand/client/internal/protocol"
)

// fileWrite executes a file.write task: it verifies the input against the declared size and SHA-256,
// writes it to a temporary file next to the destination, and publishes it with the requested or the
// existing mode and owner (doc/design/execution.md "File tasks").
func fileWrite(ctx context.Context, acc fileAccess, s *protocol.FileWriteSpec, input io.Reader) (*protocol.TaskResult, error) {
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
	if s.CreateParentDirs {
		// mkdir -p semantics: the new directories are 0755 before the umask and, when an owner or
		// group is requested, belong to the same identity as the file.
		if err := acc.makeParentDirs(path, uid, gid); err != nil {
			return nil, err
		}
	}
	t, err := acc.openWrite(path, false)
	if err != nil {
		return nil, err
	}
	defer t.dir.Close()
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

	want := s.Content
	h := sha256.New()
	n, err := copyCtx(ctx, io.MultiWriter(tmp, h), io.LimitReader(input, int64(want.Size)+1))
	if err != nil {
		return nil, err
	}
	if uint64(n) != uint64(want.Size) || !bytes.Equal(h.Sum(nil), want.SHA256[:]) {
		return nil, errf(protocol.CodeInputMismatch, "content does not match declared size/sha256 (got %d bytes)", n)
	}

	mode := fs.FileMode(0o644)
	switch {
	case s.Mode != 0:
		mode = editMode(uint32(s.Mode))
	case t.existing != nil:
		mode = editMode(t.existing.mode)
	}
	if t.existing != nil && uid < 0 && gid < 0 {
		if err := tmp.Chown(t.existing.uid, t.existing.gid); err != nil && !errors.Is(err, syscall.EPERM) {
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
	if err := publishAt(t.dir, tmpName, tmp, t.name, path, !s.Overwrite); err != nil {
		return nil, err
	}
	ok = true
	return &protocol.TaskResult{Kind: protocol.TaskResultFileWrite, FileWrite: &protocol.FileWriteResult{
		Bytes: protocol.Uint(n), Created: t.existing == nil,
	}}, nil
}

// lookupIDs resolves the requested owner and group names to ids; -1 means "keep the destination's".
func lookupIDs(owner, group string) (uid, gid int, err error) {
	uid, gid = -1, -1
	if owner != "" {
		u, e := user.Lookup(owner)
		if e != nil {
			return 0, 0, errf(protocol.CodeInvalidSpec, "unknown owner %q", owner)
		}
		uid, _ = strconv.Atoi(u.Uid)
	}
	if group != "" {
		g, e := user.LookupGroup(group)
		if e != nil {
			return 0, 0, errf(protocol.CodeInvalidSpec, "unknown group %q", group)
		}
		gid, _ = strconv.Atoi(g.Gid)
	}
	return uid, gid, nil
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
	return "", nil, errf(protocol.CodeIOError, "cannot create a temporary file in %s", dir.Name())
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
			return errf(protocol.CodeExists, "%s already exists", path)
		}
		// Report the bare rename error: a LinkError would prefix it with the temporary file's
		// random name, which the user cannot act on.
		return err
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
