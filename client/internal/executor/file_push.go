package executor

import (
	"context"
	"io"

	"github.com/Kodecable/ClusterRightHand/client/internal/protocol"
)

// filePush executes a file.push task: the bytes arrive on a data connection as the task's input and
// are written exactly like a file.write with the same path, size, SHA-256, overwrite and mode/owner
// settings. The task has no structured result (doc/design/library.md "File plane").
func filePush(ctx context.Context, acc fileAccess, s *protocol.FilePushSpec, input io.Reader) (*protocol.TaskResult, error) {
	// fileWrite verifies the content against the ref while it streams into the temporary file, so a
	// mismatch never publishes anything.
	_, err := fileWrite(ctx, acc, &protocol.FileWriteSpec{
		Path:      s.Path,
		Content:   protocol.InputRef{Size: s.Size, SHA256: s.SHA256},
		Overwrite: s.Overwrite,
		Mode:      s.Mode,
		Owner:     s.Owner,
		Group:     s.Group,
	}, input)
	if err != nil {
		return nil, err
	}
	return nil, nil
}
