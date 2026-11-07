package executor

import (
	"context"
	"errors"
	"os"
	"os/exec"
	"sync"
	"time"

	"golang.org/x/sys/unix"
)

// pidfdSignalProcessGroup is the pidfd_send_signal flag that addresses the whole process group
// instead of the leader alone (Linux 6.9+). Older kernels reject it with EINVAL.
const pidfdSignalProcessGroup = 4

// pidfdWorks reports whether this kernel provides pidfd. Asking for a pidfd makes clone(2) use
// CLONE_PIDFD, which fails with EINVAL on a kernel without pidfd support, so the executor probes
// once instead of relying on Start to leave the fd at -1.
var pidfdWorks = sync.OnceValue(func() bool {
	fd, err := unix.PidfdOpen(os.Getpid(), 0)
	if err != nil {
		return false
	}
	_ = unix.Close(fd)
	return true
})

// taskProcess is the process group of one task. The executor keeps the leader unreaped until the
// last group signal was sent: while the leader is a zombie its pid, and with it the pgid of the
// group, cannot be reused, so a group signal cannot hit an unrelated process group.
type taskProcess struct {
	cmd   *exec.Cmd
	pid   int
	pgid  int
	pidfd int // -1 when the kernel or the environment does not provide a pidfd
}

func newTaskProcess(cmd *exec.Cmd, pidfd int) *taskProcess {
	// Setpgid makes the leader the process group id.
	pid := cmd.Process.Pid
	return &taskProcess{cmd: cmd, pid: pid, pgid: pid, pidfd: pidfd}
}

// waitExit blocks until the leader exited and leaves it unreaped, so cmd.Wait still reports its
// exit status. P_PIDFD (Linux 5.4+) is preferred because a pidfd cannot be reused; P_PID is the
// fallback for a kernel before 5.4 or without pidfd support.
func (p *taskProcess) waitExit() error {
	if p.pidfd >= 0 {
		err := waitExited(unix.P_PIDFD, p.pidfd)
		if err == nil || (!errors.Is(err, unix.EINVAL) && !errors.Is(err, unix.ENOSYS)) {
			return err
		}
	}
	return waitExited(unix.P_PID, p.pid)
}

// waitExited observes a child's exit without consuming its wait status. WNOWAIT is what keeps the
// leader reapable by cmd.Wait afterwards.
func waitExited(idType, id int) error {
	for {
		err := unix.Waitid(idType, id, nil, unix.WEXITED|unix.WNOWAIT, nil)
		if !errors.Is(err, unix.EINTR) {
			return err
		}
	}
}

// signalGroup sends sig to the task's process group. It is called while the leader is unreaped,
// which keeps the pgid allocated for the kill(-pgid) fallback. pidfd_send_signal with the process
// group flag needs Linux 6.9; an older kernel falls back to the pgid.
func (p *taskProcess) signalGroup(sig unix.Signal) error {
	if p.pidfd >= 0 {
		err := unix.PidfdSendSignal(p.pidfd, sig, nil, pidfdSignalProcessGroup)
		if !errors.Is(err, unix.EINVAL) {
			return err
		}
	}
	return unix.Kill(-p.pgid, sig)
}

// run supervises the task until its leader exits, then kills what is left of the group before
// reaping the leader. Cancelling ctx or a timeout sends SIGTERM to the group and SIGKILL after the
// grace period; a normal end only gets the final SIGKILL for whatever the task left behind.
func (p *taskProcess) run(ctx context.Context, timeout, grace time.Duration) Result {
	var res Result
	exited := make(chan error, 1)
	go func() { exited <- p.waitExit() }()

	var deadline <-chan time.Time
	if timeout > 0 {
		timer := time.NewTimer(timeout)
		defer timer.Stop()
		deadline = timer.C
	}
	var kill <-chan time.Time
	terminate := func() {
		_ = p.signalGroup(unix.SIGTERM)
		kill = time.After(grace)
	}
	ctxDone := ctx.Done()
	for {
		select {
		case <-ctxDone:
			res.Cancelled = true
			ctxDone = nil
			terminate()
		case <-deadline:
			res.TimedOut = true
			deadline = nil
			terminate()
		case <-kill:
			_ = p.signalGroup(unix.SIGKILL)
			kill = nil
		case waitErr := <-exited:
			// The leader is still an unreaped zombie unless observing its exit failed, so the
			// pgid is still this task's. Kill the rest of the group before reaping: background
			// children holding the output pipe die here, and cmd.Wait does not wait for them.
			if waitErr == nil {
				_ = p.signalGroup(unix.SIGKILL)
			}
			waitErr = p.cmd.Wait()
			fillExit(&res, p.cmd.ProcessState, waitErr)
			return res
		}
	}
}
