package daemon

import (
	"errors"
	"fmt"
	"sort"
	"time"

	"github.com/Kodecable/ClusterRightHand/client/internal/privileged/audit"
	"github.com/Kodecable/ClusterRightHand/client/internal/privileged/authz"
	"github.com/Kodecable/ClusterRightHand/client/internal/privileged/config"
	"github.com/Kodecable/ClusterRightHand/client/internal/privileged/taskrun"
	"github.com/Kodecable/ClusterRightHand/client/internal/protocol"
)

const resultAlreadyAccepted = authz.ResultAlreadyAccepted

// maxApprovals bounds the pending and approved local requests a daemon keeps in memory. A
// compromised crhs can send local.request for arbitrary task ids, so the list must not grow
// without limit; reaching the cap refuses new requests until the approver withdraws or decides
// one of them (doc/privilege.md 本地批准).
const maxApprovals = 1024

// decidedTask is a task.start that passed verification, with everything the caller needs to
// persist and execute it.
type decidedTask struct {
	decision *authz.Decision
	specHash [32]byte
	// authorization is nil for a local approval.
	authorization   *authz.Authorization
	payload         *protocol.AuthorizationPayload
	authorizationID [32]byte
	approval        *approval
	// exact reports whether the cwd of the task is left as specified: an exact authorization
	// pins the complete spec, and a local approval is for that exact spec as well.
	exact bool
}

// decide verifies task.start against the current configuration and persistent state. A
// refusal is returned as the *protocol.RemoteError the caller sends; nothing has been
// persisted or executed in that case.
func (s *Server) decide(ts *protocol.TaskStart) (*decidedTask, *protocol.RemoteError) {
	cfg := s.Config()
	decided := &decidedTask{}
	if err := taskrun.Validate(*ts); err != nil {
		var remote *protocol.RemoteError
		if errors.As(err, &remote) {
			return nil, remote
		}
		return nil, &protocol.RemoteError{Code: "invalid_spec", Message: err.Error()}
	}
	specHash, err := protocol.SpecSHA256(&ts.Spec)
	if err != nil {
		return nil, &protocol.RemoteError{Code: "invalid_spec", Message: err.Error()}
	}
	decided.specHash = specHash

	var authorization *authz.Authorization
	if len(ts.Authorizations) > 1 {
		return nil, stepRefusal(authz.ResultInvalid, authz.StepSignatures, "more than one authorization")
	}
	if len(ts.Authorizations) == 1 {
		authorization = s.verifyAuthorization(cfg, ts.Authorizations[0])
		decided.authorization = authorization
		decided.payload = authorization.Decoded
		if authorization.Decoded != nil {
			decided.authorizationID = protocol.AuthorizationID(authorization.Payload)
		}
	}

	var localApproval *authz.LocalApproval
	if authorization == nil {
		if rec := s.approvedApproval(ts.TaskID, uint64(ts.Attempt)); rec != nil {
			localApproval = &authz.LocalApproval{UID: rec.uid, SpecSHA256: rec.specHash}
			decided.approval = rec
		}
	}

	now := s.now()
	decision := authz.Decide(authz.Input{
		Now:           now,
		ClockSkew:     cfg.ClockSkew,
		NodeID:        cfg.NodeID,
		NodeGroups:    cfg.Groups,
		Trust:         cfg.Entries(),
		Task:          authz.Task{ID: ts.TaskID, Attempt: uint64(ts.Attempt), Spec: &ts.Spec},
		Authorization: authorization,
		LocalApproval: localApproval,
		Executed:      s.store.Executed,
		Used:          s.store.Used,
		Revoked:       s.store.Revoked,
	})
	if decision.Result != authz.ResultAccepted {
		return nil, stepRefusal(decision.Result, decision.Step, decision.Message)
	}
	decided.decision = &decision
	decided.exact = localApproval != nil
	if authorization != nil && authorization.Decoded != nil && authorization.Decoded.Command != nil &&
		authorization.Decoded.Command.Match.Kind == protocol.AuthMatchExact {
		decided.exact = true
	}
	return decided, nil
}

// verifyAuthorization decodes one Authorization and maps each signature to its trust entry,
// verifying it. A signature whose key no trust entry knows is ignored (the authorization may
// carry signatures for other nodes); a signature by a trusted key that does not verify stays
// in the list with Valid=false so Decide rejects the whole authorization
// (doc/privilege.md 校验流程 step 3).
func (s *Server) verifyAuthorization(cfg *config.Config, raw []byte) *authz.Authorization {
	authorization := &authz.Authorization{}
	var decoded protocol.Authorization
	if err := protocol.Unmarshal(raw, &decoded); err != nil {
		// A malformed authorization object is invalid. Keeping Payload empty makes Decide
		// report authorization_invalid at step 3, the same code the wire error uses.
		return authorization
	}
	authorization.Payload = decoded.Payload
	payload, err := protocol.DecodeAuthorizationPayload(decoded.Payload)
	if err == nil {
		authorization.Decoded = payload
	}
	authorization.Signatures = make([]authz.Signature, 0, len(decoded.Signatures))
	for i := range decoded.Signatures {
		authorization.Signatures = append(authorization.Signatures,
			s.verifySignature(cfg, decoded.Payload, &decoded.Signatures[i]))
	}
	return authorization
}

// verifySignature checks one signature and returns it with the trust entry that owns its key.
func (s *Server) verifySignature(cfg *config.Config, payload []byte, signature *protocol.Signature) authz.Signature {
	switch signature.Kind {
	case protocol.SignatureSSHSig:
		if signature.SSHSig == nil {
			return authz.Signature{}
		}
		key, err := authz.SignerKey(signature.SSHSig.Blob)
		if err != nil {
			// No key, so no trust entry can be matched; the signature is ignored.
			return authz.Signature{}
		}
		trust := cfg.SSHEntry(key)
		if trust == nil {
			return authz.Signature{}
		}
		entry := trust.Entry()
		result, err := authz.VerifySSHSIG(signature.SSHSig.Blob, payload)
		out := authz.Signature{Entry: &entry}
		if err == nil {
			out.Valid = true
			out.UserVerified = result.UserVerified
		}
		return out
	case protocol.SignatureWebAuthn:
		if signature.WebAuthn == nil {
			return authz.Signature{}
		}
		trust := cfg.CredentialEntry(signature.WebAuthn.CredentialID)
		if trust == nil {
			return authz.Signature{}
		}
		entry := trust.Entry()
		userVerified, err := authz.VerifyWebAuthn(payload, signature.WebAuthn, trust.WebAuthn)
		return authz.Signature{Entry: &entry, Valid: err == nil, UserVerified: userVerified}
	default:
		return authz.Signature{}
	}
}

// stepRefusal builds the task.start error response: code plus "step N: message", as
// doc/protocol.md requires.
func stepRefusal(result authz.Result, step int, message string) *protocol.RemoteError {
	return &protocol.RemoteError{
		Code:    string(result),
		Message: fmt.Sprintf("step %d: %s", step, message),
	}
}

// approvedApproval returns the approved local request for (task id, attempt), or nil.
func (s *Server) approvedApproval(taskID string, attempt uint64) *approval {
	s.approvalMu.Lock()
	defer s.approvalMu.Unlock()
	rec := s.approvals[approvalKey{taskID: taskID, attempt: attempt}]
	if rec == nil || rec.state.Kind != protocol.LocalStateApproved {
		return nil
	}
	return rec.clone()
}

// liveApprovalsLocked counts the pending and approved requests. t.approvalMu must be held.
func (s *Server) liveApprovalsLocked() int {
	live := 0
	for _, rec := range s.approvals {
		if rec.state.Kind == protocol.LocalStatePending || rec.state.Kind == protocol.LocalStateApproved {
			live++
		}
	}
	return live
}

// localRequest is the body an approval record reports.
type localRequest struct {
	taskID     string
	attempt    uint64
	spec       protocol.TaskSpec
	specHash   [32]byte
	note       string
	receivedAt time.Time
}

// approvalKey identifies one local approval.
type approvalKey struct {
	taskID  string
	attempt uint64
}

// approval is the in-memory record of one local.request. Approved and denied records stay
// until the daemon restarts, are withdrawn or (for approved) consumed by task.start
// (doc/privilege.md 本地批准).
type approval struct {
	localRequest
	state protocol.LocalState
	uid   uint32
}

func (a *approval) clone() *approval {
	out := *a
	return &out
}

// consumeApproval removes an approved record after its task was accepted.
func (s *Server) consumeApproval(key approvalKey) {
	s.approvalMu.Lock()
	defer s.approvalMu.Unlock()
	if rec := s.approvals[key]; rec != nil && rec.state.Kind == protocol.LocalStateApproved {
		delete(s.approvals, key)
	}
}

// requestLocal stores a local.request and returns its current state. Repeating the same
// (task id, attempt) is idempotent; a different spec for the same key is refused so an
// approver never approves one spec while crhs executes another.
func (s *Server) requestLocal(req *protocol.LocalRequest) (protocol.LocalState, *protocol.RemoteError) {
	if req.TaskID == "" {
		return protocol.LocalState{}, &protocol.RemoteError{Code: "invalid_spec", Message: "task id must not be empty"}
	}
	if req.Attempt < 1 {
		return protocol.LocalState{}, &protocol.RemoteError{Code: "invalid_spec", Message: "attempt must be at least 1"}
	}
	specHash, err := protocol.SpecSHA256(&req.Spec)
	if err != nil {
		return protocol.LocalState{}, &protocol.RemoteError{Code: "invalid_spec", Message: err.Error()}
	}
	cfg := s.Config()
	if !cfg.HasLocalEntry() {
		return protocol.LocalState{}, &protocol.RemoteError{
			Code:    "local_not_trusted",
			Message: "this node has no local trust entry",
		}
	}
	key := approvalKey{taskID: req.TaskID, attempt: uint64(req.Attempt)}
	s.approvalMu.Lock()
	if existing := s.approvals[key]; existing != nil {
		if existing.specHash != specHash {
			s.approvalMu.Unlock()
			return protocol.LocalState{}, &protocol.RemoteError{
				Code:    "invalid_spec",
				Message: "a different spec is already pending for this task id and attempt",
			}
		}
		state := existing.state
		s.approvalMu.Unlock()
		return state, nil
	}
	if live := s.liveApprovalsLocked(); live >= maxApprovals {
		s.approvalMu.Unlock()
		return protocol.LocalState{}, &protocol.RemoteError{
			Code:    "privileged_unavailable",
			Message: fmt.Sprintf("too many pending local approvals (%d); decide or withdraw one first", live),
		}
	}
	rec := &approval{localRequest: localRequest{
		taskID:     req.TaskID,
		attempt:    uint64(req.Attempt),
		spec:       req.Spec,
		specHash:   specHash,
		note:       req.Note,
		receivedAt: s.now(),
	}, state: protocol.LocalState{Kind: protocol.LocalStatePending}}
	s.approvals[key] = rec
	s.approvalMu.Unlock()
	_ = s.opts.Log.Log(auditLocalRequest(rec))
	return rec.state, nil
}

// withdrawLocal removes a pending or approved request.
func (s *Server) withdrawLocal(taskID string, attempt uint64) {
	s.approvalMu.Lock()
	defer s.approvalMu.Unlock()
	delete(s.approvals, approvalKey{taskID: taskID, attempt: attempt})
}

// decideLocal approves or denies a pending request on behalf of uid.
func (s *Server) decideLocal(uid uint32, verdict *protocol.LocalVerdict, approve bool) (protocol.LocalState, *protocol.RemoteError) {
	if !s.localUIDAllowed(uid) {
		return protocol.LocalState{}, &protocol.RemoteError{
			Code:    "local_not_trusted",
			Message: fmt.Sprintf("uid %d is not a local approver", uid),
		}
	}
	want := protocol.LocalState{Kind: protocol.LocalStateApproved}
	if !approve {
		want = protocol.LocalState{Kind: protocol.LocalStateDenied, Message: verdict.Message}
	}
	key := approvalKey{taskID: verdict.TaskID, attempt: uint64(verdict.Attempt)}
	s.approvalMu.Lock()
	rec := s.approvals[key]
	if rec == nil {
		s.approvalMu.Unlock()
		return protocol.LocalState{}, &protocol.RemoteError{
			Code:    "unknown_task",
			Message: fmt.Sprintf("no local request for task %s attempt %d", verdict.TaskID, verdict.Attempt),
		}
	}
	if [32]byte(verdict.SpecSHA256) != rec.specHash {
		// The approver decided on a spec that is no longer the pending one: crhs withdrew and
		// re-requested the same key with different content, or the verdict is for another task.
		s.approvalMu.Unlock()
		return protocol.LocalState{}, &protocol.RemoteError{
			Code:    "invalid_spec",
			Message: fmt.Sprintf("the spec of task %s attempt %d differs from the one that was shown", verdict.TaskID, verdict.Attempt),
		}
	}
	if rec.state.Kind != protocol.LocalStatePending {
		if rec.state.Kind == want.Kind && rec.state.Message == want.Message {
			state := rec.state
			s.approvalMu.Unlock()
			return state, nil
		}
		state := rec.state
		s.approvalMu.Unlock()
		return protocol.LocalState{}, &protocol.RemoteError{
			Code:    "already_decided",
			Message: fmt.Sprintf("task %s attempt %d was already decided (%s)", verdict.TaskID, verdict.Attempt, state.Kind),
		}
	}
	rec.state = want
	rec.uid = uid
	state := rec.state
	s.approvalMu.Unlock()

	event := "local.approve"
	if !approve {
		event = "local.deny"
	}
	if err := s.opts.Log.Log(audit.Record{
		Event:   event,
		TaskID:  verdict.TaskID,
		Attempt: verdict.Attempt,
		UID:     &uid,
		Message: verdict.Message,
	}); err != nil {
		s.log.Warn("write local log", "err", err)
	}
	s.pushLocalDecision(protocol.LocalDecision{
		TaskID: verdict.TaskID, Attempt: verdict.Attempt, State: state,
	})
	return state, nil
}

// pendingEntries returns the pending local requests, oldest first.
func (s *Server) pendingEntries() []protocol.PendingEntry {
	s.approvalMu.Lock()
	records := make([]*approval, 0, len(s.approvals))
	for _, rec := range s.approvals {
		if rec.state.Kind == protocol.LocalStatePending {
			copied := rec.clone()
			records = append(records, copied)
		}
	}
	s.approvalMu.Unlock()
	sortApprovals(records)
	out := make([]protocol.PendingEntry, 0, len(records))
	for _, rec := range records {
		out = append(out, protocol.PendingEntry{
			TaskID:       rec.taskID,
			Attempt:      protocol.Uint(rec.attempt),
			Spec:         rec.spec,
			Note:         rec.note,
			ReceivedAtMS: protocol.Int(rec.receivedAt.UnixMilli()),
		})
	}
	return out
}

// pushLocalDecision tells every forward connection about a decision.
func (s *Server) pushLocalDecision(decision protocol.LocalDecision) {
	for _, c := range s.forwardConns() {
		if err := c.peer.Emit(protocol.EventLocalDecision, decision); err != nil {
			s.log.Debug("local.decision was not delivered", "task", decision.TaskID, "err", err)
		}
	}
}

// auditLocalRequest is the local-log record of a new local.request.
func auditLocalRequest(rec *approval) audit.Record {
	return audit.Record{Event: "local.request", TaskID: rec.taskID, Attempt: protocol.Uint(rec.attempt)}
}

// sortApprovals orders pending entries oldest first, then by task id and attempt.
func sortApprovals(records []*approval) {
	sort.Slice(records, func(i, j int) bool {
		if !records[i].receivedAt.Equal(records[j].receivedAt) {
			return records[i].receivedAt.Before(records[j].receivedAt)
		}
		if records[i].taskID != records[j].taskID {
			return records[i].taskID < records[j].taskID
		}
		return records[i].attempt < records[j].attempt
	})
}
