package agent

import (
	"fmt"
	"testing"
	"time"

	"github.com/Kodecable/ClusterRightHand/client/internal/protocol"
)

// TestRelayDropsEventsOfFinishedTasks covers the events a daemon still flushes after a task ended:
// its exit was acknowledged and the router forgot it, so they used to pile up in pending until the
// bound closed the connection. A finished task's events are dropped instead; an unknown task still
// buffers, and the finished set stays bounded.
func TestRelayDropsEventsOfFinishedTasks(t *testing.T) {
	r := newRelayRouter()
	r.discard("done")
	for range maxBufferedRelayEvents * 2 {
		if err := r.route("done", relayEvent{output: &protocol.TaskOutput{TaskID: "done"}}); err != nil {
			t.Fatalf("late event of a finished task: %v", err)
		}
	}
	r.mu.Lock()
	pending := len(r.pending)
	r.mu.Unlock()
	if pending != 0 {
		t.Fatalf("pending has %d tasks, want none", pending)
	}

	// A task that was never discarded still buffers, and its bounded window is unchanged.
	for range maxBufferedRelayEvents {
		if err := r.route("open", relayEvent{output: &protocol.TaskOutput{TaskID: "open"}}); err != nil {
			t.Fatalf("buffered event: %v", err)
		}
	}
	if err := r.route("open", relayEvent{output: &protocol.TaskOutput{TaskID: "open"}}); err == nil {
		t.Fatal("the buffer bound was not enforced")
	}

	// The finished set keeps the most recent maxFinishedRelayTasks ids: the oldest is evicted and
	// its events buffer again.
	for i := range maxFinishedRelayTasks + 10 {
		r.discard(fmt.Sprintf("t-%d", i))
	}
	r.mu.Lock()
	finished := len(r.finished)
	r.mu.Unlock()
	if finished != maxFinishedRelayTasks {
		t.Fatalf("finished has %d ids, want %d", finished, maxFinishedRelayTasks)
	}
	if err := r.route("t-0", relayEvent{output: &protocol.TaskOutput{TaskID: "t-0"}}); err != nil {
		t.Fatalf("evicted task's event: %v", err)
	}
	r.mu.Lock()
	buffered := len(r.pending["t-0"])
	r.mu.Unlock()
	if buffered != 1 {
		t.Fatalf("evicted task buffered %d events, want 1", buffered)
	}
}

// TestStalledTransferDoesNotBlockOtherTasks covers the read loop's contract: a full transfer queue
// fails that transfer instead of waiting under the router lock, so another task's exit still routes.
func TestStalledTransferDoesNotBlockOtherTasks(t *testing.T) {
	a := newTestAgent(t, Options{})
	slow := &task{
		id:            "slow",
		transferQueue: newTransferQueue(),
		doneCh:        make(chan struct{}),
		cancel:        func() {},
		run:           &localRun{},
	}
	if err := slow.transferQueue.push(make([]byte, transferQueueBytes)); err != nil {
		t.Fatalf("fill queue: %v", err)
	}
	r := newRelayRouter()
	if err := r.attach("slow", a.relayTaskHandlers(slow, "peer")); err != nil {
		t.Fatalf("attach slow: %v", err)
	}
	exits := make(chan protocol.TaskExit, 1)
	if err := r.attach("fast", &relayHandlers{exit: func(exit *protocol.TaskExit) error {
		exits <- *exit
		return nil
	}}); err != nil {
		t.Fatalf("attach fast: %v", err)
	}

	done := make(chan error, 1)
	go func() {
		if err := r.route("slow", relayEvent{transfer: &protocol.TaskOutput{TaskID: "slow", Data: []byte("x")}}); err != nil {
			done <- err
			return
		}
		done <- r.route("fast", relayEvent{exit: &protocol.TaskExit{TaskID: "fast"}})
	}()
	select {
	case err := <-done:
		if err != nil {
			t.Fatalf("route: %v", err)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("routing blocked behind the stalled transfer")
	}
	select {
	case <-exits:
	default:
		t.Fatal("the other task's exit was not routed")
	}

	// The overflow failed only the slow transfer; a later chunk is dropped without an error.
	a.mu.Lock()
	inputErr := slow.inputErr
	a.mu.Unlock()
	if inputErr == nil || inputErr.Code != protocol.CodeIOError {
		t.Fatalf("slow task input error = %+v, want io_error", inputErr)
	}
	slow.transferQueue.mu.Lock()
	closed := slow.transferQueue.closed
	slow.transferQueue.mu.Unlock()
	if !closed {
		t.Fatal("the overflowed transfer queue is still open")
	}
	if err := r.route("slow", relayEvent{transfer: &protocol.TaskOutput{TaskID: "slow", Data: []byte("late")}}); err != nil {
		t.Fatalf("late chunk: %v", err)
	}
}
