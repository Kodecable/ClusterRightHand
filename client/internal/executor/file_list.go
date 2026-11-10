package executor

import (
	"context"
	"errors"
	"sort"
	"time"

	"golang.org/x/sys/unix"

	"github.com/Kodecable/ClusterRightHand/client/internal/protocol"
)

// fileList executes a file.list task: it opens the directory as the mode permits, refuses the files
// that cannot be listed, and reports its entries up to the task's limit and the frame budget.
func fileList(ctx context.Context, acc fileAccess, s *protocol.FileListSpec) (*protocol.TaskResult, error) {
	if err := checkPath(s.Path); err != nil {
		return nil, err
	}
	limit := int(s.Limit)
	if limit == 0 {
		limit = defaultListLimit
	}
	limit = min(limit, maxListLimit)

	// openList refuses a FIFO, socket or other non-directory. The unprivileged mode decides from the
	// stat alone, so it never opens a device that could have side effects.
	dir, err := acc.openList(s.Path)
	if err != nil {
		return nil, err
	}
	defer dir.Close()
	if err := clearNonblocking(dir); err != nil {
		return nil, err
	}
	des, err := dir.ReadDir(-1)
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
		// Stat every entry through the directory fd: DirEntry.Info would resolve the name by path
		// again, outside the fd the directory was opened with.
		st, err := acc.statEntry(dir, de.Name())
		if errors.Is(err, unix.ENOENT) {
			continue
		}
		if err != nil {
			return nil, err
		}
		mode := fileMode(st.Mode)
		entry := protocol.FileListEntry{
			Name:  de.Name(),
			Type:  fileType(mode),
			Size:  protocol.Int(st.Size),
			Mode:  modeString(mode),
			MTime: mtimeFromStat(&st),
		}
		size := listEntrySize(entry)
		// The result travels in one task.exit frame: stop before it could outgrow it
		// (doc/design/protocol.md "Task results").
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

func mtimeFromStat(st *unix.Stat_t) string {
	return time.Unix(st.Mtim.Sec, st.Mtim.Nsec).UTC().Format(time.RFC3339Nano)
}
