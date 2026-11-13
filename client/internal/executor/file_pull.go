package executor

import (
	"context"
	"crypto/sha256"
	"io"

	"github.com/Kodecable/ClusterRightHand/client/internal/protocol"
)

// RunPull executes a file.pull task: it opens the regular file as the mode permits, refuses a file
// larger than the spec's MaxBytes before sending anything, and streams its bytes to emit while
// hashing them. It returns the size and SHA-256 the receiver checks (doc/design/library.md "File
// plane"). A nil emit discards the bytes, for callers that only need the result.
func RunPull(ctx context.Context, spec *protocol.TaskSpec, emit func([]byte) error, privileged bool) (*protocol.TaskResult, error) {
	if spec.Kind != protocol.TaskSpecFilePull || spec.FilePull == nil {
		return nil, errf(protocol.CodeInvalidSpec, "file.pull task has no spec")
	}
	var acc fileAccess = plainAccess{}
	if privileged {
		root, err := openPrivilegedFileRoot()
		if err != nil {
			return nil, normalizeErr(err)
		}
		defer root.Close()
		acc = privilegedAccess{root: root}
	}
	result, err := filePull(ctx, acc, spec.FilePull, emit)
	return result, normalizeErr(err)
}

// filePull streams a regular file to emit. The size is checked from the stat before the first byte,
// so a file over the destination's limit is refused with too_large instead of being sent.
func filePull(ctx context.Context, acc fileAccess, s *protocol.FilePullSpec, emit func([]byte) error) (*protocol.TaskResult, error) {
	if err := checkPath(s.Path); err != nil {
		return nil, err
	}
	f, err := acc.openReading(s.Path)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	if err := clearNonblocking(f); err != nil {
		return nil, err
	}
	fi, err := f.Stat()
	if err != nil {
		return nil, err
	}
	if uint64(fi.Size()) > uint64(s.MaxBytes) {
		return nil, errf(protocol.CodeTooLarge, "%s is %d bytes, the destination accepts at most %d", s.Path, fi.Size(), uint64(s.MaxBytes))
	}
	if emit == nil {
		emit = func([]byte) error { return nil }
	}
	h := sha256.New()
	buf := make([]byte, copyChunk)
	var total uint64
	for {
		if err := ctx.Err(); err != nil {
			return nil, err
		}
		n, rerr := f.Read(buf)
		if n > 0 {
			total += uint64(n)
			if total > uint64(s.MaxBytes) {
				return nil, errf(protocol.CodeTooLarge, "%s grew past the destination's limit of %d bytes", s.Path, uint64(s.MaxBytes))
			}
			h.Write(buf[:n])
			if err := emit(buf[:n]); err != nil {
				return nil, err
			}
		}
		if rerr == io.EOF {
			break
		}
		if rerr != nil {
			return nil, rerr
		}
	}
	return &protocol.TaskResult{Kind: protocol.TaskResultFilePull, FilePull: &protocol.FilePullResult{
		Size: protocol.Uint(total), SHA256: protocol.Hash(h.Sum(nil)),
	}}, nil
}
