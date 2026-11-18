package daemon

import (
	"errors"
	"fmt"

	"github.com/Kodecable/ClusterRightHand/client/internal/privileged/authz"
	"github.com/Kodecable/ClusterRightHand/client/internal/privileged/config"
	"github.com/Kodecable/ClusterRightHand/client/internal/privileged/taskrun"
	"github.com/Kodecable/ClusterRightHand/client/internal/protocol"
)

// decidedTask is a task.start that passed verification, with everything the caller needs to
// persist and execute it.
type decidedTask struct {
	decision *authz.Decision
	specHash [32]byte
	// authorization is nil only when a privileged task.start carries no authorization.
	authorization   *authz.Authorization
	payload         *protocol.AuthorizationPayload
	authorizationID [32]byte
	// exact reports whether the cwd of the task is left as specified: an exact authorization
	// pins the complete spec.
	exact bool
	// window is the local approval window a crhs signature was accepted through; nil when the
	// task used the ordinary entry rules.
	window *localWindow
}

// refusal is a refused task.start: its error code, the verification step of
// doc/design/privilege.md "Validation flow" it failed (0 for a malformed task.start outside the flow) and the
// message. The local log records the step and message separately; the error response
// combines them (remote).
type refusal struct {
	code    string
	step    int
	message string
}

// stepRefusal is the refusal of a verification step.
func stepRefusal(result authz.Result, step int, message string) *refusal {
	return &refusal{code: string(result), step: step, message: message}
}

// remote builds the task.start error response: code plus "step N: message" from the failed
// verification step, or the bare message of a refusal outside the flow.
func (r *refusal) remote() *protocol.RemoteError {
	if r.step == 0 {
		return &protocol.RemoteError{Code: r.code, Message: r.message}
	}
	return &protocol.RemoteError{
		Code:    r.code,
		Message: fmt.Sprintf("step %d: %s", r.step, r.message),
	}
}

// decide verifies task.start against the current configuration, the local window and the
// persistent state. On a refusal nothing has been persisted or executed.
func (s *Server) decide(ts *protocol.TaskStart) (*decidedTask, *refusal) {
	cfg := s.Config()
	decided := &decidedTask{}
	if err := taskrun.Validate(*ts); err != nil {
		var remote *protocol.RemoteError
		if errors.As(err, &remote) {
			return nil, &refusal{code: remote.Code, message: remote.Message}
		}
		return nil, &refusal{code: protocol.CodeInvalidSpec, message: err.Error()}
	}
	specHash, err := protocol.SpecSHA256(&ts.Spec)
	if err != nil {
		return nil, &refusal{code: protocol.CodeInvalidSpec, message: err.Error()}
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

	window := s.windowSnapshot()
	var authzWindow *authz.Window
	if window != nil {
		authzWindow = &authz.Window{OpenedBy: window.openedBy, OpenedAt: window.openedAt, Until: window.until}
	}
	decision := authz.Decide(authz.Input{
		Now:           s.now(),
		ClockSkew:     cfg.ClockSkew,
		NodeID:        cfg.NodeID,
		Aliases:       cfg.Aliases,
		Trust:         cfg.Entries(),
		Task:          authz.Task{ID: ts.TaskID, Attempt: uint64(ts.Attempt), Spec: &ts.Spec},
		Authorization: authorization,
		Window:        authzWindow,
		Executed:      s.store.Executed,
		Used:          s.store.Used,
		Watermarked:   s.store.Watermarked,
	})
	if decision.Result != authz.ResultAccepted {
		return nil, stepRefusal(decision.Result, decision.Step, decision.Message)
	}
	decided.decision = &decision
	if decision.Window {
		decided.window = window
	}
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
// (doc/design/privilege.md "Validation flow" step 3).
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
