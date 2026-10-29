package authz

import (
	"fmt"
	"reflect"
	"slices"
	"strings"
	"time"

	"github.com/Kodecable/ClusterRightHand/client/internal/protocol"
)

// Result is a task.start authorization result: "accepted" or one of the retryable /
// terminal error codes of doc/protocol.md#taskstart.
type Result string

const (
	ResultAccepted        Result = "accepted"
	ResultRequired        Result = "authorization_required"
	ResultInvalid         Result = "authorization_invalid"
	ResultExpired         Result = "authorization_expired"
	ResultRejected        Result = "authorization_rejected"
	ResultAlreadyAccepted Result = "already_accepted"
)

// Steps of doc/privilege.md#校验流程. Step 1 (the peer uid check) belongs to the socket;
// step 10 (persisting the used list and executing) belongs to the caller.
const (
	StepTaskCheck     = 2
	StepSignatures    = 3
	StepAuthorization = 4
	StepOneShot       = 5
	StepCommand       = 6
	StepTrust         = 7
	StepCosign        = 8
	StepRevocation    = 9
)

// Entry is one trust entry in the form the decision needs. The signature keys live in the
// caller's verifier: a signature is already mapped to an Entry (or to nil) when it reaches
// Decide.
type Entry struct {
	Name         string
	Role         protocol.TrustRole
	Kinds        []protocol.TrustKind
	RequireExact bool
	RequireTask  bool
	RequireUV    bool
	// MaxTTL is the max_ttl field; nil means no limit.
	MaxTTL   *time.Duration
	Allow    []protocol.GuardRule
	Deny     []protocol.GuardRule
	EnvAllow []string
	// UIDs are the uids allowed to approve locally; used only for role local.
	UIDs []uint32
}

// HasKind reports whether the entry carries kind.
func (e *Entry) HasKind(kind protocol.TrustKind) bool {
	return slices.Contains(e.Kinds, kind)
}

// Task is the task being started.
type Task struct {
	ID      string
	Attempt uint64
	Spec    *protocol.TaskSpec
}

// Signature is one authorization signature after the caller's crypto check. Entry is the
// trust entry whose key (or credential) verified it, or nil when no trust entry matches;
// untrusted signatures are ignored, as doc/privilege.md requires.
type Signature struct {
	Entry        *Entry
	Valid        bool
	UserVerified bool
}

// Authorization is a decoded AuthorizationPayload and its signatures, in wire order.
type Authorization struct {
	// Payload is the original payload bytes; its SHA-256 is the authorization id.
	Payload []byte
	// Decoded is the strict decode of Payload.
	Decoded    *protocol.AuthorizationPayload
	Signatures []Signature
}

// LocalApproval is an approved local.request: who approved, and the spec hash recorded at
// approval time.
type LocalApproval struct {
	UID        uint32
	SpecSHA256 [32]byte
}

// Input is everything the pure decision needs. Executed, Used and Revoked are the caller's
// persistent state; a nil callback means "no".
type Input struct {
	Now        time.Time
	ClockSkew  time.Duration
	NodeID     string
	NodeGroups []string
	Trust      []Entry
	Task       Task

	Authorization *Authorization
	LocalApproval *LocalApproval

	// Executed reports whether the task id already ran on this node.
	Executed func(taskID string) bool
	// Used reports whether (authorization id, task id) is already in the used list.
	Used func(authorizationID [32]byte, taskID string) bool
	// Revoked reports whether the authorization id is revoked.
	Revoked func(authorizationID [32]byte) bool
}

// Decision is the outcome of Decide. Step is 0 for an accepted task and the failing
// verification step otherwise; Entry is the accepting trust entry's name, empty on
// failure. Message is for the local log and the task.start error message.
type Decision struct {
	Result  Result
	Step    int
	Entry   string
	Message string
}

func (d Decision) String() string {
	if d.Step == 0 {
		return string(d.Result)
	}
	return fmt.Sprintf("%s at step %d: %s", d.Result, d.Step, d.Message)
}

// Decide checks steps 2–9 of the privilege verification flow. It is pure: used/revoked
// state and the clock are supplied by the caller. Steps 2–9 are evaluated in the
// documented order, and a signature candidate that fails reports the first candidate's
// failure (in signature order).
func Decide(in Input) Decision {
	method, target, err := Target(in.Task.Spec)
	if err != nil {
		return failure(ResultRejected, StepTaskCheck, "task: %v", err)
	}
	if method != string(protocol.MethodExec) {
		if err := CheckPath(target); err != nil {
			return failure(ResultRejected, StepTaskCheck, "%v", err)
		}
	}
	specHash, err := protocol.SpecSHA256(in.Task.Spec)
	if err != nil {
		return failure(ResultRejected, StepTaskCheck, "task spec hash: %v", err)
	}
	if in.Authorization == nil {
		return decideLocal(in, method, target, specHash)
	}
	return decideAuthorization(in, method, target, specHash)
}

// decideLocal handles a task.start after crha approve: the local approval takes the place
// of the authorization object, so steps 3, 4 and the command part of step 6 do not apply.
func decideLocal(in Input, method, target string, specHash [32]byte) Decision {
	approval := in.LocalApproval
	if approval == nil {
		return failure(ResultRequired, StepSignatures, "no authorization and no local approval")
	}
	var entries []*Entry
	for i := range in.Trust {
		entry := &in.Trust[i]
		if entry.Role != protocol.TrustRoleLocal {
			continue
		}
		if slices.Contains(entry.UIDs, approval.UID) {
			entries = append(entries, entry)
		}
	}
	if len(entries) == 0 {
		return failure(ResultRequired, StepSignatures, "uid %d is not in a local trust entry", approval.UID)
	}

	var first *Decision
	for _, entry := range entries {
		if in.taskExecuted(in.Task.ID) {
			return failure(ResultAlreadyAccepted, StepOneShot, "task %s already ran on this node", in.Task.ID)
		}
		if approval.SpecSHA256 != specHash {
			decision := failure(ResultRejected, StepCommand, "spec hash differs from the approved one")
			if first == nil {
				first = &decision
			}
			continue
		}
		if decision, ok := checkTrust(entry, in, method, target); !ok {
			if first == nil {
				first = &decision
			}
			continue
		}
		return accepted(entry.Name)
	}
	return *first
}

// decideAuthorization handles task.start with an authorization object.
func decideAuthorization(in Input, method, target string, specHash [32]byte) Decision {
	auth := in.Authorization
	// Re-decode the raw bytes instead of trusting a caller-built Decoded value: this
	// re-applies the payload invariants (version, nodes, task_ids/attempt) and guarantees
	// that revocation and the used list key off the same bytes the signatures cover.
	decoded, err := protocol.DecodeAuthorizationPayload(auth.Payload)
	if err != nil {
		return failure(ResultInvalid, StepSignatures, "authorization payload: %v", err)
	}
	if auth.Decoded == nil || !reflect.DeepEqual(decoded, auth.Decoded) {
		return failure(ResultInvalid, StepSignatures, "authorization payload does not match its decoded form")
	}
	if len(auth.Signatures) == 0 {
		return failure(ResultInvalid, StepSignatures, "authorization has no signatures")
	}

	candidates := make([]*Signature, 0, len(auth.Signatures))
	for i := range auth.Signatures {
		signature := &auth.Signatures[i]
		if signature.Entry == nil {
			continue // signed by a key this node does not trust
		}
		if !signature.Valid {
			return failure(ResultInvalid, StepSignatures,
				"signature by %q does not verify", signature.Entry.Name)
		}
		switch signature.Entry.Role {
		case protocol.TrustRoleCRHS, protocol.TrustRoleUser:
			candidates = append(candidates, signature)
		case protocol.TrustRoleLocal:
			// A local trust entry has uids, not a signature key; it cannot sign.
		default:
			return failure(ResultInvalid, StepSignatures,
				"trust entry %q has unknown role %q", signature.Entry.Name, string(signature.Entry.Role))
		}
	}
	if len(candidates) == 0 {
		return failure(ResultInvalid, StepSignatures, "no signature matches a trust entry")
	}

	authorizationID := protocol.AuthorizationID(auth.Payload)
	var first *Decision
	for _, signature := range candidates {
		decision, ok := checkCandidate(in, auth, signature, authorizationID, method, target, specHash)
		if !ok {
			if first == nil {
				copied := decision
				first = &copied
			}
			continue
		}
		if in.authorizationRevoked(authorizationID) {
			return failure(ResultRejected, StepRevocation, "authorization is revoked")
		}
		return decision
	}
	return *first
}

// checkCandidate evaluates steps 4–8 for one signature and its trust entry.
func checkCandidate(in Input, auth *Authorization, signature *Signature, authorizationID [32]byte,
	method, target string, specHash [32]byte) (Decision, bool) {
	entry := signature.Entry
	payload := auth.Decoded

	// Step 4: the authorization body.
	if !addressedTo(payload.Nodes, in.NodeID, in.NodeGroups) {
		return failure(ResultInvalid, StepAuthorization, "payload does not address this node"), false
	}
	nowMS := in.Now.UnixMilli()
	skewMS := in.ClockSkew.Milliseconds()
	issuedAtMS := int64(payload.IssuedAtMS)
	if issuedAtMS > nowMS+skewMS {
		return failure(ResultExpired, StepAuthorization, "authorization was issued in the future"), false
	}
	if payload.DeadlineMS != nil && int64(*payload.DeadlineMS) < nowMS-skewMS {
		return failure(ResultExpired, StepAuthorization, "authorization has expired"), false
	}
	if entry.MaxTTL != nil {
		if payload.DeadlineMS == nil {
			return failure(ResultExpired, StepAuthorization, "trust entry requires a deadline"), false
		}
		if int64(*payload.DeadlineMS)-issuedAtMS > entry.MaxTTL.Milliseconds() {
			return failure(ResultExpired, StepAuthorization, "authorization ttl exceeds max_ttl"), false
		}
	}
	if entry.RequireExact {
		if payload.Command == nil || payload.Command.Match.Kind != protocol.AuthMatchExact {
			return failure(ResultRejected, StepAuthorization, "trust entry requires an exact command"), false
		}
	}

	// Step 5: one-shot constraints and used state.
	if in.taskExecuted(in.Task.ID) {
		return failure(ResultAlreadyAccepted, StepOneShot, "task %s already ran on this node", in.Task.ID), false
	}
	if payload.TaskIDs != nil {
		if !slices.Contains(*payload.TaskIDs, in.Task.ID) {
			return failure(ResultInvalid, StepOneShot, "task id is not in task_ids"), false
		}
		if payload.Attempt == nil || uint64(*payload.Attempt) != in.Task.Attempt {
			return failure(ResultInvalid, StepOneShot, "attempt does not match task.start"), false
		}
		if payload.DeadlineMS == nil {
			return failure(ResultInvalid, StepOneShot, "one-shot authorization has no deadline"), false
		}
		if in.pairUsed(authorizationID, in.Task.ID) {
			return failure(ResultRejected, StepOneShot, "authorization was already used for this task"), false
		}
	} else {
		if entry.Role == protocol.TrustRoleCRHS {
			return failure(ResultRejected, StepOneShot, "crhs authorizations must carry task_ids"), false
		}
		if entry.RequireTask {
			return failure(ResultRejected, StepOneShot, "trust entry requires task_ids"), false
		}
		// A cosignature is a single confirmation, so an authorization that needs one
		// must be one-shot (doc/privilege.md: all cosignatures require task_ids).
		if cosignRequired(entry) {
			return failure(ResultRejected, StepOneShot, "an authorization that requires cosign must carry task_ids"), false
		}
	}

	// Step 6: the command restriction.
	if !commandCovers(payload.Command, method, target, specHash) {
		return failure(ResultRejected, StepCommand, "authorization does not cover this task"), false
	}

	// Step 7: the trust entry.
	if decision, ok := checkTrust(entry, in, method, target); !ok {
		return decision, false
	}
	if entry.RequireUV && !signature.UserVerified {
		return failure(ResultRejected, StepTrust, "trust entry requires user verification"), false
	}

	// Step 8: cosignature.
	if cosignRequired(entry) {
		if !hasCosign(auth) {
			return failure(ResultRejected, StepCosign, "authorization requires a crhs cosignature"), false
		}
	}
	return accepted(entry.Name), true
}

// checkTrust evaluates the trust entry parts of step 7 common to authorization candidates
// and local approvals.
func checkTrust(entry *Entry, in Input, method, target string) (Decision, bool) {
	if !entry.HasKind(protocol.TrustKindExecute) {
		return failure(ResultRejected, StepTrust, "trust entry %q cannot authorize (no execute)", entry.Name), false
	}
	if !guardAllows(entry, method, target) {
		return failure(ResultRejected, StepTrust, "trust entry %q rules reject this task", entry.Name), false
	}
	if !envAllowed(in.Task.Spec, entry.EnvAllow) {
		return failure(ResultRejected, StepTrust, "trust entry %q does not allow the task environment", entry.Name), false
	}
	return accepted(entry.Name), true
}

// cosignRequired reports whether the entry is a user entry whose authorizations must carry
// a crhs cosignature.
func cosignRequired(entry *Entry) bool {
	return entry.Role == protocol.TrustRoleUser && entry.HasKind(protocol.TrustKindRequireCosign)
}

// hasCosign reports whether the payload carries a valid crhs signature with the cosign
// kind. The cosign entry's own require_exact, max_ttl and allow/deny rules do not apply.
func hasCosign(auth *Authorization) bool {
	for i := range auth.Signatures {
		signature := &auth.Signatures[i]
		if signature.Entry == nil || !signature.Valid {
			continue
		}
		if signature.Entry.Role == protocol.TrustRoleCRHS && signature.Entry.HasKind(protocol.TrustKindCosign) {
			return true
		}
	}
	return false
}

// addressedTo reports whether the payload's nodes cover this node: its id, a configured
// group ("group:<name>"), or "*".
func addressedTo(nodes []string, nodeID string, groups []string) bool {
	for _, node := range nodes {
		if node == "*" || node == nodeID {
			return true
		}
		if group, ok := strings.CutPrefix(node, "group:"); ok && slices.Contains(groups, group) {
			return true
		}
	}
	return false
}

// commandCovers reports whether the authorization's command restriction covers the task.
// A nil command covers every method and target.
func commandCovers(command *protocol.AuthCommand, method, target string, specHash [32]byte) bool {
	if command == nil {
		return true
	}
	switch command.Match.Kind {
	case protocol.AuthMatchExact:
		if command.Match.Exact == nil {
			return false
		}
		return string(command.Method) == method &&
			command.Match.Exact.Target == target &&
			command.Match.Exact.SpecSHA256 == specHash
	case protocol.AuthMatchPrefix:
		if command.Match.Prefix == nil {
			return false
		}
		return methodCovers(string(command.Method), method) &&
			strings.HasPrefix(target, command.Match.Prefix.Target)
	default:
		return false
	}
}

// methodCovers reports whether an authorization for authorized also covers actual.
// file.write includes file.read; the reverse never holds.
func methodCovers(authorized, actual string) bool {
	if authorized == actual {
		return true
	}
	return authorized == string(protocol.MethodFileWrite) && actual == string(protocol.MethodFileRead)
}

func (in Input) taskExecuted(taskID string) bool {
	return in.Executed != nil && in.Executed(taskID)
}

func (in Input) pairUsed(authorizationID [32]byte, taskID string) bool {
	return in.Used != nil && in.Used(authorizationID, taskID)
}

func (in Input) authorizationRevoked(authorizationID [32]byte) bool {
	return in.Revoked != nil && in.Revoked(authorizationID)
}

func accepted(entry string) Decision {
	return Decision{Result: ResultAccepted, Entry: entry}
}

func failure(result Result, step int, format string, args ...any) Decision {
	return Decision{Result: result, Step: step, Message: fmt.Sprintf(format, args...)}
}
