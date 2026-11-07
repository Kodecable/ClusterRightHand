package daemon

import (
	"testing"
	"time"

	"github.com/Kodecable/ClusterRightHand/client/internal/privileged/taskrun"
)

// newTaskServer returns a server whose task set is ready for the waitTasks tests.
func newTaskServer() *Server {
	s := &Server{tasks: make(map[*taskrun.Task]struct{})}
	s.idle = make(chan struct{})
	close(s.idle)
	return s
}

func TestWaitTasksWithoutTasks(t *testing.T) {
	s := newTaskServer()
	if !s.waitTasks(0) {
		t.Fatal("waitTasks did not return with no task running")
	}
}

func TestWaitTasksWakesOnLastTask(t *testing.T) {
	s := newTaskServer()
	first, second := &taskrun.Task{}, &taskrun.Task{}
	s.registerTask(first)
	s.registerTask(second)

	returned := make(chan bool, 1)
	go func() { returned <- s.waitTasks(time.Minute) }()
	select {
	case ok := <-returned:
		t.Fatalf("waitTasks returned %v while tasks were running", ok)
	case <-time.After(100 * time.Millisecond):
	}

	s.unregisterTask(first)
	select {
	case ok := <-returned:
		t.Fatalf("waitTasks returned %v while a task was running", ok)
	case <-time.After(100 * time.Millisecond):
	}

	s.unregisterTask(second)
	select {
	case ok := <-returned:
		if !ok {
			t.Fatal("waitTasks reported a timeout although no task is running")
		}
	case <-time.After(10 * time.Second):
		t.Fatal("waitTasks did not wake up after the last task finished")
	}
}

func TestWaitTasksTimesOut(t *testing.T) {
	s := newTaskServer()
	task := &taskrun.Task{}
	s.registerTask(task)
	if s.waitTasks(50 * time.Millisecond) {
		t.Fatal("waitTasks reported success while a task was running")
	}
	s.unregisterTask(task)
}
