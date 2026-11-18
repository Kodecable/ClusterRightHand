package agent

import (
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
	if exit.OutputEnd != 0 || exit.OutputFile != "" || exit.OutputLines != 0 {
		t.Fatalf("output fields = %d/%q/%d, want the zero values", exit.OutputEnd, exit.OutputFile, exit.OutputLines)
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
	if exit.OutputFile == "" {
		t.Fatal("output file is empty, want the spill file")
	}
}
