package executor

import (
	"fmt"
	"io/fs"
	"os/user"
	"strconv"
	"time"

	"golang.org/x/sys/unix"

	"github.com/Kodecable/ClusterRightHand/client/internal/protocol"
)

// fileStat executes a file.stat task on the path itself: the unprivileged mode reports a symbolic
// link as such, with its target, while the privileged mode refuses a link while resolving.
func fileStat(acc fileAccess, s *protocol.FileStatSpec) (*protocol.TaskResult, error) {
	if err := checkPath(s.Path); err != nil {
		return nil, err
	}
	f, err := acc.openStat(s.Path)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	fi, err := f.Stat()
	if err != nil {
		return nil, err
	}
	out := statValues(s.Path, fi)
	if fi.Mode()&fs.ModeSymlink != 0 {
		target, err := readLink(f)
		if err != nil {
			return nil, err
		}
		out.LinkTarget = &target
	}
	return &protocol.TaskResult{Kind: protocol.TaskResultFileStat, FileStat: out}, nil
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

// editMode returns the mode a file.write or file.edit keeps: the permission bits plus setuid, setgid
// and sticky.
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
