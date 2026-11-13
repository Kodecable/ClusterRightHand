package protocol

import (
	"crypto/sha256"
	"errors"
	"fmt"
)

// Privilege wire types: the authorization object, TrustSummary and local approval
// (doc/design/protocol.md "Privilege messages"). The crh-priv handshake types live with the crh-priv framing.
//
// Every type mirrors the corresponding codec in packages/protocol/src/privileged.ts:
// fixed-length tuples in declaration order, [tag, body] unions, text enums, and CBOR null
// for nullable fields. Strict decoding (phase 1) and re-encoding (phase 2) are provided by
// Marshal and Unmarshal in cbor.go.

const (
	// AuthNamespace is the SSHSIG namespace and the WebAuthn challenge prefix.
	AuthNamespace = "crh-auth-v1"
	// AuthPayloadVersion is the only supported AuthorizationPayload.v value.
	AuthPayloadVersion = 1
)

// Method is the method of a task, guard rule or authorization command.
type Method string

const (
	MethodExec      Method = "exec"
	MethodFileRead  Method = "file.read"
	MethodFileWrite Method = "file.write"
)

// methods is the method enum.
var methods = newEnum("method", MethodExec, MethodFileRead, MethodFileWrite)

// MarshalCBOR encodes the method, rejecting values outside the schema.
func (m Method) MarshalCBOR() ([]byte, error) { return methods.marshal(m) }

// UnmarshalCBOR decodes and validates the method.
func (m *Method) UnmarshalCBOR(data []byte) error { return methods.unmarshal(data, m) }

// GuardMatch selects how a guard rule matches its target.
type GuardMatch string

const (
	GuardMatchAny    GuardMatch = "any"
	GuardMatchPrefix GuardMatch = "prefix"
	GuardMatchRegex  GuardMatch = "regex"
)

// guardMatches is the guard match enum.
var guardMatches = newEnum("guard match", GuardMatchAny, GuardMatchPrefix, GuardMatchRegex)

// MarshalCBOR encodes the match kind, rejecting values outside the schema.
func (m GuardMatch) MarshalCBOR() ([]byte, error) { return guardMatches.marshal(m) }

// UnmarshalCBOR decodes and validates the match kind.
func (m *GuardMatch) UnmarshalCBOR(data []byte) error { return guardMatches.unmarshal(data, m) }

// GuardRule is one allow or deny rule of a trust entry.
type GuardRule struct {
	_       struct{} `cbor:",toarray"`
	Method  Method
	Match   GuardMatch
	Pattern string
}

// Identity is a running identity reported in TrustSummary.
type Identity struct {
	_    struct{} `cbor:",toarray"`
	UID  Uint
	GID  Uint
	User string
}

// TrustKeyKind is a TrustKey union tag.
type TrustKeyKind string

const (
	TrustKeySSHSig   TrustKeyKind = "sshsig"
	TrustKeyWebAuthn TrustKeyKind = "webauthn"
	TrustKeyLocal    TrustKeyKind = "local"
)

// SSHTrustKey is the "sshsig" TrustKey body: an authorized_keys line and its SHA256
// fingerprint.
type SSHTrustKey struct {
	_           struct{} `cbor:",toarray"`
	PublicKey   string
	Fingerprint string
}

// WebAuthnTrustKey is the "webauthn" TrustKey body.
type WebAuthnTrustKey struct {
	_            struct{} `cbor:",toarray"`
	CredentialID []byte
	COSEKey      []byte
	RPID         string
	Origins      []string
}

// LocalTrustKey is the "local" TrustKey body: the uids allowed to approve locally.
type LocalTrustKey struct {
	_    struct{} `cbor:",toarray"`
	UIDs []Uint
}

// TrustKey is the union of the ways a trust entry identifies its signer.
type TrustKey struct {
	Kind TrustKeyKind

	SSHSig   *SSHTrustKey
	WebAuthn *WebAuthnTrustKey
	Local    *LocalTrustKey
}

// trustKeyUnion is the TrustKey union: how a trust entry identifies its signer.
var trustKeyUnion = newUnion("trust key",
	unionPtr[TrustKey]("sshsig", func(k *TrustKey) **SSHTrustKey { return &k.SSHSig }),
	unionPtr[TrustKey]("webauthn", func(k *TrustKey) **WebAuthnTrustKey { return &k.WebAuthn }),
	unionPtr[TrustKey]("local", func(k *TrustKey) **LocalTrustKey { return &k.Local }),
)

// MarshalCBOR encodes a TrustKey as [tag, body].
func (k TrustKey) MarshalCBOR() ([]byte, error) { return trustKeyUnion.marshal(k, string(k.Kind)) }

// UnmarshalCBOR decodes [tag, body] into the matching TrustKey branch.
func (k *TrustKey) UnmarshalCBOR(data []byte) error {
	tag, err := trustKeyUnion.unmarshal(data, k)
	if err != nil {
		return err
	}
	k.Kind = TrustKeyKind(tag)
	return nil
}

// TrustSource is the origin of a trust entry. v1 has only "local"; the field is reserved
// for signed trust bundles.
type TrustSource string

const (
	TrustSourceLocal TrustSource = "local"
)

// trustSources is the trust source enum.
var trustSources = newEnum("trust source", TrustSourceLocal)

// MarshalCBOR encodes the source, rejecting values outside the schema.
func (s TrustSource) MarshalCBOR() ([]byte, error) { return trustSources.marshal(s) }

// UnmarshalCBOR decodes and validates the source.
func (s *TrustSource) UnmarshalCBOR(data []byte) error { return trustSources.unmarshal(data, s) }

// TrustRole is the role of a trust entry.
type TrustRole string

const (
	TrustRoleCRHS  TrustRole = "crhs"
	TrustRoleUser  TrustRole = "user"
	TrustRoleLocal TrustRole = "local"
)

// trustRoles is the trust role enum.
var trustRoles = newEnum("trust role", TrustRoleCRHS, TrustRoleUser, TrustRoleLocal)

// MarshalCBOR encodes the role, rejecting values outside the schema.
func (r TrustRole) MarshalCBOR() ([]byte, error) { return trustRoles.marshal(r) }

// UnmarshalCBOR decodes and validates the role.
func (r *TrustRole) UnmarshalCBOR(data []byte) error { return trustRoles.unmarshal(data, r) }

// TrustKind is one capability of a trust entry.
type TrustKind string

const (
	TrustKindExecute       TrustKind = "execute"
	TrustKindCosign        TrustKind = "cosign"
	TrustKindRequireCosign TrustKind = "require-cosign"
)

// trustKinds is the trust kind enum.
var trustKinds = newEnum("trust kind", TrustKindExecute, TrustKindCosign, TrustKindRequireCosign)

// MarshalCBOR encodes the kind, rejecting values outside the schema.
func (k TrustKind) MarshalCBOR() ([]byte, error) { return trustKinds.marshal(k) }

// UnmarshalCBOR decodes and validates the kind.
func (k *TrustKind) UnmarshalCBOR(data []byte) error { return trustKinds.unmarshal(data, k) }

// TrustEntry is one item of TrustSummary.trust.
type TrustEntry struct {
	_            struct{} `cbor:",toarray"`
	Name         string
	Source       TrustSource
	Role         TrustRole
	Key          TrustKey
	Kinds        []TrustKind
	RequireExact bool
	RequireTask  bool
	RequireUV    bool
	MaxTTLMS     *Uint
	Allow        []GuardRule
	Deny         []GuardRule
	EnvAllow     []string
}

// Identities is the unprivileged/privileged pair of TrustSummary.identities.
type Identities struct {
	_            struct{} `cbor:",toarray"`
	Unprivileged Identity
	Privileged   Identity
}

// TrustSummary is the trust configuration crha reports to crhs.
type TrustSummary struct {
	_           struct{} `cbor:",toarray"`
	NodeID      string
	Aliases     []string
	ClockSkewMS Uint
	Identities  Identities
	Trust       []TrustEntry
}

// TrustReportKind is a TrustReport union tag.
type TrustReportKind string

const (
	TrustReportOK          TrustReportKind = "ok"
	TrustReportUnavailable TrustReportKind = "unavailable"
	TrustReportNotForward  TrustReportKind = "not_forward"
)

// TrustReport is the trust.summary event body.
type TrustReport struct {
	Kind TrustReportKind

	Summary *TrustSummary
	Message string
}

// trustReportUnion is the TrustReport union: the trust summary, why it is unavailable, or that this
// mode does not forward.
var trustReportUnion = newUnion("trust report",
	withMissing(unionPtr[TrustReport]("ok", func(r *TrustReport) **TrustSummary { return &r.Summary }),
		"protocol: ok trust report has no summary"),
	unionMessage("unavailable", func(r TrustReport) string { return r.Message },
		func(r *TrustReport, message string) { r.Message = message }),
	unionEmpty[TrustReport]("not_forward"),
)

// MarshalCBOR encodes a TrustReport as [tag, body].
func (r TrustReport) MarshalCBOR() ([]byte, error) {
	return trustReportUnion.marshal(r, string(r.Kind))
}

// UnmarshalCBOR decodes [tag, body] into the matching TrustReport branch.
func (r *TrustReport) UnmarshalCBOR(data []byte) error {
	tag, err := trustReportUnion.unmarshal(data, r)
	if err != nil {
		return err
	}
	r.Kind = TrustReportKind(tag)
	return nil
}

// LocalRequest is the local.request command body. InputPreview is the first bytes of the task's
// stdin or file content, so an approver can see what will be executed; nil means the sender did not
// provide one (doc/design/privilege.md "Local approval").
type LocalRequest struct {
	_            struct{} `cbor:",toarray"`
	TaskID       string
	Attempt      Uint
	Spec         TaskSpec
	Note         string
	InputPreview []byte
}

// LocalStateKind is a LocalState union tag.
type LocalStateKind string

const (
	LocalStatePending  LocalStateKind = "pending"
	LocalStateApproved LocalStateKind = "approved"
	LocalStateDenied   LocalStateKind = "denied"
)

// LocalState is the state of one local approval.
type LocalState struct {
	Kind    LocalStateKind
	Message string
}

// localStateUnion is the LocalState union: a pending or approved request has an empty body, a denied
// one carries its reason.
var localStateUnion = newBareUnion("local state",
	unionEmpty[LocalState]("pending"),
	unionEmpty[LocalState]("approved"),
	unionMessage("denied", func(s LocalState) string { return s.Message },
		func(s *LocalState, message string) { s.Message = message }),
)

// MarshalCBOR encodes a LocalState as [tag, body].
func (s LocalState) MarshalCBOR() ([]byte, error) { return localStateUnion.marshal(s, string(s.Kind)) }

// UnmarshalCBOR decodes [tag, body] into the matching LocalState branch.
func (s *LocalState) UnmarshalCBOR(data []byte) error {
	tag, err := localStateUnion.unmarshal(data, s)
	if err != nil {
		return err
	}
	s.Kind = LocalStateKind(tag)
	return nil
}

// LocalWithdraw is the local.withdraw request body.
type LocalWithdraw struct {
	_       struct{} `cbor:",toarray"`
	TaskID  string
	Attempt Uint
}

// LocalDecision is the local.decision event body.
type LocalDecision struct {
	_       struct{} `cbor:",toarray"`
	TaskID  string
	Attempt Uint
	State   LocalState
}

// AuthMatchKind is an AuthMatch union tag.
type AuthMatchKind string

const (
	AuthMatchExact  AuthMatchKind = "exact"
	AuthMatchPrefix AuthMatchKind = "prefix"
)

// AuthExact is the "exact" AuthMatch body: the rendered target and the complete task spec
// hash the authorization was issued for.
type AuthExact struct {
	_          struct{} `cbor:",toarray"`
	Target     string
	SpecSHA256 Hash
}

// AuthPrefix is the "prefix" AuthMatch body.
type AuthPrefix struct {
	_      struct{} `cbor:",toarray"`
	Target string
}

// AuthMatch is the union of ways an authorization constrains the target.
type AuthMatch struct {
	Kind AuthMatchKind

	Exact  *AuthExact
	Prefix *AuthPrefix
}

// authMatchUnion is the AuthMatch union: how an authorization constrains the target.
var authMatchUnion = newUnion("auth match",
	unionPtr[AuthMatch]("exact", func(m *AuthMatch) **AuthExact { return &m.Exact }),
	unionPtr[AuthMatch]("prefix", func(m *AuthMatch) **AuthPrefix { return &m.Prefix }),
)

// MarshalCBOR encodes an AuthMatch as [tag, body].
func (m AuthMatch) MarshalCBOR() ([]byte, error) { return authMatchUnion.marshal(m, string(m.Kind)) }

// UnmarshalCBOR decodes [tag, body] into the matching AuthMatch branch.
func (m *AuthMatch) UnmarshalCBOR(data []byte) error {
	tag, err := authMatchUnion.unmarshal(data, m)
	if err != nil {
		return err
	}
	m.Kind = AuthMatchKind(tag)
	return nil
}

// AuthCommand is the optional command restriction of an authorization payload.
type AuthCommand struct {
	_      struct{} `cbor:",toarray"`
	Method Method
	Match  AuthMatch
}

// AuthorizationPayload is CBOR(AuthorizationPayload), the bytes that are signed.
type AuthorizationPayload struct {
	_          struct{} `cbor:",toarray"`
	V          Uint
	Nodes      []string
	Command    *AuthCommand
	IssuedAtMS Int
	DeadlineMS *Int
	TaskIDs    *[]string
	Attempt    *Uint
	Note       string
}

// SignatureKind is a Signature union tag.
type SignatureKind string

const (
	SignatureSSHSig   SignatureKind = "sshsig"
	SignatureWebAuthn SignatureKind = "webauthn"
)

// SSHSigSignature is the "sshsig" Signature body: the raw SSHSIG blob without armor.
type SSHSigSignature struct {
	_    struct{} `cbor:",toarray"`
	Blob []byte
}

// WebAuthnSignature is the "webauthn" Signature body.
type WebAuthnSignature struct {
	_                 struct{} `cbor:",toarray"`
	CredentialID      []byte
	AuthenticatorData []byte
	ClientDataJSON    []byte
	Signature         []byte
}

// Signature is one signature over an authorization payload.
type Signature struct {
	Kind SignatureKind

	SSHSig   *SSHSigSignature
	WebAuthn *WebAuthnSignature
}

// signatureUnion is the Signature union: one signature form over an authorization payload.
var signatureUnion = newUnion("signature",
	unionPtr[Signature]("sshsig", func(s *Signature) **SSHSigSignature { return &s.SSHSig }),
	unionPtr[Signature]("webauthn", func(s *Signature) **WebAuthnSignature { return &s.WebAuthn }),
)

// MarshalCBOR encodes a Signature as [tag, body].
func (s Signature) MarshalCBOR() ([]byte, error) { return signatureUnion.marshal(s, string(s.Kind)) }

// UnmarshalCBOR decodes [tag, body] into the matching Signature branch.
func (s *Signature) UnmarshalCBOR(data []byte) error {
	tag, err := signatureUnion.unmarshal(data, s)
	if err != nil {
		return err
	}
	s.Kind = SignatureKind(tag)
	return nil
}

// Authorization is one CBOR(Authorization): the signed payload bytes and their signatures.
type Authorization struct {
	_          struct{} `cbor:",toarray"`
	Payload    []byte
	Signatures []Signature
}

// PendingEntry is one entry of the crh-priv pending.list response. InputPreview is the beginning of
// the task's stdin or file content, as sent with local.request.
type PendingEntry struct {
	_            struct{} `cbor:",toarray"`
	TaskID       string
	Attempt      Uint
	Spec         TaskSpec
	Note         string
	ReceivedAtMS Int
	InputPreview []byte
}

// LocalVerdict is the crh-priv local.approve / local.deny request body. SpecSHA256 binds the
// verdict to the exact spec the approver saw: the privileged mode refuses it when the pending
// record's hash differs (doc/design/protocol.md "crh-priv", doc/design/privilege.md "Local approval").
type LocalVerdict struct {
	_          struct{} `cbor:",toarray"`
	TaskID     string
	Attempt    Uint
	SpecSHA256 Hash
	Message    string
}

// DecodeAuthorizationPayload strictly decodes payload bytes and enforces the structural
// rules of doc/design/protocol.md "Authorization object" that are not visible in the schema.
func DecodeAuthorizationPayload(payloadBytes []byte) (*AuthorizationPayload, error) {
	var payload AuthorizationPayload
	if err := Unmarshal(payloadBytes, &payload); err != nil {
		return nil, err
	}
	if err := checkAuthorizationPayload(&payload); err != nil {
		return nil, err
	}
	return &payload, nil
}

// checkAuthorizationPayload applies the payload invariants beyond the tuple shape.
func checkAuthorizationPayload(payload *AuthorizationPayload) error {
	fail := func(reason string) error {
		return protocolErrorf("authorization payload: %s", reason)
	}
	if payload.V != AuthPayloadVersion {
		return fail(fmt.Sprintf("unsupported version %d", payload.V))
	}
	if len(payload.Nodes) == 0 {
		return fail("nodes is empty")
	}
	star := false
	seenNodes := make(map[string]struct{}, len(payload.Nodes))
	for _, node := range payload.Nodes {
		if node == "*" {
			star = true
		}
		if _, dup := seenNodes[node]; dup {
			return fail("duplicate nodes")
		}
		seenNodes[node] = struct{}{}
	}
	if star && len(payload.Nodes) != 1 {
		return fail(`"*" must be the only node`)
	}
	if (payload.TaskIDs == nil) != (payload.Attempt == nil) {
		return fail("task_ids and attempt must both be null or both be set")
	}
	if payload.TaskIDs != nil {
		if len(*payload.TaskIDs) == 0 {
			return fail("task_ids is empty")
		}
		seenTasks := make(map[string]struct{}, len(*payload.TaskIDs))
		for _, task := range *payload.TaskIDs {
			if _, dup := seenTasks[task]; dup {
				return fail("duplicate task_ids")
			}
			seenTasks[task] = struct{}{}
		}
	}
	if payload.Attempt != nil && *payload.Attempt < 1 {
		return fail("attempt must be at least 1")
	}
	return nil
}

// AuthorizationID is SHA-256 of the raw payload bytes.
func AuthorizationID(payload []byte) [32]byte {
	return sha256.Sum256(payload)
}

// SpecSHA256 is SHA-256 of the canonical CBOR encoding of spec. It is the value an exact
// authorization pins in spec_sha256.
//
// A file.push/file.pull endpoint is crhs-side routing, so its transfer id is left out: every member of
// a copy task group then hashes like the group's spec and one authorization covers them all.
func SpecSHA256(spec *TaskSpec) ([32]byte, error) {
	var zero [32]byte
	if spec == nil {
		return zero, errors.New("protocol: nil task spec")
	}
	canonical := *spec
	if spec.FilePush != nil {
		push := *spec.FilePush
		push.Endpoint.TransferID = ""
		canonical.FilePush = &push
	}
	if spec.FilePull != nil {
		pull := *spec.FilePull
		pull.Endpoint.TransferID = ""
		canonical.FilePull = &pull
	}
	encoded, err := Marshal(&canonical)
	if err != nil {
		return zero, fmt.Errorf("protocol: encode task spec: %w", err)
	}
	return sha256.Sum256(encoded), nil
}

// TrustDigest is SHA-256 of CBOR(summary), the digest crhs caches and records for a task.
func TrustDigest(summary *TrustSummary) ([32]byte, error) {
	var zero [32]byte
	if summary == nil {
		return zero, errors.New("protocol: nil trust summary")
	}
	encoded, err := Marshal(summary)
	if err != nil {
		return zero, fmt.Errorf("protocol: encode trust summary: %w", err)
	}
	return sha256.Sum256(encoded), nil
}
