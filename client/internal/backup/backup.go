// Package backup keeps the files crha replaces when it upgrades or re-enrolls a node, so they can be put
// back (doc/design/distribution.md "Backups"). One backup is one directory below Dir with a manifest:
// a self-upgrade's is task-<task id>, an enrollment's is enroll-<time>. A backup holds only the fixed set
// of files crha manages; the node's identity key and the privileged mode's state are never part of one.
package backup

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"slices"
	"sort"
	"strconv"
	"strings"
	"syscall"
	"time"
)

const (
	// Dir holds the backups: root's, 0700, below the upgrade directory.
	Dir = "/var/lib/crha-upgrade/backups"
	// ManifestName is each backup's manifest.
	ManifestName = "manifest.json"
)

// The kinds of backup, and the prefixes of their directory names.
const (
	KindUpgrade = "upgrade"
	KindEnroll  = "enroll"
)

// Keep is how many backups of each kind are kept.
var Keep = map[string]int{KindUpgrade: 2, KindEnroll: 5}

// UpgradeID is the backup id of the self-upgrade task taskID.
func UpgradeID(taskID string) string { return "task-" + taskID }

// EnrollID is the backup id of an enrollment at t.
func EnrollID(t time.Time) string { return "enroll-" + t.UTC().Format("20060102T150405.000000000Z") }

func kindOf(id string) string {
	switch {
	case strings.HasPrefix(id, "task-"):
		return KindUpgrade
	case strings.HasPrefix(id, "enroll-"):
		return KindEnroll
	}
	return ""
}

// Entry is one file of a backup: where its previous content is, and what crha left in it.
type Entry struct {
	Path    string `json:"path"`
	Backup  string `json:"backup,omitempty"`
	Existed bool   `json:"existed"`
	Mode    uint32 `json:"mode"`
	UID     int    `json:"uid"`
	GID     int    `json:"gid"`
	// After is the SHA-256 of the file once crha wrote it, empty when the file is absent.
	After string `json:"after"`
}

// Manifest describes one backup.
type Manifest struct {
	Kind    string    `json:"kind"`
	ID      string    `json:"id"`
	Created time.Time `json:"created"`
	// From and To are the versions of an upgrade; an enrollment's are both the running version.
	From string `json:"from"`
	To   string `json:"to"`
	// Units are the units the node ran, in start order, which a restore starts again.
	Units   []string `json:"units"`
	Entries []Entry  `json:"entries"`
}

// File is one file to back up, with its content after the change: nil when it will be absent.
type File struct {
	Path  string
	After []byte
}

// Options are the parts of a backup that are not files.
type Options struct {
	// Root prefixes every file path (tests); Dir is not prefixed.
	Root string
	Dir  string
	ID   string
	From string
	To   string
	// Units are the units to start after a restore.
	Units []string
	Now   time.Time
}

// Path is the directory of backup id below dir (Dir when empty).
func Path(dir, id string) string {
	if dir == "" {
		dir = Dir
	}
	return filepath.Join(dir, id)
}

// Take copies the current content of every file and writes the manifest; it returns the manifest and
// its path.
func Take(opts Options, files []File) (*Manifest, string, error) {
	kind := kindOf(opts.ID)
	if kind == "" {
		return nil, "", fmt.Errorf("backup id %q has no kind", opts.ID)
	}
	dir := Path(opts.Dir, opts.ID)
	if err := os.MkdirAll(filepath.Dir(dir), 0o700); err != nil {
		return nil, "", err
	}
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return nil, "", err
	}
	now := opts.Now
	if now.IsZero() {
		now = time.Now()
	}
	m := &Manifest{Kind: kind, ID: opts.ID, Created: now.UTC(), From: opts.From, To: opts.To, Units: opts.Units}
	for i, f := range files {
		e := Entry{Path: f.Path}
		if f.After != nil {
			sum := sha256.Sum256(f.After)
			e.After = hex.EncodeToString(sum[:])
		}
		info, err := os.Stat(filepath.Join(opts.Root, f.Path))
		switch {
		case errors.Is(err, os.ErrNotExist):
		case err != nil:
			return nil, "", err
		default:
			e.Existed = true
			e.Mode = uint32(info.Mode().Perm())
			if st, ok := info.Sys().(*syscall.Stat_t); ok {
				e.UID, e.GID = int(st.Uid), int(st.Gid)
			}
			e.Backup = filepath.Join(dir, strconv.Itoa(i)+"-"+filepath.Base(f.Path))
			if err := copyFile(filepath.Join(opts.Root, f.Path), e.Backup); err != nil {
				return nil, "", err
			}
		}
		m.Entries = append(m.Entries, e)
	}
	data, err := json.MarshalIndent(m, "", "  ")
	if err != nil {
		return nil, "", err
	}
	manifestPath := filepath.Join(dir, ManifestName)
	if err := os.WriteFile(manifestPath, data, 0o600); err != nil {
		return nil, "", err
	}
	return m, manifestPath, nil
}

// Read reads a manifest.
func Read(path string) (*Manifest, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	var m Manifest
	if err := json.Unmarshal(data, &m); err != nil {
		return nil, fmt.Errorf("%s: %w", path, err)
	}
	return &m, nil
}

// Restore puts every file of a manifest back as it was; a file that did not exist is removed.
func Restore(root string, m *Manifest) error {
	var errs []error
	for _, e := range m.Entries {
		path := filepath.Join(root, e.Path)
		if !e.Existed {
			if err := os.Remove(path); err != nil && !errors.Is(err, os.ErrNotExist) {
				errs = append(errs, err)
			}
			continue
		}
		data, err := os.ReadFile(e.Backup)
		if err == nil {
			err = ReplaceFile(path, data, os.FileMode(e.Mode))
		}
		if err == nil {
			_ = os.Lchown(path, e.UID, e.GID)
		}
		if err != nil {
			errs = append(errs, fmt.Errorf("restore %s: %w", e.Path, err))
		}
	}
	return errors.Join(errs...)
}

// Modified lists the files of a manifest whose content is no longer what crha left in them.
func Modified(root string, m *Manifest) ([]string, error) {
	var out []string
	for _, e := range m.Entries {
		now, err := FileHash(filepath.Join(root, e.Path))
		if err != nil {
			return nil, err
		}
		if now != e.After {
			out = append(out, e.Path)
		}
	}
	return out, nil
}

// Prune keeps the newest Keep[kind] backups of each kind in dir (Dir when empty) and removes the
// others, never the ones in except. A directory without a manifest (an upgrade that failed before its
// backup) is ordered by its modification time.
func Prune(dir string, except ...string) error {
	if dir == "" {
		dir = Dir
	}
	entries, err := os.ReadDir(dir)
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	if err != nil {
		return err
	}
	type found struct {
		id   string
		when time.Time
	}
	byKind := map[string][]found{}
	for _, d := range entries {
		kind := kindOf(d.Name())
		if !d.IsDir() || kind == "" {
			continue
		}
		when := time.Time{}
		if m, err := Read(filepath.Join(dir, d.Name(), ManifestName)); err == nil {
			when = m.Created
		} else if info, err := d.Info(); err == nil {
			when = info.ModTime()
		}
		byKind[kind] = append(byKind[kind], found{d.Name(), when})
	}
	var errs []error
	for kind, list := range byKind {
		sort.Slice(list, func(i, j int) bool { return list[i].when.After(list[j].when) })
		kept := 0
		for _, f := range list {
			if slices.Contains(except, f.id) {
				continue
			}
			if kept < Keep[kind] {
				kept++
				continue
			}
			if err := os.RemoveAll(filepath.Join(dir, f.id)); err != nil {
				errs = append(errs, err)
			}
		}
	}
	return errors.Join(errs...)
}

// ReplaceFile writes data next to path and renames it into place, keeping the old file's owner.
func ReplaceFile(path string, data []byte, mode os.FileMode) error {
	tmp := path + ".crha-new"
	_ = os.Remove(tmp)
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return err
	}
	f, err := os.OpenFile(tmp, os.O_WRONLY|os.O_CREATE|os.O_EXCL|syscall.O_NOFOLLOW, mode)
	if err != nil {
		return fmt.Errorf("write %s: %w", path, err)
	}
	_, err = f.Write(data)
	if err == nil {
		err = f.Sync()
	}
	if cerr := f.Close(); err == nil {
		err = cerr
	}
	if err == nil {
		err = os.Chmod(tmp, mode)
	}
	if err == nil {
		if info, serr := os.Stat(path); serr == nil {
			if st, ok := info.Sys().(*syscall.Stat_t); ok {
				_ = os.Lchown(tmp, int(st.Uid), int(st.Gid))
			}
		}
		err = os.Rename(tmp, path)
	}
	if err != nil {
		_ = os.Remove(tmp)
		return fmt.Errorf("write %s: %w", path, err)
	}
	return nil
}

func copyFile(from, to string) error {
	src, err := os.Open(from)
	if err != nil {
		return err
	}
	defer src.Close()
	dst, err := os.OpenFile(to, os.O_WRONLY|os.O_CREATE|os.O_TRUNC|syscall.O_NOFOLLOW, 0o600)
	if err != nil {
		return err
	}
	_, err = io.Copy(dst, src)
	if cerr := dst.Close(); err == nil {
		err = cerr
	}
	return err
}

// FileHash is the hex SHA-256 of a file, empty when it does not exist.
func FileHash(path string) (string, error) {
	data, err := os.ReadFile(path)
	if errors.Is(err, os.ErrNotExist) {
		return "", nil
	}
	if err != nil {
		return "", err
	}
	sum := sha256.Sum256(data)
	return hex.EncodeToString(sum[:]), nil
}
