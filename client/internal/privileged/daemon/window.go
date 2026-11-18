package daemon

import (
	"fmt"
	"time"

	"github.com/Kodecable/ClusterRightHand/client/internal/privileged/audit"
	"github.com/Kodecable/ClusterRightHand/client/internal/privileged/config"
	"github.com/Kodecable/ClusterRightHand/client/internal/protocol"
)

// localWindow is the local approval window of the node (doc/design/privilege.md "Local
// approval"). While it is open, an authorization signed by a crhs trust entry runs without
// that entry's own limits: the node has temporarily handed the privileged identity to crhs.
// The window lives in memory only, so a privileged-mode restart closes it.
type localWindow struct {
	until    time.Time
	openedBy uint32
	openedAt time.Time
}

// windowStateLocked renders the current window for the trust summary and the window commands.
// s.windowMu must be held.
func (s *Server) windowStateLocked() protocol.WindowState {
	if s.window == nil || !s.now().Before(s.window.until) {
		return protocol.ClosedWindow()
	}
	return protocol.WindowState{Kind: protocol.WindowStateOpen, Opened: &protocol.OpenWindow{
		OpenedAtMS:  protocol.Int(s.window.openedAt.UnixMilli()),
		OpenedByUID: protocol.Uint(s.window.openedBy),
		UntilMS:     protocol.Int(s.window.until.UnixMilli()),
	}}
}

// windowState returns the current window state.
func (s *Server) windowState() protocol.WindowState {
	s.windowMu.Lock()
	defer s.windowMu.Unlock()
	return s.windowStateLocked()
}

// windowSnapshot returns the open window, or nil when it is closed or has expired. An expired
// window is reported closed even before its timer fires, so a paused or slow timer can never
// keep a validation path open.
func (s *Server) windowSnapshot() *localWindow {
	s.windowMu.Lock()
	defer s.windowMu.Unlock()
	if s.window == nil || !s.now().Before(s.window.until) {
		return nil
	}
	copied := *s.window
	return &copied
}

// summary builds the trust summary with the current window state.
func (s *Server) summary() *protocol.TrustSummary {
	summary := s.Config().Summary()
	summary.LocalWindow = s.windowState()
	return summary
}

// openWindow opens or replaces the local approval window for uid. The requested length must
// be positive and at most the largest max_window of the local entries that list uid
// (doc/design/privilege.md "Local approval window").
func (s *Server) openWindow(uid uint32, requested time.Duration) (protocol.WindowState, *protocol.RemoteError) {
	if requested <= 0 {
		return protocol.ClosedWindow(), &protocol.RemoteError{
			Code: protocol.CodeInvalidSpec, Message: "the window length must be positive",
		}
	}
	cfg := s.Config()
	if !cfg.HasCRHSEntry() {
		return protocol.ClosedWindow(), &protocol.RemoteError{
			Code: protocol.CodeLocalNotTrusted,
			Message: "this node has no crhs trust entry, so a local approval window could not authorize anything; " +
				"add a crhs trust entry to privileged.toml first",
		}
	}
	entry := cfg.LocalEntry(uid)
	if entry == nil {
		return protocol.ClosedWindow(), &protocol.RemoteError{
			Code: protocol.CodeLocalNotTrusted, Message: fmt.Sprintf("uid %d is not a local approver", uid),
		}
	}
	limit := cfg.LocalWindowLimit(uid)
	if requested > limit {
		return protocol.ClosedWindow(), &protocol.RemoteError{
			Code: protocol.CodeInvalidSpec,
			Message: fmt.Sprintf("the requested window %s exceeds the limit %s for uid %d",
				requested, limit, uid),
		}
	}

	now := s.now()
	window := &localWindow{until: now.Add(requested), openedBy: uid, openedAt: now}
	// The window must be logged before it can authorize anything, like every privileged task.
	if err := s.opts.Log.Log(audit.Record{
		Event:   "window.opened",
		UID:     &uid,
		UntilMS: window.until.UnixMilli(),
	}); err != nil {
		return protocol.ClosedWindow(), &protocol.RemoteError{
			Code: protocol.CodeInternalError, Message: "local log: " + err.Error(),
		}
	}
	s.windowMu.Lock()
	s.window = window
	s.scheduleWindowLocked(requested)
	state := s.windowStateLocked()
	s.windowMu.Unlock()

	s.pushTrustSummary()
	return state, nil
}

// closeWindow closes the window early. A closed window is reported as closed, and the close is
// logged with the closing uid. It returns the new state.
func (s *Server) closeWindow(uid uint32) (protocol.WindowState, *protocol.RemoteError) {
	if !s.localUIDAllowed(uid) {
		return protocol.ClosedWindow(), &protocol.RemoteError{
			Code: protocol.CodeLocalNotTrusted, Message: fmt.Sprintf("uid %d is not a local approver", uid),
		}
	}
	s.windowMu.Lock()
	wasOpen := s.window
	s.stopWindowTimerLocked()
	s.window = nil
	state := s.windowStateLocked()
	s.windowMu.Unlock()

	if wasOpen != nil {
		if err := s.opts.Log.Log(audit.Record{
			Event: "window.closed", UID: &uid, UntilMS: wasOpen.until.UnixMilli(),
		}); err != nil {
			s.log.Warn("write local log", "err", err)
		}
		s.pushTrustSummary()
	}
	return state, nil
}

// expireWindow closes a window whose until time has passed. It is called by the window timer,
// and it re-checks the time so a stale timer callback cannot close a newer window.
func (s *Server) expireWindow() {
	now := s.now()
	s.windowMu.Lock()
	if s.window == nil || now.Before(s.window.until) {
		s.windowMu.Unlock()
		return
	}
	expired := s.window
	s.window = nil
	s.stopWindowTimerLocked()
	s.windowMu.Unlock()

	if err := s.opts.Log.Log(audit.Record{
		Event: "window.expired", UntilMS: expired.until.UnixMilli(),
	}); err != nil {
		s.log.Warn("write local log", "err", err)
	}
	s.pushTrustSummary()
}

// closeWindowForReload closes a window that a configuration reload invalidated: the node no
// longer has a crhs trust entry, or the uid that opened it is no longer a local approver. The
// caller pushes the reloaded trust summary itself.
func (s *Server) closeWindowForReload(cfg *config.Config) bool {
	s.windowMu.Lock()
	if s.window == nil || !s.now().Before(s.window.until) {
		s.window = nil
		s.stopWindowTimerLocked()
		s.windowMu.Unlock()
		return false
	}
	uid := s.window.openedBy
	if cfg.HasCRHSEntry() && cfg.LocalEntry(uid) != nil {
		s.windowMu.Unlock()
		return false
	}
	until := s.window.until
	s.stopWindowTimerLocked()
	s.window = nil
	s.windowMu.Unlock()

	if err := s.opts.Log.Log(audit.Record{
		Event: "window.closed", UID: &uid, UntilMS: until.UnixMilli(),
		Detail: "closed by a configuration reload",
	}); err != nil {
		s.log.Warn("write local log", "err", err)
	}
	return true
}

// scheduleWindowLocked arms the timer that closes the window at its until time. s.windowMu must
// be held.
func (s *Server) scheduleWindowLocked(after time.Duration) {
	s.stopWindowTimerLocked()
	if after <= 0 {
		return
	}
	s.windowTimer = time.AfterFunc(after, s.expireWindow)
}

// stopWindowTimerLocked disarms the window timer. s.windowMu must be held.
func (s *Server) stopWindowTimerLocked() {
	if s.windowTimer != nil {
		s.windowTimer.Stop()
		s.windowTimer = nil
	}
}

// pushTrustSummary sends the current trust summary to every forward connection, so crhs
// replans waiting tasks promptly when a window opens or closes (doc/design/protocol.md
// "Trust summary").
func (s *Server) pushTrustSummary() {
	report := protocol.TrustReport{Kind: protocol.TrustReportOK, Summary: s.summary()}
	for _, c := range s.forwardConns() {
		c.enqueue(protocol.EventTrustSummary, report)
	}
}

// localUIDAllowed reports whether uid is in a local trust entry of the current configuration.
func (s *Server) localUIDAllowed(uid uint32) bool {
	return s.Config().LocalEntry(uid) != nil
}
