package agent

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/Kodecable/ClusterRightHand/client/internal/protocol"
)

// transferIdleTimeout mirrors the protocol's data connection idle limit; the timer restarts on every
// frame in either direction (doc/design/protocol.md "Data connections").
var transferIdleTimeout = protocol.DataIdleTimeout

// isTransferKind reports whether kind moves its bytes on a data connection.
func isTransferKind(kind protocol.TaskSpecKind) bool {
	return kind == protocol.TaskSpecFilePush || kind == protocol.TaskSpecFilePull
}

// claimTransfer takes the node's single transfer slot. It reports false when a transfer already runs;
// the caller refuses the task with busy (doc/design/library.md "Data connections").
func (a *Agent) claimTransfer() bool {
	a.transferMu.Lock()
	defer a.transferMu.Unlock()
	if a.transferActive {
		return false
	}
	a.transferActive = true
	return true
}

// releaseTransfer frees the transfer slot. A transfer that was never accepted also calls it, so a
// refused task cannot leave the node unable to transfer again.
func (a *Agent) releaseTransfer() {
	a.transferMu.Lock()
	a.transferActive = false
	a.transferMu.Unlock()
}

// transferEndpoint returns the crhs-side endpoint of a transfer task.
func transferEndpoint(spec *protocol.TaskSpec) (protocol.TransferEndpoint, error) {
	var endpoint protocol.TransferEndpoint
	switch spec.Kind {
	case protocol.TaskSpecFilePush:
		if spec.FilePush == nil {
			return endpoint, errors.New("file.push task has no spec")
		}
		endpoint = spec.FilePush.Endpoint
	case protocol.TaskSpecFilePull:
		if spec.FilePull == nil {
			return endpoint, errors.New("file.pull task has no spec")
		}
		endpoint = spec.FilePull.Endpoint
	default:
		return endpoint, fmt.Errorf("not a transfer task: %q", spec.Kind)
	}
	if endpoint.Kind != protocol.TransferEndpointCRHS {
		return endpoint, fmt.Errorf("unsupported transfer endpoint %q", endpoint.Kind)
	}
	return endpoint, nil
}

// transfer runs one file.push or file.pull task: it opens the node's data connection to crhs for the
// task's transfer id, starts the task in its mode and moves the bytes. The task's result still
// travels on the control connection (doc/design/protocol.md "Data connections").
func (a *Agent) transfer(t *task) {
	defer a.releaseTransfer()

	endpoint, err := transferEndpoint(&t.spec.Spec)
	if err != nil {
		a.finishTransferError(t, protocol.CodeInvalidSpec, err.Error())
		return
	}
	if a.opts.DataDial == nil {
		a.finishTransferError(t, protocol.CodeInternalError, "data connections are not configured")
		return
	}
	ctx, cancel := context.WithCancel(t.runCtx)
	defer cancel()
	conn, err := a.opts.DataDial(ctx, t.id, endpoint.TransferID)
	if err != nil {
		a.finishTransferError(t, protocol.CodeIOError, "open the data connection: "+err.Error())
		return
	}
	// One data connection carries one transfer: close it once the bytes and the [end]/[abort] frame
	// are out, so crhs and the node do not keep a socket per finished transfer.
	defer func() { _ = conn.Close("transfer done") }()
	// The idle watchdog closes the connection when neither side sent anything for 90 s; the
	// blocked Recv or send then fails and the task ends.
	idle := time.AfterFunc(transferIdleTimeout, func() {
		cancel()
		_ = conn.Close("idle timeout")
	})
	defer idle.Stop()
	reset := func() { idle.Reset(transferIdleTimeout) }

	a.mu.Lock()
	t.transferSend = func(data []byte) error {
		return a.sendTransferData(ctx, conn, t, data, reset)
	}
	t.closeTransfer = func() {
		cancel()
		_ = conn.Close("task cancelled")
	}
	close(t.transferReady)
	a.mu.Unlock()
	defer func() {
		a.mu.Lock()
		t.transferDone = true
		a.mu.Unlock()
		a.wake()
	}()

	// Start the mode now that the data connection exists. For a pull the emitter writes through
	// transferSend; for a push the frames feed the task's ordinary input accounting.
	t.run.start(a, t)

	if t.spec.Spec.Kind == protocol.TaskSpecFilePull {
		a.pullTransfer(t, conn, ctx, reset)
		return
	}
	a.pushTransfer(t, conn, ctx, reset)
}

// sendTransferData writes one [data, bytes] frame. The write waits for the socket, so a slow crhs
// applies backpressure to the node (doc/design/protocol.md "Data connections").
func (a *Agent) sendTransferData(ctx context.Context, conn DataConn, t *task, data []byte, reset func()) error {
	// A file read may hand over more than one frame holds; a frame over MaxFrameBytes would be
	// refused by the connection (doc/design/protocol.md "Data connections").
	for len(data) > 0 {
		n := min(len(data), protocol.DataChunkBytes)
		if err := writeDataFrame(ctx, conn, protocol.DataFrame{Kind: protocol.DataFrameData, Bytes: data[:n]}); err != nil {
			return err
		}
		reset()
		data = data[n:]
	}
	return nil
}

// DataConn is the part of a data connection a transfer uses: a transport.Conn establishes it, and
// tests substitute an in-memory one.
type DataConn interface {
	Send(ctx context.Context, frame []byte) error
	Recv(ctx context.Context) ([]byte, error)
	Close(reason string) error
}

// writeDataFrame encodes and sends one data frame.
func writeDataFrame(ctx context.Context, conn DataConn, frame protocol.DataFrame) error {
	raw, err := protocol.Marshal(frame)
	if err != nil {
		return err
	}
	return conn.Send(ctx, raw)
}

// readDataFrame receives and decodes one data frame.
func readDataFrame(ctx context.Context, conn DataConn) (protocol.DataFrame, error) {
	raw, err := conn.Recv(ctx)
	if err != nil {
		return protocol.DataFrame{}, err
	}
	var frame protocol.DataFrame
	if err := protocol.Unmarshal(raw, &frame); err != nil {
		return protocol.DataFrame{}, err
	}
	return frame, nil
}

// pushTransfer receives the bytes of a file.push task and feeds them to the task's input accounting,
// which the local executor or the privileged mode verifies before publishing the file.
func (a *Agent) pushTransfer(t *task, conn DataConn, ctx context.Context, reset func()) {
	var offset uint64
	for {
		frame, err := readDataFrame(ctx, conn)
		if err != nil {
			// The idle watchdog or a broken socket ends the read; only a cancel of the task itself
			// must keep its cancelled outcome.
			if t.runCtx.Err() == nil {
				a.failTransfer(t, protocol.CodeInputIncomplete, "the data connection ended before the transfer did")
			}
			return
		}
		reset()
		// The local writer may have failed before the sender finished (a missing target directory,
		// for example). Tell it to stop instead of swallowing the rest of the file.
		select {
		case <-t.doneCh:
			code := protocol.CodeCancelled
			a.mu.Lock()
			exit := t.result
			a.mu.Unlock()
			if exit != nil && exit.Outcome.Kind == protocol.OutcomeError && exit.Outcome.Error != nil {
				code = exit.Outcome.Error.Code
			}
			_ = writeDataFrame(ctx, conn, protocol.DataFrame{Kind: protocol.DataFrameAbort, Code: code})
			return
		default:
		}
		switch frame.Kind {
		case protocol.DataFrameData:
			chunk := &protocol.TaskInput{TaskID: t.id, Offset: protocol.Uint(offset), Data: frame.Bytes}
			offset += uint64(len(frame.Bytes))
			if _, err := a.input(ctx, chunk); err != nil {
				a.failTransfer(t, protocol.CodeInputMismatch, err.Error())
				return
			}
		case protocol.DataFrameEnd:
			if !t.inputComplete() {
				// The sender claims the end but declared bytes are missing; the task can never
				// succeed, and waiting for more input would hang it.
				a.failTransfer(t, protocol.CodeInputIncomplete, "the transfer ended before the declared bytes arrived")
			}
			return
		case protocol.DataFrameAbort:
			a.failTransfer(t, frame.Code, "the sender aborted the transfer")
			return
		default:
			a.failTransfer(t, protocol.CodeInternalError, "unknown data frame")
			return
		}
	}
}

// pullTransfer sends the content of a file.pull task. The local executor streams chunks through
// transferSend directly; a privileged pull's chunks arrive on the shared crh-priv read loop and are
// queued for this goroutine, so a slow data connection never stalls that loop.
func (a *Agent) pullTransfer(t *task, conn DataConn, ctx context.Context, reset func()) {
	defer close(t.transferQueueClosed)
	// drain sends everything already queued; false means the data connection is gone.
	drain := func() bool {
		for {
			select {
			case data := <-t.transferQueue:
				if err := a.sendTransferData(ctx, conn, t, data, reset); err != nil {
					return false
				}
			default:
				return true
			}
		}
	}
	for {
		select {
		case data := <-t.transferQueue:
			if err := a.sendTransferData(ctx, conn, t, data, reset); err != nil {
				// The data connection is gone; crhs fails the transfer and cancels the task.
				a.markTransferDone(t)
				return
			}
		case <-t.doneCh:
			// Every transfer event precedes task.exit on the ordered crh-priv stream, so the queue
			// is final here: send it before [end] or the file would be truncated.
			if !drain() {
				a.markTransferDone(t)
				return
			}
			a.finishPull(t, conn, ctx, reset)
			return
		case <-ctx.Done():
			a.markTransferDone(t)
			return
		}
	}
}

// finishPull writes a pull's outcome to the data connection after its bytes.
func (a *Agent) finishPull(t *task, conn DataConn, ctx context.Context, reset func()) {
	a.mu.Lock()
	exit := t.result
	a.mu.Unlock()
	if exit == nil {
		_ = writeDataFrame(ctx, conn, protocol.DataFrame{Kind: protocol.DataFrameAbort, Code: protocol.CodeInternalError})
		a.markTransferDone(t)
		return
	}
	if exit.Outcome.Kind != protocol.OutcomeCode {
		code := protocol.CodeInternalError
		if exit.Outcome.Kind == protocol.OutcomeError {
			code = exit.Outcome.Error.Code
		} else if exit.Outcome.Kind == protocol.OutcomeSignal {
			code = protocol.CodeCancelled
		}
		_ = writeDataFrame(ctx, conn, protocol.DataFrame{Kind: protocol.DataFrameAbort, Code: code})
		a.markTransferDone(t)
		return
	}
	if exit.Result == nil || exit.Result.Kind != protocol.TaskResultFilePull || exit.Result.FilePull == nil {
		_ = writeDataFrame(ctx, conn, protocol.DataFrame{Kind: protocol.DataFrameAbort, Code: protocol.CodeInternalError})
		a.markTransferDone(t)
		return
	}
	if err := writeDataFrame(ctx, conn, protocol.DataFrame{Kind: protocol.DataFrameEnd}); err != nil && ctx.Err() == nil {
		a.log.Warn("finish the data transfer", "task", t.id, "err", err)
	}
	reset()
	a.markTransferDone(t)
}

// markTransferDone lets the task's exit be sent; the bytes are on the wire by now.
func (a *Agent) markTransferDone(t *task) {
	a.mu.Lock()
	t.transferDone = true
	a.mu.Unlock()
	a.wake()
}

// failTransfer fails the task's input with code and stops the task: no executor or privileged mode
// may keep waiting for bytes that will not come.
func (a *Agent) failTransfer(t *task, code, message string) {
	a.mu.Lock()
	a.failInputLocked(t, code, message)
	closeTransfer := t.closeTransfer
	a.mu.Unlock()
	if closeTransfer != nil {
		closeTransfer()
	}
}

// finishTransferError ends a transfer task that never got its data connection, or whose endpoint is
// invalid, with a failed outcome. A privileged task may already exist on the peer, so its cancel is
// requested best-effort before the local exit is recorded.
func (a *Agent) finishTransferError(t *task, code, message string) {
	go t.run.cancel(a, context.Background(), t)
	exit := &protocol.TaskExit{
		TaskID:    t.id,
		Outcome:   protocol.Outcome{Kind: protocol.OutcomeError, Error: &protocol.Error{Code: code, Message: protocol.ErrorMessage(message)}},
		OutputEnd: 0,
	}
	t.output.Close()
	a.mu.Lock()
	// Release a privileged pull's transfer handler, which may be waiting for the data connection;
	// without one it must not block the peer's read loop.
	select {
	case <-t.transferReady:
	default:
		close(t.transferReady)
	}
	if t.transferSend == nil {
		t.transferSend = func([]byte) error { return errors.New("the data connection could not be opened") }
	}
	if !t.done {
		t.done, t.result = true, exit
		t.signalDone()
	}
	a.mu.Unlock()
	t.run.finished(t)
	a.wake()
}
