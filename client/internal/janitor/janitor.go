// Package janitor removes spilled task output files that are expired or
// exceed the configured total size.
package janitor

import (
	"context"
	"errors"
	"io/fs"
	"log/slog"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"time"
)

var logName = regexp.MustCompile(`^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.log$`)

// Options configures a sweep.
type Options struct {
	Dir      string
	MaxAge   time.Duration
	MaxTotal int64
	// InUse reports files that must not be deleted (tasks still running or
	// not yet acknowledged by crhs). Keys are absolute paths.
	InUse  func() map[string]bool
	Logger *slog.Logger
	Now    func() time.Time
}

type entry struct {
	path    string
	size    int64
	modTime time.Time
	inUse   bool
}

func (o Options) logger() *slog.Logger {
	if o.Logger != nil {
		return o.Logger
	}
	return slog.Default()
}

// Sweep deletes expired files, then the oldest files until the total size is
// within MaxTotal. It only touches regular files named "<uuid>.log" directly
// in Dir. It returns how many files and bytes it removed.
func Sweep(opts Options) (files int, bytes int64, err error) {
	log := opts.logger()
	now := time.Now
	if opts.Now != nil {
		now = opts.Now
	}

	dirEntries, err := os.ReadDir(opts.Dir)
	if err != nil {
		if errors.Is(err, fs.ErrNotExist) {
			return 0, 0, nil
		}
		return 0, 0, err
	}
	dir, err := filepath.Abs(opts.Dir)
	if err != nil {
		return 0, 0, err
	}
	var inUse map[string]bool
	if opts.InUse != nil {
		inUse = opts.InUse()
	}

	var list []entry
	for _, de := range dirEntries {
		if !de.Type().IsRegular() || !logName.MatchString(de.Name()) {
			continue
		}
		info, err := de.Info()
		if err != nil || !info.Mode().IsRegular() {
			continue
		}
		p := filepath.Join(dir, de.Name())
		list = append(list, entry{p, info.Size(), info.ModTime(), inUse[p]})
	}

	var total int64
	for _, e := range list {
		total += e.size
	}

	remove := func(e entry) {
		if err := os.Remove(e.path); err != nil {
			if errors.Is(err, fs.ErrNotExist) {
				total -= e.size
			} else {
				log.Warn("remove output file", "path", e.path, "err", err)
			}
			return
		}
		total -= e.size
		files++
		bytes += e.size
	}

	cutoff := now().Add(-opts.MaxAge)
	kept := list[:0]
	for _, e := range list {
		if opts.MaxAge > 0 && !e.inUse && e.modTime.Before(cutoff) {
			remove(e)
			continue
		}
		kept = append(kept, e)
	}

	if opts.MaxTotal > 0 && total > opts.MaxTotal {
		sort.Slice(kept, func(i, j int) bool { return kept[i].modTime.Before(kept[j].modTime) })
		for _, e := range kept {
			if total <= opts.MaxTotal {
				break
			}
			if !e.inUse {
				remove(e)
			}
		}
		if total > opts.MaxTotal {
			log.Warn("output files in use exceed max_total", "total", total, "max_total", opts.MaxTotal)
		}
	}
	return files, bytes, nil
}

// Run sweeps at start and then every interval until ctx is done.
func Run(ctx context.Context, opts Options, interval time.Duration) {
	sweep := func() {
		files, bytes, err := Sweep(opts)
		if err != nil {
			opts.logger().Warn("output sweep failed", "err", err)
		} else if files > 0 {
			opts.logger().Info("output sweep", "files", files, "bytes", bytes)
		}
	}
	sweep()
	t := time.NewTicker(interval)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			sweep()
		}
	}
}
