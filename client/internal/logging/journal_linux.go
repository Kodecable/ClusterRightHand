//go:build linux

package logging

import "golang.org/x/sys/unix"

// fdStat returns the device and inode of fd, which journald compares with JOURNAL_STREAM.
func fdStat(fd int) (FdStat, error) {
	var st unix.Stat_t
	if err := unix.Fstat(fd, &st); err != nil {
		return FdStat{}, err
	}
	return FdStat{Dev: uint64(st.Dev), Ino: uint64(st.Ino)}, nil
}
