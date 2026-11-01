package agent

import (
	"fmt"
	"testing"

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
