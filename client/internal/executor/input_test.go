package executor

import (
	"context"
	"errors"
	"io"
	"testing"
	"time"
)

// pushBlocked reports whether a PushWait call is waiting for room, by running it in the background.
func pushChunk(in *Input) <-chan error {
	done := make(chan error, 1)
	go func() { done <- in.PushWait(context.Background(), make([]byte, 32<<10)) }()
	return done
}

func waitBlocked(t *testing.T, done <-chan error) {
	t.Helper()
	select {
	case err := <-done:
		t.Fatalf("PushWait returned while the buffer was full: %v", err)
	case <-time.After(50 * time.Millisecond):
	}
}

// TestPushWaitBoundsBuffering covers the data-connection push path: it waits while
// MaxBufferedBytes are buffered and never grows the buffer past that bound.
func TestPushWaitBoundsBuffering(t *testing.T) {
	in := NewInput()
	chunk := make([]byte, 32<<10)
	for buffered := 0; buffered < MaxBufferedBytes; buffered += len(chunk) {
		if err := in.PushWait(context.Background(), chunk); err != nil {
			t.Fatal(err)
		}
	}
	done := pushChunk(in)
	waitBlocked(t, done)
	// A read releases the waiter.
	if _, err := io.ReadFull(in, make([]byte, len(chunk))); err != nil {
		t.Fatal(err)
	}
	select {
	case err := <-done:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("a read did not release the blocked push")
	}
}

// TestPushWaitReleasesOnEnd covers the ends that release a blocked push: Close, Fail, Discard and
// the context. A chunk that arrives after the end is dropped, as Push drops it.
func TestPushWaitReleasesOnEnd(t *testing.T) {
	ends := map[string]func(*Input){
		"close":   func(in *Input) { in.Close() },
		"fail":    func(in *Input) { in.Fail(errors.New("boom")) },
		"discard": func(in *Input) { in.Discard() },
	}
	for name, end := range ends {
		t.Run(name, func(t *testing.T) {
			in := NewInput()
			chunk := make([]byte, 32<<10)
			for buffered := 0; buffered < MaxBufferedBytes; buffered += len(chunk) {
				in.Push(chunk)
			}
			done := pushChunk(in)
			waitBlocked(t, done)
			end(in)
			select {
			case err := <-done:
				if err != nil {
					t.Fatalf("a %s push returned %v, want it dropped", name, err)
				}
			case <-time.After(5 * time.Second):
				t.Fatalf("%s did not release the blocked push", name)
			}
		})
	}
	t.Run("context", func(t *testing.T) {
		in := NewInput()
		chunk := make([]byte, 32<<10)
		for buffered := 0; buffered < MaxBufferedBytes; buffered += len(chunk) {
			in.Push(chunk)
		}
		ctx, cancel := context.WithCancel(context.Background())
		done := make(chan error, 1)
		go func() { done <- in.PushWait(ctx, chunk) }()
		waitBlocked(t, done)
		cancel()
		select {
		case err := <-done:
			if !errors.Is(err, context.Canceled) {
				t.Fatalf("a cancelled push returned %v, want context.Canceled", err)
			}
		case <-time.After(5 * time.Second):
			t.Fatal("the context did not release the blocked push")
		}
	})
}

// TestPushStaysNonBlocking covers the control read loop's path: Push never waits, even when the
// buffer is over the push bound.
func TestPushStaysNonBlocking(t *testing.T) {
	in := NewInput()
	chunk := make([]byte, 32<<10)
	for buffered := 0; buffered < MaxBufferedBytes; buffered += len(chunk) {
		in.Push(chunk)
	}
	done := make(chan struct{})
	go func() {
		in.Push(chunk)
		close(done)
	}()
	select {
	case <-done:
	case <-time.After(5 * time.Second):
		t.Fatal("Push blocked on a full input")
	}
}
