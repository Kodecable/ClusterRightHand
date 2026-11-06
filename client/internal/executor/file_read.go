package executor

import (
	"bufio"
	"context"
	"errors"
	"io"

	"github.com/Kodecable/ClusterRightHand/client/internal/protocol"
)

// fileRead executes a file.read task: it opens the file as the mode permits, refuses a directory and
// the files that cannot be read to their end, and writes the requested page to stdout.
func fileRead(ctx context.Context, acc fileAccess, s *protocol.FileReadSpec, stdout io.Writer) (*protocol.TaskResult, error) {
	if err := checkPath(s.Path); err != nil {
		return nil, err
	}
	f, err := acc.openReading(s.Path)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	fi, err := f.Stat()
	if err != nil {
		return nil, err
	}
	if fi.IsDir() {
		return nil, errf(protocol.CodeIsDirectory, "%s is a directory", s.Path)
	}
	if err := checkNotSpecial(fi, s.Path); err != nil {
		return nil, err
	}
	if fi.Mode().IsRegular() {
		if err := clearNonblocking(f); err != nil {
			return nil, err
		}
	}
	page, err := readPage(ctx, f, s, stdout)
	if err != nil {
		return nil, err
	}
	return &protocol.TaskResult{Kind: protocol.TaskResultFileRead, FileRead: page}, nil
}

// readPage writes lineCount lines from startLine (1-based) to stdout and returns what the page holds:
// which lines they are, whether the file ended, its line count when it did, and whether the requested
// line alone is too long. It scans from the start of the file and stops at the line count or at the
// byte cap, whole lines only; it does not read the rest of the file (doc/protocol.md#任务).
func readPage(ctx context.Context, r io.Reader, s *protocol.FileReadSpec, stdout io.Writer) (*protocol.FileReadResult, error) {
	if s.StartLine < 1 || s.LineCount < 1 {
		return nil, errf(protocol.CodeInvalidSpec, "startLine and lineCount must be at least 1")
	}
	res := protocol.FileReadResult{}
	lr := &lineReader{br: bufio.NewReaderSize(r, 64<<10)}
	start, count := uint64(s.StartLine), uint64(s.LineCount)
	line := uint64(1) // the line about to be read
	// The node scans to the start line: skipped lines are discarded, never kept.
	for line < start {
		if err := ctx.Err(); err != nil {
			return nil, err
		}
		next, err := lr.next(ctx, 0, false)
		if err != nil {
			return nil, err
		}
		if !next.exists || next.last {
			// The file has no line startLine, so the scan reached its end.
			total := line - 1
			if next.exists {
				total = line
			}
			res.EOF, res.Total = true, totalPtr(total)
			return &res, nil
		}
		line++
	}
	written := uint64(0)
	pageLines := uint64(0)
	for pageLines < count {
		if err := ctx.Err(); err != nil {
			return nil, err
		}
		next, err := lr.next(ctx, protocol.FileReadMaxBytes+1, true)
		if err != nil {
			return nil, err
		}
		if !next.exists {
			total := line - 1
			res.EOF, res.Total = true, totalPtr(total)
			break
		}
		if next.tooLong || written+uint64(len(next.text)) > protocol.FileReadMaxBytes {
			// The line does not fit the page; alone on the page, it cannot be shown at all.
			res.TooLong = pageLines == 0
			break
		}
		if _, err := stdout.Write(next.text); err != nil {
			return nil, err
		}
		written += uint64(len(next.text))
		if pageLines == 0 {
			res.From = protocol.Uint(line)
		}
		res.To = protocol.Uint(line)
		pageLines++
		if next.last {
			res.EOF, res.Total = true, totalPtr(line)
			break
		}
		line++
	}
	if pageLines == count && !res.EOF {
		// The page ends on its line count: one byte tells whether the file ends there too.
		if _, err := lr.br.Peek(1); errors.Is(err, io.EOF) {
			res.EOF, res.Total = true, totalPtr(uint64(res.To))
		}
	}
	return &res, nil
}

// totalPtr is the line count a page reports; it is set only when the scan reached the end.
func totalPtr(lines uint64) *protocol.Uint {
	total := protocol.Uint(lines)
	return &total
}

// lineRead is one line of a file as lineReader found it.
type lineRead struct {
	// text is the line's bytes, its terminating newline included; nil when the caller keeps no text.
	text []byte
	// exists is false at the end of the file: there is no such line.
	exists bool
	// last means the line was the file's last one and had no terminating newline.
	last bool
	// tooLong means the kept line is longer than the limit the caller gave.
	tooLong bool
}

// lineReader reads a file line by line, keeping one line in memory at most: a line over the limit is
// reported as too long instead of being read to its end. Lines end at "\n", so a CRLF line keeps its
// "\r" (doc/protocol.md#任务).
type lineReader struct {
	br  *bufio.Reader
	buf []byte
}

// next reads the next line. With keep false its bytes are dropped, so a long line before the page
// costs nothing; with keep true they are returned up to max bytes, and tooLong is set beyond that.
// The context is checked before every chunk: one line can be arbitrarily long (a file without a
// newline, a character device that never ends), so a cancellation must not wait for its end.
func (r *lineReader) next(ctx context.Context, max int, keep bool) (lineRead, error) {
	r.buf = r.buf[:0]
	read := false
	for {
		if err := ctx.Err(); err != nil {
			return lineRead{}, err
		}
		chunk, err := r.br.ReadSlice('\n')
		read = read || len(chunk) > 0
		if keep {
			if len(r.buf)+len(chunk) > max {
				return lineRead{exists: true, tooLong: true}, nil
			}
			r.buf = append(r.buf, chunk...)
		}
		switch {
		case err == nil:
			return lineRead{text: r.buf, exists: true}, nil
		case errors.Is(err, bufio.ErrBufferFull):
			continue
		case errors.Is(err, io.EOF):
			if !read {
				return lineRead{}, nil
			}
			return lineRead{text: r.buf, exists: true, last: true}, nil
		default:
			return lineRead{}, err
		}
	}
}
