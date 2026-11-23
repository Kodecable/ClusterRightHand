package protocol

import (
	"crypto/sha256"
	"errors"
	"fmt"
)

// Privilege wire types: the authorization object, TrustSummary with the local approval window,
// and the window commands (doc/design/protocol.md "Privilege messages"). The crh-priv handshake
// types live with the crh-priv framing.
//
// Every type mirrors the corresponding codec in packages/protocol/src/privileged.ts:
// fixed-length tuples in declaration order, [tag, body] unions, text enums, and CBOR null
// for nullable fields. Strict decoding (phase 1) and re-encoding (phase 2) are provided by
// Marshal and Unmarshal in cbor.go.

const (
	// AuthNamespace is the SSHSIG namespace and the WebAuthn challenge prefix.
	AuthNamespace = "crh-auth-v1"
	// CosignNamespace is the SSHSIG namespace of a cosign ticket. It differs from AuthNamespace,
	// so a ticket signature never passes as an authorization signature, nor the reverse.
	CosignNamespace = "crh-cosign-v1"
	// CosignPayloadVersion is the only supported CosignPayload.v value.
	CosignPayloadVersion = 1
	// RegisterNamespace is the SSHSIG namespace of a signing-credential registration challenge;
	// it is never accepted as an authorization.
	RegisterNamespace = "crh-register-v1"
	// AuthPayloadVersion is the only supported AuthorizationPayload.v value.
	AuthPayloadVersion = 1
)

// Method is the method of a task, guard rule or authorization command. It is an open name
// (doc/design/protocol.md "Encoding rules"): a method this version does not know decodes, and
// an authorization naming one covers nothing (doc/design/privilege.md "Methods and targets").
type Method string

const (
	MethodExec      Method = "exec"
	MethodFileRead  Method = "file.read"
	MethodFileWrite Method = "file.write"
	MethodUpgrade   Method = "upgrade"
	// MethodPtyCreate authorizes opening a privileged terminal (doc/design/pty.md "Privilege").
	MethodPtyCreate Method = "pty.create"
)

// methods is the method open name.
var methods = newOpenName("method", MethodExec, MethodFileRead, MethodFileWrite, MethodUpgrade, MethodPtyCreate)

// Known reports whether this version understands the method.
func (m Method) Known() bool { return methods.isKnown(m) }

// MarshalCBOR encodes the method, rejecting a malformed name.
func (m Method) MarshalCBOR() ([]byte, error) { return methods.marshal(m) }

// UnmarshalCBOR decodes the method, accepting any well-formed name.
func (m *Method) UnmarshalCBOR(data []byte) error { return methods.unmarshal(data, m) }

// GuardMatch selects how a guard rule matches its target.
type GuardMatch string

const (
	GuardMatchAny    GuardMatch = "any"
	GuardMatchPrefix GuardMatch = "prefix"
	GuardMatchRegex  GuardMatch = "regex"
)

// guardMatches is the guard match open name.
var guardMatches = newOpenName("guard match", GuardMatchAny, GuardMatchPrefix, GuardMatchRegex)

// Known reports whether this version understands the match kind.
func (m GuardMatch) Known() bool { return guardMatches.isKnown(m) }

// MarshalCBOR encodes the match kind, rejecting a malformed name.
func (m GuardMatch) MarshalCBOR() ([]byte, error) { return guardMatches.marshal(m) }

// UnmarshalCBOR decodes the match kind, accepting any well-formed name.
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

// trustRoles is the trust role open name.
var trustRoles = newOpenName("trust role", TrustRoleCRHS, TrustRoleUser, TrustRoleLocal)

// Known reports whether this version understands the role.
func (r TrustRole) Known() bool { return trustRoles.isKnown(r) }

// MarshalCBOR encodes the role, rejecting a malformed name.
func (r TrustRole) MarshalCBOR() ([]byte, error) { return trustRoles.marshal(r) }

// UnmarshalCBOR decodes the role, accepting any well-formed name.
func (r *TrustRole) UnmarshalCBOR(data []byte) error { return trustRoles.unmarshal(data, r) }

// TrustKind is one capability of a trust entry.
type TrustKind string

const (
	TrustKindExecute       TrustKind = "execute"
	TrustKindCosign        TrustKind = "cosign"
	TrustKindRequireCosign TrustKind = "require-cosign"
)

// trustKinds is the trust capability open name.
var trustKinds = newOpenName("trust kind", TrustKindExecute, TrustKindCosign, TrustKindRequireCosign)

// Known reports whether this version understands the capability.
func (k TrustKind) Known() bool { return trustKinds.isKnown(k) }

// MarshalCBOR encodes the kind, rejecting a malformed name.
func (k TrustKind) MarshalCBOR() ([]byte, error) { return trustKinds.marshal(k) }

// UnmarshalCBOR decodes the kind, accepting any well-formed name.
func (k *TrustKind) UnmarshalCBOR(data []byte) error { return trustKinds.unmarshal(data, k) }

// TrustEntry is one item of TrustSummary.trust.
type TrustEntry struct {
	_           struct{} `cbor:",toarray"`
	Name        string
	Source      TrustSource
	Role        TrustRole
	Key         TrustKey
	Kinds       []TrustKind
	RequireSpec bool
	RequireTask bool
	RequireUV   bool
	MaxTTLMS    *Uint
	Allow       []GuardRule
	Deny        []GuardRule
	EnvAllow    []string
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
	// LocalWindow is the node's local approval window (doc/design/privilege.md "Local approval window").
	LocalWindow WindowState
}

// WindowStateKind is a WindowState union tag.
type WindowStateKind string

const (
	WindowStateClosed WindowStateKind = "closed"
	WindowStateOpen   WindowStateKind = "open"
)

// OpenWindow is the "open" WindowState body: when the window was opened, by which local uid, and
// when it closes.
type OpenWindow struct {
	_           struct{} `cbor:",toarray"`
	OpenedAtMS  Int
	OpenedByUID Uint
	UntilMS     Int
}

// WindowState is the local approval window of a node: closed, or open until a time.
type WindowState struct {
	Kind   WindowStateKind
	Opened *OpenWindow
}

// windowStateUnion is the WindowState union: a closed window has an empty body.
var windowStateUnion = newUnion("window state",
	unionEmpty[WindowState]("closed"),
	withMissing(unionPtr[WindowState]("open", func(w *WindowState) **OpenWindow { return &w.Opened }),
		"protocol: open window has no body"),
)

// MarshalCBOR encodes a WindowState as [tag, body].
func (w WindowState) MarshalCBOR() ([]byte, error) {
	return windowStateUnion.marshal(w, string(w.Kind))
}

// UnmarshalCBOR decodes [tag, body] into the matching WindowState branch.
func (w *WindowState) UnmarshalCBOR(data []byte) error {
	tag, err := windowStateUnion.unmarshal(data, w)
	if err != nil {
		return err
	}
	w.Kind = WindowStateKind(tag)
	return nil
}

// ClosedWindow returns the state of a node with no open local approval window.
func ClosedWindow() WindowState { return WindowState{Kind: WindowStateClosed} }

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

// WindowOpen is the crh-priv window.open request body: how long the window should stay open.
type WindowOpen struct {
	_          struct{} `cbor:",toarray"`
	DurationMS Uint
}

// AuthCommandKind is an AuthCommand union tag.
type AuthCommandKind string

const (
	// AuthCommandSpec binds the complete task spec by its hash. The method follows from the spec
	// (doc/design/privilege.md "Methods and targets"), so the command carries only the hash.
	AuthCommandSpec AuthCommandKind = "spec"
	// AuthCommandPrefix binds a method and a target prefix.
	AuthCommandPrefix AuthCommandKind = "prefix"
)

// AuthPrefix is the "prefix" AuthCommand body.
type AuthPrefix struct {
	_      struct{} `cbor:",toarray"`
	Method Method
	Target string
}

// AuthCommand is the optional command restriction of an authorization payload: the hash of the
// complete task spec, or a method and target prefix. Absent means any command.
type AuthCommand struct {
	Kind AuthCommandKind

	Spec   *Hash
	Prefix *AuthPrefix
}

// authCommandUnion is the AuthCommand union: how an authorization constrains the command.
var authCommandUnion = newUnion("auth command",
	unionPtr[AuthCommand]("spec", func(c *AuthCommand) **Hash { return &c.Spec }),
	unionPtr[AuthCommand]("prefix", func(c *AuthCommand) **AuthPrefix { return &c.Prefix }),
)

// MarshalCBOR encodes an AuthCommand as [tag, body].
func (c AuthCommand) MarshalCBOR() ([]byte, error) {
	return authCommandUnion.marshal(c, string(c.Kind))
}

// UnmarshalCBOR decodes [tag, body] into the matching AuthCommand branch.
func (c *AuthCommand) UnmarshalCBOR(data []byte) error {
	tag, err := authCommandUnion.unmarshal(data, c)
	if err != nil {
		return err
	}
	c.Kind = AuthCommandKind(tag)
	return nil
}

// SpecCommand returns a command restriction that binds the complete task spec whose hash
// (SpecSHA256) is hash.
func SpecCommand(hash [32]byte) *AuthCommand {
	value := Hash(hash)
	return &AuthCommand{Kind: AuthCommandSpec, Spec: &value}
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

// CosignUse is one use a cosign ticket confirms: a task at one attempt on one node.
type CosignUse struct {
	_       struct{} `cbor:",toarray"`
	Node    string
	TaskID  string
	Attempt Uint
}

// CosignPayload is CBOR(CosignPayload), the bytes crhs signs to confirm uses of one
// authorization. AuthorizationID is SHA-256 of that authorization's payload bytes.
type CosignPayload struct {
	_               struct{} `cbor:",toarray"`
	V               Uint
	AuthorizationID Hash
	Uses            []CosignUse
	IssuedAtMS      Int
	DeadlineMS      Int
}

// CosignTicket is one CBOR(CosignTicket): the signed payload bytes and crhs's signatures in
// CosignNamespace.
type CosignTicket struct {
	_          struct{} `cbor:",toarray"`
	Payload    []byte
	Signatures []Signature
}

// DecodeCosignPayload strictly decodes cosign payload bytes and enforces the structural rules
// of doc/design/protocol.md "Cosign ticket".
func DecodeCosignPayload(payloadBytes []byte) (*CosignPayload, error) {
	var payload CosignPayload
	if err := Unmarshal(payloadBytes, &payload); err != nil {
		return nil, err
	}
	fail := func(reason string) error {
		return protocolErrorf("cosign payload: %s", reason)
	}
	if payload.V != CosignPayloadVersion {
		return nil, fail(fmt.Sprintf("unsupported version %d", payload.V))
	}
	if len(payload.Uses) == 0 {
		return nil, fail("uses is empty")
	}
	seen := make(map[string]struct{}, len(payload.Uses))
	for _, use := range payload.Uses {
		if use.Node == "*" {
			return nil, fail(`a use names a node id, not "*"`)
		}
		if use.Attempt < 1 {
			return nil, fail("attempt must be at least 1")
		}
		if _, dup := seen[use.TaskID]; dup {
			return nil, fail("duplicate task ids")
		}
		seen[use.TaskID] = struct{}{}
	}
	if payload.DeadlineMS < payload.IssuedAtMS {
		return nil, fail("deadline is before the issue time")
	}
	return &payload, nil
}

// AuthorizationID is SHA-256 of the raw payload bytes.
func AuthorizationID(payload []byte) [32]byte {
	return sha256.Sum256(payload)
}

// SpecSHA256 is SHA-256 of the canonical CBOR encoding of spec. It is what a `spec` command
// limit binds, and the signer checks it in crhu before signing.
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
	if spec.NodeUpgrade != nil {
		// Like a push, an upgrade's transfer id is routing: every member of a group hashes alike.
		upgrade := *spec.NodeUpgrade
		upgrade.Endpoint.TransferID = ""
		canonical.NodeUpgrade = &upgrade
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
