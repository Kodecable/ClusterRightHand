package agent

import (
	"github.com/Kodecable/ClusterRightHand/client/internal/executor"
	"github.com/Kodecable/ClusterRightHand/client/internal/protocol"
)

// taskExit builds the task.exit of a task whose executor finished. The output's final stream state is
// added by finishOutput, once every writer has stopped.
func taskExit(taskID string, res executor.Result) *protocol.TaskExit {
	return &protocol.TaskExit{
		TaskID:    taskID,
		Outcome:   res.Outcome(),
		TimedOut:  res.TimedOut,
		Cancelled: res.Cancelled,
		Result:    res.TaskResult,
	}
}

// errorExit builds the task.exit of a task that failed without an executor result.
func errorExit(taskID, code, message string) *protocol.TaskExit {
	return &protocol.TaskExit{
		TaskID: taskID,
		Outcome: protocol.Outcome{
			Kind:  protocol.OutcomeError,
			Error: &protocol.Error{Code: code, Message: protocol.ErrorMessage(message)},
		},
	}
}

// finishOutput closes the task's output and records the stream ends and output file on its exit, so
// the pump sends every byte the exit reports before task.exit. Lost output is not reported as sent:
// the end is the contiguous prefix crha still has, the exit names no complete output file, and
// OutputLost marks the output as incomplete.
func finishOutput(exit *protocol.TaskExit, output *executor.Output) {
	output.Close()
	end := output.End()
	lostAt, lost := output.LostAt()
	exit.OutputLost = lost
	if lost {
		end = lostAt
		exit.OutputFile = ""
	} else {
		exit.OutputFile = protocol.CleanText(output.Path())
	}
	exit.OutputEnd = protocol.Uint(end)
	exit.OutputLines = protocol.Uint(output.Lines())
}
