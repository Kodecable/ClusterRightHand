package agent

import (
	"context"
	"time"

	"github.com/Kodecable/ClusterRightHand/client/internal/config"
	"github.com/Kodecable/ClusterRightHand/client/internal/upgrade/marker"
	"github.com/Kodecable/ClusterRightHand/client/internal/version"
)

// readiness tracks the two conditions of the readiness line an upgrade waits for
// (doc/design/distribution.md "On the node"): a completed hello with crhs, and a privileged side that
// works. The line is logged once per process, the first time both hold.
type readiness struct {
	hello      bool
	privileged bool
	logged     bool
}

// markHelloDone records a completed hello with crhs.
func (a *Agent) markHelloDone() {
	a.readyMu.Lock()
	a.ready.hello = true
	a.readyMu.Unlock()
	a.logReadyOnce()
}

// markPrivilegedOK records that the privileged side works: the forward daemon answered its
// handshake and trust query, or a native helper completed its handshake.
func (a *Agent) markPrivilegedOK() {
	a.readyMu.Lock()
	a.ready.privileged = true
	a.readyMu.Unlock()
	a.logReadyOnce()
}

// testNeverReady, set to "1" with -ldflags -X by the upgrade system tests only, keeps this binary from
// ever logging its readiness line, so the installer's rollback can be exercised. A release never sets it.
var testNeverReady string

func (a *Agent) logReadyOnce() {
	if testNeverReady == "1" {
		return
	}
	a.readyMu.Lock()
	ready := a.ready.hello && a.ready.privileged && !a.ready.logged
	if ready {
		a.ready.logged = true
	}
	a.readyMu.Unlock()
	if ready {
		a.log.Info(marker.Ready(version.Version))
	}
}

// startPrivilegedCheck starts what proves the privileged side for the readiness line: forward mode
// proves it on its own daemon connection; native mode starts one helper and completes its handshake;
// ignore and reject have nothing to prove.
func (a *Agent) startPrivilegedCheck(ctx context.Context) {
	switch a.opts.PrivilegedMode {
	case config.ModeForward:
		// runForward marks it after its first trust query.
	case config.ModeNative:
		go func() {
			for ctx.Err() == nil {
				err := a.probeNative(ctx)
				if err == nil {
					a.markPrivilegedOK()
					return
				}
				a.log.Warn("the native helper did not start", "err", err)
				if !sleepCtx(ctx, forwardRetryMax) {
					return
				}
			}
		}()
	default:
		a.markPrivilegedOK()
	}
}

// probeNative starts the native helper, completes its crh-priv handshake and lets it exit.
func (a *Agent) probeNative(ctx context.Context) error {
	ctx, cancel := context.WithTimeout(ctx, a.nativeTimeout()+5*time.Second)
	defer cancel()
	h, err := a.launchNative(ctx)
	if err != nil {
		return err
	}
	// Closing stdin ends the helper's session; it exits without running anything.
	_ = h.stdin.Close()
	if err := h.cmd.Wait(); err != nil && ctx.Err() != nil {
		return nativeFailure(h.argv, h.stderr, err)
	}
	return nil
}
