package protocol

import (
	"crypto/sha256"
	"errors"
	"fmt"
)

// M4 wire types: the authorization object, TrustSummary, local approval and revocations
// (doc/protocol.md#m4提权). The crh-priv handshake types live with the crh-priv framing.
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

func (m Method) valid() bool {
	switch m {
	case MethodExec, MethodFileRead, MethodFileWrite:
		return true
	default:
		return false
	}
}

// MarshalCBOR encodes the method, rejecting values outside the schema.
func (m Method) MarshalCBOR() ([]byte, error) {
	return marshalEnum("method", m, Method.valid)
}

// UnmarshalCBOR decodes and validates the method.
func (m *Method) UnmarshalCBOR(data []byte) error {
	return unmarshalEnum("method", data, m, Method.valid)
}

// GuardMatch selects how a guard rule matches its target.
type GuardMatch string

const (
	GuardMatchAny    GuardMatch = "any"
	GuardMatchPrefix GuardMatch = "prefix"
	GuardMatchRegex  GuardMatch = "regex"
)

func (m GuardMatch) valid() bool {
	switch m {
	case GuardMatchAny, GuardMatchPrefix, GuardMatchRegex:
		return true
	default:
		return false
	}
}

// MarshalCBOR encodes the match kind, rejecting values outside the schema.
func (m GuardMatch) MarshalCBOR() ([]byte, error) {
	return marshalEnum("guard match", m, GuardMatch.valid)
}

// UnmarshalCBOR decodes and validates the match kind.
func (m *GuardMatch) UnmarshalCBOR(data []byte) error {
	return unmarshalEnum("guard match", data, m, GuardMatch.valid)
}

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

// MarshalCBOR encodes a TrustKey as [tag, body].
func (k TrustKey) MarshalCBOR() ([]byte, error) {
	switch k.Kind {
	case TrustKeySSHSig:
		if k.SSHSig == nil {
			return nil, errors.New("protocol: sshsig trust key has no body")
		}
		return encodeUnion(string(k.Kind), k.SSHSig)
	case TrustKeyWebAuthn:
		if k.WebAuthn == nil {
			return nil, errors.New("protocol: webauthn trust key has no body")
		}
		return encodeUnion(string(k.Kind), k.WebAuthn)
	case TrustKeyLocal:
		if k.Local == nil {
			return nil, errors.New("protocol: local trust key has no body")
		}
		return encodeUnion(string(k.Kind), k.Local)
	default:
		return nil, fmt.Errorf("protocol: unknown trust key kind %q", string(k.Kind))
	}
}

// UnmarshalCBOR decodes [tag, body] into the matching TrustKey branch.
func (k *TrustKey) UnmarshalCBOR(data []byte) error {
	tag, body, err := decodeUnion(data)
	if err != nil {
		return err
	}
	key := TrustKey{Kind: TrustKeyKind(tag)}
	switch key.Kind {
	case TrustKeySSHSig:
		var v SSHTrustKey
		if err := decMode.Unmarshal(body, &v); err != nil {
			return err
		}
		key.SSHSig = &v
	case TrustKeyWebAuthn:
		var v WebAuthnTrustKey
		if err := decMode.Unmarshal(body, &v); err != nil {
			return err
		}
		key.WebAuthn = &v
	case TrustKeyLocal:
		var v LocalTrustKey
		if err := decMode.Unmarshal(body, &v); err != nil {
			return err
		}
		key.Local = &v
	default:
		return fmt.Errorf("protocol: unknown trust key tag %q", tag)
	}
	*k = key
	return nil
}

// TrustSource is the origin of a trust entry. v1 has only "local"; the field is reserved
// for signed trust bundles.
type TrustSource string

const (
	TrustSourceLocal TrustSource = "local"
)

func (s TrustSource) valid() bool { return s == TrustSourceLocal }

// MarshalCBOR encodes the source, rejecting values outside the schema.
func (s TrustSource) MarshalCBOR() ([]byte, error) {
	return marshalEnum("trust source", s, TrustSource.valid)
}

// UnmarshalCBOR decodes and validates the source.
func (s *TrustSource) UnmarshalCBOR(data []byte) error {
	return unmarshalEnum("trust source", data, s, TrustSource.valid)
}

// TrustRole is the role of a trust entry.
type TrustRole string

const (
	TrustRoleCRHS  TrustRole = "crhs"
	TrustRoleUser  TrustRole = "user"
	TrustRoleLocal TrustRole = "local"
)

func (r TrustRole) valid() bool {
	switch r {
	case TrustRoleCRHS, TrustRoleUser, TrustRoleLocal:
		return true
	default:
		return false
	}
}

// MarshalCBOR encodes the role, rejecting values outside the schema.
func (r TrustRole) MarshalCBOR() ([]byte, error) {
	return marshalEnum("trust role", r, TrustRole.valid)
}

// UnmarshalCBOR decodes and validates the role.
func (r *TrustRole) UnmarshalCBOR(data []byte) error {
	return unmarshalEnum("trust role", data, r, TrustRole.valid)
}

// TrustKind is one capability of a trust entry.
type TrustKind string

const (
	TrustKindExecute       TrustKind = "execute"
	TrustKindCosign        TrustKind = "cosign"
	TrustKindRequireCosign TrustKind = "require-cosign"
)

func (k TrustKind) valid() bool {
	switch k {
	case TrustKindExecute, TrustKindCosign, TrustKindRequireCosign:
		return true
	default:
		return false
	}
}

// MarshalCBOR encodes the kind, rejecting values outside the schema.
func (k TrustKind) MarshalCBOR() ([]byte, error) {
	return marshalEnum("trust kind", k, TrustKind.valid)
}

// UnmarshalCBOR decodes and validates the kind.
func (k *TrustKind) UnmarshalCBOR(data []byte) error {
	return unmarshalEnum("trust kind", data, k, TrustKind.valid)
}

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
	Groups      []string
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

// messageBody is the body of union branches that carry only a message.
type messageBody struct {
	_       struct{} `cbor:",toarray"`
	Message string
}

// TrustReport is the trust.summary event body.
type TrustReport struct {
	Kind TrustReportKind

	Summary *TrustSummary
	Message string
}

// MarshalCBOR encodes a TrustReport as [tag, body].
func (r TrustReport) MarshalCBOR() ([]byte, error) {
	switch r.Kind {
	case TrustReportOK:
		if r.Summary == nil {
			return nil, errors.New("protocol: ok trust report has no summary")
		}
		return encodeUnion(string(r.Kind), r.Summary)
	case TrustReportUnavailable:
		return encodeUnion(string(r.Kind), messageBody{Message: r.Message})
	case TrustReportNotForward:
		return encodeUnion(string(r.Kind), Empty{})
	default:
		return nil, fmt.Errorf("protocol: unknown trust report kind %q", string(r.Kind))
	}
}

// UnmarshalCBOR decodes [tag, body] into the matching TrustReport branch.
func (r *TrustReport) UnmarshalCBOR(data []byte) error {
	tag, body, err := decodeUnion(data)
	if err != nil {
		return err
	}
	report := TrustReport{Kind: TrustReportKind(tag)}
	switch report.Kind {
	case TrustReportOK:
		var v TrustSummary
		if err := decMode.Unmarshal(body, &v); err != nil {
			return err
		}
		report.Summary = &v
	case TrustReportUnavailable:
		var v messageBody
		if err := decMode.Unmarshal(body, &v); err != nil {
			return err
		}
		report.Message = v.Message
	case TrustReportNotForward:
		var v Empty
		if err := decMode.Unmarshal(body, &v); err != nil {
			return err
		}
	default:
		return fmt.Errorf("protocol: unknown trust report tag %q", tag)
	}
	*r = report
	return nil
}

// Revocation is one entry of revocations.add. AuthorizationID is exactly 32 bytes; a missing
// deadline means the authorization never expires.
type Revocation struct {
	_               struct{} `cbor:",toarray"`
	AuthorizationID Hash
	DeadlineMS      *Int
}

// RevocationsAdd is the revocations.add request body.
type RevocationsAdd struct {
	_       struct{} `cbor:",toarray"`
	Entries []Revocation
}

// LocalRequest is the local.request command body.
type LocalRequest struct {
	_       struct{} `cbor:",toarray"`
	TaskID  string
	Attempt Uint
	Spec    TaskSpec
	Note    string
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

// MarshalCBOR encodes a LocalState as [tag, body].
func (s LocalState) MarshalCBOR() ([]byte, error) {
	switch s.Kind {
	case LocalStatePending, LocalStateApproved:
		return encodeUnion(string(s.Kind), Empty{})
	case LocalStateDenied:
		return encodeUnion(string(s.Kind), messageBody{Message: s.Message})
	default:
		return nil, fmt.Errorf("protocol: unknown local state %q", string(s.Kind))
	}
}

// UnmarshalCBOR decodes [tag, body] into the matching LocalState branch.
func (s *LocalState) UnmarshalCBOR(data []byte) error {
	tag, body, err := decodeUnion(data)
	if err != nil {
		return err
	}
	state := LocalState{Kind: LocalStateKind(tag)}
	switch state.Kind {
	case LocalStatePending, LocalStateApproved:
		var v Empty
		if err := decMode.Unmarshal(body, &v); err != nil {
			return err
		}
	case LocalStateDenied:
		var v messageBody
		if err := decMode.Unmarshal(body, &v); err != nil {
			return err
		}
		state.Message = v.Message
	default:
		return fmt.Errorf("protocol: unknown local state tag %q", tag)
	}
	*s = state
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

// MarshalCBOR encodes an AuthMatch as [tag, body].
func (m AuthMatch) MarshalCBOR() ([]byte, error) {
	switch m.Kind {
	case AuthMatchExact:
		if m.Exact == nil {
			return nil, errors.New("protocol: exact auth match has no body")
		}
		return encodeUnion(string(m.Kind), m.Exact)
	case AuthMatchPrefix:
		if m.Prefix == nil {
			return nil, errors.New("protocol: prefix auth match has no body")
		}
		return encodeUnion(string(m.Kind), m.Prefix)
	default:
		return nil, fmt.Errorf("protocol: unknown auth match kind %q", string(m.Kind))
	}
}

// UnmarshalCBOR decodes [tag, body] into the matching AuthMatch branch.
func (m *AuthMatch) UnmarshalCBOR(data []byte) error {
	tag, body, err := decodeUnion(data)
	if err != nil {
		return err
	}
	match := AuthMatch{Kind: AuthMatchKind(tag)}
	switch match.Kind {
	case AuthMatchExact:
		var v AuthExact
		if err := decMode.Unmarshal(body, &v); err != nil {
			return err
		}
		match.Exact = &v
	case AuthMatchPrefix:
		var v AuthPrefix
		if err := decMode.Unmarshal(body, &v); err != nil {
			return err
		}
		match.Prefix = &v
	default:
		return fmt.Errorf("protocol: unknown auth match tag %q", tag)
	}
	*m = match
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

// MarshalCBOR encodes a Signature as [tag, body].
func (s Signature) MarshalCBOR() ([]byte, error) {
	switch s.Kind {
	case SignatureSSHSig:
		if s.SSHSig == nil {
			return nil, errors.New("protocol: sshsig signature has no body")
		}
		return encodeUnion(string(s.Kind), s.SSHSig)
	case SignatureWebAuthn:
		if s.WebAuthn == nil {
			return nil, errors.New("protocol: webauthn signature has no body")
		}
		return encodeUnion(string(s.Kind), s.WebAuthn)
	default:
		return nil, fmt.Errorf("protocol: unknown signature kind %q", string(s.Kind))
	}
}

// UnmarshalCBOR decodes [tag, body] into the matching Signature branch.
func (s *Signature) UnmarshalCBOR(data []byte) error {
	tag, body, err := decodeUnion(data)
	if err != nil {
		return err
	}
	sig := Signature{Kind: SignatureKind(tag)}
	switch sig.Kind {
	case SignatureSSHSig:
		var v SSHSigSignature
		if err := decMode.Unmarshal(body, &v); err != nil {
			return err
		}
		sig.SSHSig = &v
	case SignatureWebAuthn:
		var v WebAuthnSignature
		if err := decMode.Unmarshal(body, &v); err != nil {
			return err
		}
		sig.WebAuthn = &v
	default:
		return fmt.Errorf("protocol: unknown signature tag %q", tag)
	}
	*s = sig
	return nil
}

// Authorization is one CBOR(Authorization): the signed payload bytes and their signatures.
type Authorization struct {
	_          struct{} `cbor:",toarray"`
	Payload    []byte
	Signatures []Signature
}

// PendingEntry is one entry of the crh-priv pending.list response.
type PendingEntry struct {
	_            struct{} `cbor:",toarray"`
	TaskID       string
	Attempt      Uint
	Spec         TaskSpec
	Note         string
	ReceivedAtMS Int
}

// LocalVerdict is the crh-priv local.approve / local.deny request body.
type LocalVerdict struct {
	_       struct{} `cbor:",toarray"`
	TaskID  string
	Attempt Uint
	Message string
}

// DecodeAuthorizationPayload strictly decodes payload bytes and enforces the structural
// rules of doc/protocol.md#授权对象 that are not visible in the schema.
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
func SpecSHA256(spec *TaskSpec) ([32]byte, error) {
	var zero [32]byte
	if spec == nil {
		return zero, errors.New("protocol: nil task spec")
	}
	encoded, err := Marshal(spec)
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
