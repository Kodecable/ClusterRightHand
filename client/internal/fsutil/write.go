package fsutil

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"syscall"
)

// Owner is the owner a written file gets.
type Owner struct{ UID, GID int }

// WriteOptions are WriteFile's choices beyond the content and mode.
type WriteOptions struct {
	// Owner is set on the file before it takes its name; nil keeps the owner of the file it replaces,
	// or the writer's when there is none.
	Owner *Owner
	// Exclusive publishes the file only if path does not exist yet (link(2) instead of rename(2)), and
	// fails with an error matching os.ErrExist otherwise: an earlier or concurrent write is never replaced.
	Exclusive bool
}

// WriteFile replaces path with data (or, Exclusive, creates it) so that a reader, or a crash, sees the
// old content or the new one whole. The temporary file has a random name and is created exclusively, so
// a link planted in the directory is never followed, even when root writes into a directory another
// user owns; its mode and owner are set through the open file, it is synced, renamed (or linked) to
// path, and the directory is synced.
func WriteFile(path string, data []byte, mode os.FileMode, opts WriteOptions) (err error) {
	dir := filepath.Dir(path)
	tmp, err := os.CreateTemp(dir, "."+filepath.Base(path)+".crh-*")
	if err != nil {
		return fmt.Errorf("write %s: %w", path, err)
	}
	name := tmp.Name()
	defer func() {
		if err != nil {
			_ = tmp.Close()
			_ = os.Remove(name)
			err = fmt.Errorf("write %s: %w", path, err)
		}
	}()
	if err = tmp.Chmod(mode); err != nil {
		return err
	}
	owner := opts.Owner
	if owner == nil {
		if info, serr := os.Lstat(path); serr == nil {
			if st, ok := info.Sys().(*syscall.Stat_t); ok {
				owner = &Owner{UID: int(st.Uid), GID: int(st.Gid)}
			}
		} else if !errors.Is(serr, os.ErrNotExist) {
			return serr
		}
	}
	if owner != nil {
		if err = tmp.Chown(owner.UID, owner.GID); err != nil {
			return err
		}
	}
	if _, err = tmp.Write(data); err != nil {
		return err
	}
	if err = tmp.Sync(); err != nil {
		return err
	}
	if err = tmp.Close(); err != nil {
		return err
	}
	if opts.Exclusive {
		if err = os.Link(name, path); err != nil {
			return err
		}
		if err = os.Remove(name); err != nil {
			return err
		}
	} else if err = os.Rename(name, path); err != nil {
		return err
	}
	return SyncDir(dir)
}
