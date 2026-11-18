package agent

import (
	"path/filepath"
	"testing"

	"github.com/Kodecable/ClusterRightHand/client/internal/executor"
	"github.com/Kodecable/ClusterRightHand/client/internal/protocol"
)

// TestTaskExitFromResult covers the one constructor of an executor's task.exit: every outcome field
// comes from the result, and none is guessed.
func TestTaskExitFromResult(t *testing.T) {
	exitCode := int32(7)
	result := &protocol.TaskResult{Kind: protocol.TaskResultFileStat}
	exit := taskExit("task-1", executor.Result{
		ExitCode:   &exitCode,
		TimedOut:   true,
		Cancelled:  true,
		TaskResult: result,
	})

	if exit.TaskID != "task-1" || exit.TimedOut != true || exit.Cancelled != true {
		t.Fatalf("task.exit = %+v, want the task's id, timeout and cancellation", exit)
	}
	if exit.Outcome.Kind != protocol.OutcomeCode || exit.Outcome.Code != 7 {
		t.Fatalf("outcome = %+v, want code 7", exit.Outcome)
	}
	if exit.Result != result {
		t.Fatalf("result = %+v, want the executor's result", exit.Result)
	}
}

// TestErrorExit covers the failure exit built without an executor result: the code and message are
// carried as an error outcome and the output fields stay at their zero values.
func TestErrorExit(t *testing.T) {
	exit := errorExit("task-2", protocol.CodeHelperLost, "the helper disappeared")
	if exit.TaskID != "task-2" || exit.Outcome.Kind != protocol.OutcomeError || exit.Outcome.Error == nil {
		t.Fatalf("task.exit = %+v, want an error outcome", exit)
	}
	if exit.Outcome.Error.Code != protocol.CodeHelperLost || exit.Outcome.Error.Message != "the helper disappeared" {
		t.Fatalf("error = %+v, want the code and message", exit.Outcome.Error)
	}
	if exit.OutputEnd != 0 || exit.OutputFile != "" || exit.OutputLines != 0 || exit.OutputLost {
		t.Fatalf("output fields = %d/%q/%d/%v, want the zero values", exit.OutputEnd, exit.OutputFile, exit.OutputLines, exit.OutputLost)
	}
}

// TestFinishOutput covers the output state finishOutput records: the stream ends and the spill file
// of a task whose output was closed.
func TestFinishOutput(t *testing.T) {
	output := executor.NewOutput("task-3", t.TempDir(), executor.OutputOptions{AlwaysSpill: true})
	if _, err := output.Writer().Write([]byte("one\ntwo")); err != nil {
		t.Fatal(err)
	}
	exit := errorExit("task-3", protocol.CodeInternalError, "unused")
	finishOutput(exit, output)

	if exit.OutputEnd != 7 || exit.OutputLines != 2 {
		t.Fatalf("output = %d bytes/%d lines, want 7/2", exit.OutputEnd, exit.OutputLines)
	}
	if exit.OutputLost {
		t.Fatal("output_lost = true, want false without a loss")
	}
	if exit.OutputFile == "" {
		t.Fatal("output file is empty, want the spill file")
	}
}

// TestFinishOutputReportsOnlyDeliveredBytes covers lost output: the exit names the contiguous
// prefix the pump can still send, no complete file, and the pump sends exactly that many bytes.
func TestFinishOutputReportsOnlyDeliveredBytes(t *testing.T) {
	output := executor.NewOutput("lost", filepath.Join(t.TempDir(), "missing"), executor.OutputOptions{SpillBytes: 1})
	if _, err := output.Writer().Write([]byte("ok")); err != nil {
		t.Fatal(err)
	}
	// The missing spill directory leaves output in memory; beyond its cap the bytes are lost.
	if _, err := output.Writer().Write(make([]byte, 17<<20)); err != nil {
		t.Fatal(err)
	}
	lostAt, lost := output.LostAt()
	if !lost || lostAt != 2 {
		t.Fatalf("LostAt = %d, %v, want 2, true", lostAt, lost)
	}

	exit := errorExit("lost", protocol.CodeInternalError, "unused")
	finishOutput(exit, output)
	if exit.OutputEnd != 2 || exit.OutputFile != "" {
		t.Fatalf("exit output = %d bytes, file %q, want 2, no file", exit.OutputEnd, exit.OutputFile)
	}
	if !exit.OutputLost {
		t.Fatal("output_lost = false, want true after a loss")
	}

	a := newTestAgent(t, Options{})
	task := &task{
		id: "lost", output: output, done: true, result: exit,
		transferDone: true, doneCh: make(chan struct{}),
	}
	a.mu.Lock()
	a.tasks[task.id] = task
	a.mu.Unlock()

	var sent uint64
	for range 100 {
		ob := a.nextOutbound()
		if ob == nil {
			t.Fatal("the pump produced no exit")
		}
		switch ob.name {
		case protocol.EventTaskOutput:
			out := ob.body.(protocol.TaskOutput)
			if uint64(out.Offset) != sent {
				t.Fatalf("output offset = %d, want %d", out.Offset, sent)
			}
			sent += uint64(len(out.Data))
		case protocol.EventTaskExit:
			got := ob.body.(*protocol.TaskExit)
			if got.OutputEnd != protocol.Uint(sent) {
				t.Fatalf("exit output_end = %d, want the %d bytes sent", got.OutputEnd, sent)
			}
			return
		default:
			t.Fatalf("unexpected outbound %q", ob.name)
		}
	}
	t.Fatal("the pump produced no exit")
}
