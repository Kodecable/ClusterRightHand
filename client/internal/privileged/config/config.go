// Package config loads and validates privileged.toml, the trust configuration of crha's
// privileged mode (doc/privilege.md 信任配置). It turns the file into the trust entries the
// authorization decision uses and into the TrustSummary the node reports to crhs.
package config

import (
	"bytes"
	"encoding/base64"
	"errors"
	"fmt"
	"io"
	"net/url"
	"os"
	"os/user"
	"strconv"
	"strings"
	"syscall"
	"time"

	"github.com/pelletier/go-toml/v2"
	"golang.org/x/crypto/ssh"

	"github.com/Kodecable/ClusterRightHand/client/internal/privileged/authz"
	"github.com/Kodecable/ClusterRightHand/client/internal/protocol"
)

const (
	// DefaultSocketGroup is the group that may connect to the socket.
	DefaultSocketGroup = "crha"
	// DefaultClockSkew is the tolerance applied to authorization times.
	DefaultClockSkew = 60 * time.Second
)

// Signature formats of a trust entry.
const (
	FormatSSHSig   = "sshsig"
	FormatWebAuthn = "webauthn"
)

// Config is the validated privileged-mode configuration.
type Config struct {
	NodeID          string
	Aliases         []string
	UnprivilegedUID uint32
	ClockSkew       time.Duration
	Socket          string
	SocketGroup     string
	StateDir        string
	LogPath         string
	Trust           []Trust
}

// Trust is one validated [[trust]] entry.
type Trust struct {
	Name         string
	Role         protocol.TrustRole
	Format       string
	Kinds        []protocol.TrustKind
	RequireExact bool
	RequireTask  bool
	RequireUV    bool
	// MaxTTL is max_ttl; nil means no limit.
	MaxTTL   *time.Duration
	Allow    []protocol.GuardRule
	Deny     []protocol.GuardRule
	EnvAllow []string

	// SSHKey is the parsed key of an sshsig entry and SSHKeyText its authorized_keys form,
	// which TrustSummary reports to crhs.
	SSHKey     ssh.PublicKey
	SSHKeyText string
	// WebAuthn is the credential of a webauthn entry.
	WebAuthn *protocol.WebAuthnTrustKey
	// UIDs are the uids allowed to approve locally; local entries only.
	UIDs []uint32
}

// Load reads, checks and parses the configuration file at path. The file must be owned by
// the user running the privileged mode and must not be writable by anyone else
// (doc/privilege.md 特权模式: 属主为特权模式的运行用户，其他用户不可写).
func Load(path string) (*Config, error) {
	f, err := os.Open(path)
	if err != nil {
		return nil, fmt.Errorf("privileged config: read %s: %w", path, err)
	}
	defer f.Close()
	fi, err := f.Stat()
	if err != nil {
		return nil, fmt.Errorf("privileged config: stat %s: %w", path, err)
	}
	if err := checkOwner(fi, uint32(os.Geteuid())); err != nil {
		return nil, fmt.Errorf("privileged config: %s: %w", path, err)
	}
	data, err := io.ReadAll(f)
	if err != nil {
		return nil, fmt.Errorf("privileged config: read %s: %w", path, err)
	}
	cfg, err := Parse(data)
	if err != nil {
		return nil, fmt.Errorf("privileged config: %s: %w", path, err)
	}
	return cfg, nil
}

// checkOwner refuses a configuration file the privileged mode does not own or that any
// other user could modify. In-host threats are outside the M4 threat model, but a
// group-writable trust file would let any member of the group grant themselves privileges.
func checkOwner(fi os.FileInfo, euid uint32) error {
	st, ok := fi.Sys().(*syscall.Stat_t)
	if !ok {
		return errors.New("cannot determine the file owner")
	}
	if st.Uid != euid {
		return fmt.Errorf("owned by uid %d, but the privileged mode runs as uid %d", st.Uid, euid)
	}
	if mode := fi.Mode().Perm(); mode&0o022 != 0 {
		return fmt.Errorf("mode %04o is group- or world-writable", mode)
	}
	return nil
}

// rawConfig mirrors privileged.toml. Pointers distinguish "not set" from a zero value where
// the default is part of the semantics.
type rawConfig struct {
	NodeID  string   `toml:"node_id"`
	Aliases []string `toml:"aliases"`
	// Groups is not a setting any more (D110). It stays declared so a config written for the old
	// version fails with the migration hint below instead of a generic "unknown key".
	Groups          *[]string  `toml:"groups"`
	UnprivilegedUID *uint64    `toml:"unprivileged_uid"`
	ClockSkew       string     `toml:"clock_skew"`
	Socket          string     `toml:"socket"`
	SocketGroup     string     `toml:"socket_group"`
	StateDir        string     `toml:"state_dir"`
	Log             string     `toml:"log"`
	Trust           []rawTrust `toml:"trust"`
}

type rawTrust struct {
	Name         string    `toml:"name"`
	Role         string    `toml:"role"`
	Format       string    `toml:"format"`
	Key          string    `toml:"key"`
	CredentialID string    `toml:"credential_id"`
	RPID         string    `toml:"rp_id"`
	Origins      []string  `toml:"origins"`
	UIDs         []uint32  `toml:"uids"`
	Kinds        []string  `toml:"kinds"`
	RequireExact bool      `toml:"require_exact"`
	RequireTask  *bool     `toml:"require_task"`
	RequireUV    bool      `toml:"require_uv"`
	MaxTTL       string    `toml:"max_ttl"`
	Allow        []rawRule `toml:"allow"`
	Deny         []rawRule `toml:"deny"`
	EnvAllow     []string  `toml:"env_allow"`
}

type rawRule struct {
	Method string `toml:"method"`
	Prefix string `toml:"prefix"`
	Regex  string `toml:"regex"`
}

// Parse parses and validates privileged.toml data. Load additionally checks ownership and
// permissions, which Parse cannot see.
func Parse(data []byte) (*Config, error) {
	var raw rawConfig
	dec := toml.NewDecoder(bytes.NewReader(data))
	dec.DisallowUnknownFields()
	if err := dec.Decode(&raw); err != nil {
		var sm *toml.StrictMissingError
		if errors.As(err, &sm) {
			return nil, fmt.Errorf("unknown key: %s", unknownKeys(sm))
		}
		return nil, fmt.Errorf("parse: %w", err)
	}
	return build(&raw)
}

func unknownKeys(sm *toml.StrictMissingError) string {
	keys := make([]string, 0, len(sm.Errors))
	for _, e := range sm.Errors {
		keys = append(keys, strings.Join(e.Key(), "."))
	}
	return strings.Join(keys, ", ")
}

func build(raw *rawConfig) (*Config, error) {
	c := &Config{
		NodeID:      raw.NodeID,
		ClockSkew:   DefaultClockSkew,
		Socket:      raw.Socket,
		SocketGroup: orDefault(raw.SocketGroup, DefaultSocketGroup),
		StateDir:    raw.StateDir,
		LogPath:     raw.Log,
	}
	if c.NodeID == "" {
		return nil, errors.New("node_id: required")
	}
	if !protocol.IsUUID(c.NodeID) {
		return nil, fmt.Errorf("node_id: %q is not a canonical lowercase UUID", c.NodeID)
	}
	if raw.Groups != nil {
		return nil, errors.New(`groups is no longer supported; use aliases = ["<node group uuid>", ...] (the WebUI shows node group UUIDs)`)
	}
	aliases, err := buildAliases(raw.Aliases)
	if err != nil {
		return nil, err
	}
	c.Aliases = aliases
	if raw.UnprivilegedUID == nil {
		return nil, errors.New("unprivileged_uid: required")
	}
	if *raw.UnprivilegedUID > 1<<32-1 {
		return nil, fmt.Errorf("unprivileged_uid: %d is not a uid", *raw.UnprivilegedUID)
	}
	c.UnprivilegedUID = uint32(*raw.UnprivilegedUID)
	if raw.ClockSkew != "" {
		skew, err := time.ParseDuration(raw.ClockSkew)
		if err != nil {
			return nil, fmt.Errorf("clock_skew: %w", err)
		}
		if skew < 0 {
			return nil, errors.New("clock_skew: must not be negative")
		}
		c.ClockSkew = skew
	}
	for _, field := range []struct{ name, value string }{
		{"socket", c.Socket},
		{"state_dir", c.StateDir},
		{"log", c.LogPath},
	} {
		if field.value == "" {
			return nil, fmt.Errorf("%s: required", field.name)
		}
		if !strings.HasPrefix(field.value, "/") {
			return nil, fmt.Errorf("%s: path %q must be absolute", field.name, field.value)
		}
	}
	if c.SocketGroup == "" {
		return nil, errors.New("socket_group: must not be empty")
	}

	trust := make([]Trust, 0, len(raw.Trust))
	names := make(map[string]struct{}, len(raw.Trust))
	for i := range raw.Trust {
		entry, err := buildTrust(&raw.Trust[i])
		if err != nil {
			return nil, fmt.Errorf("trust[%d]: %w", i, err)
		}
		if _, dup := names[entry.Name]; dup {
			return nil, fmt.Errorf("trust[%d]: duplicate name %q", i, entry.Name)
		}
		names[entry.Name] = struct{}{}
		trust = append(trust, *entry)
	}
	c.Trust = trust
	return c, nil
}

func orDefault(v, def string) string {
	if v == "" {
		return def
	}
	return v
}

// buildAliases validates the node's trust aliases. An alias is an authorization address, so it must
// be a canonical lowercase UUID and may appear only once (doc/privilege.md 信任配置).
func buildAliases(in []string) ([]string, error) {
	out := make([]string, 0, len(in))
	seen := make(map[string]struct{}, len(in))
	for _, alias := range in {
		if !protocol.IsUUID(alias) {
			return nil, fmt.Errorf("aliases: %q is not a UUID", alias)
		}
		if _, dup := seen[alias]; dup {
			return nil, fmt.Errorf("aliases: duplicate %q", alias)
		}
		seen[alias] = struct{}{}
		out = append(out, alias)
	}
	return out, nil
}

// buildTrust validates one [[trust]] entry against the role/format/kinds table of
// doc/privilege.md 信任配置 and the field table below it.
func buildTrust(raw *rawTrust) (*Trust, error) {
	if raw.Name == "" {
		return nil, errors.New("name: required")
	}
	role := protocol.TrustRole(raw.Role)
	switch role {
	case protocol.TrustRoleCRHS, protocol.TrustRoleUser, protocol.TrustRoleLocal:
	default:
		return nil, fmt.Errorf("role: %q is not crhs, user or local", raw.Role)
	}
	t := &Trust{Name: raw.Name, Role: role, Format: raw.Format}

	// format: crhs signs with SSHSIG only, users may use SSHSIG or WebAuthn, and local
	// entries approve through the socket instead of signing.
	switch role {
	case protocol.TrustRoleCRHS:
		if raw.Format != FormatSSHSig {
			return nil, fmt.Errorf("format: a crhs entry signs with %q only, got %q", FormatSSHSig, raw.Format)
		}
	case protocol.TrustRoleUser:
		if raw.Format != FormatSSHSig && raw.Format != FormatWebAuthn {
			return nil, fmt.Errorf("format: a user entry needs %q or %q, got %q", FormatSSHSig, FormatWebAuthn, raw.Format)
		}
	case protocol.TrustRoleLocal:
		if raw.Format != "" {
			return nil, errors.New("format: a local entry approves on the node and has no format")
		}
	}

	kinds, err := buildKinds(raw.Kinds, role)
	if err != nil {
		return nil, err
	}
	t.Kinds = kinds
	t.RequireExact = raw.RequireExact
	t.RequireUV = raw.RequireUV
	switch role {
	case protocol.TrustRoleCRHS:
		// crhs authorizations always carry task_ids (doc/privilege.md 授权); the field may
		// repeat that but must not claim otherwise.
		if raw.RequireTask != nil && !*raw.RequireTask {
			return nil, errors.New("require_task: crhs authorizations always require task_ids")
		}
		t.RequireTask = true
	case protocol.TrustRoleUser:
		t.RequireTask = raw.RequireTask != nil && *raw.RequireTask
	case protocol.TrustRoleLocal:
		if raw.RequireTask != nil {
			return nil, errors.New("require_task: only user entries can require task_ids")
		}
	}

	if raw.MaxTTL != "" {
		ttl, err := time.ParseDuration(raw.MaxTTL)
		if err != nil {
			return nil, fmt.Errorf("max_ttl: %w", err)
		}
		if ttl <= 0 {
			return nil, errors.New("max_ttl: must be positive")
		}
		t.MaxTTL = &ttl
	}

	allow, err := buildRules("allow", raw.Allow)
	if err != nil {
		return nil, err
	}
	deny, err := buildRules("deny", raw.Deny)
	if err != nil {
		return nil, err
	}
	t.Allow, t.Deny = allow, deny

	env, err := buildEnvAllow(raw.EnvAllow)
	if err != nil {
		return nil, err
	}
	t.EnvAllow = env

	if err := buildKey(raw, t); err != nil {
		return nil, err
	}
	// require_uv is a user-only requirement, and a plain SSH key cannot assert user
	// verification (doc/privilege.md 字段, require_uv).
	if raw.RequireUV && role != protocol.TrustRoleUser {
		return nil, errors.New("require_uv: only user entries can require user verification")
	}
	if raw.RequireUV && role == protocol.TrustRoleUser && raw.Format == FormatSSHSig && !isSKKey(t.SSHKey.Type()) {
		return nil, fmt.Errorf("require_uv: %q cannot assert user verification; use an sk-* key", t.SSHKey.Type())
	}
	return t, nil
}

func buildKinds(in []string, role protocol.TrustRole) ([]protocol.TrustKind, error) {
	if len(in) == 0 {
		return nil, errors.New("kinds: required")
	}
	out := make([]protocol.TrustKind, 0, len(in))
	seen := make(map[protocol.TrustKind]struct{}, len(in))
	for _, name := range in {
		kind := protocol.TrustKind(name)
		if _, dup := seen[kind]; dup {
			return nil, fmt.Errorf("kinds: duplicate %q", name)
		}
		seen[kind] = struct{}{}
		switch role {
		case protocol.TrustRoleCRHS:
			if kind != protocol.TrustKindExecute && kind != protocol.TrustKindCosign {
				return nil, fmt.Errorf("kinds: a crhs entry takes execute or cosign, got %q", name)
			}
		case protocol.TrustRoleUser:
			if kind != protocol.TrustKindExecute && kind != protocol.TrustKindRequireCosign {
				return nil, fmt.Errorf("kinds: a user entry takes execute or require-cosign, got %q", name)
			}
		case protocol.TrustRoleLocal:
			if kind != protocol.TrustKindExecute {
				return nil, fmt.Errorf("kinds: a local entry takes execute only, got %q", name)
			}
		}
		out = append(out, kind)
	}
	return out, nil
}

// buildRules validates guard rules. A rule names one method and either a prefix, an RE2
// pattern or neither (any target); authz compiles them and enforces the 1000-byte limit.
func buildRules(kind string, in []rawRule) ([]protocol.GuardRule, error) {
	out := make([]protocol.GuardRule, 0, len(in))
	for i, r := range in {
		if r.Method == "" {
			return nil, fmt.Errorf("%s[%d]: method is required", kind, i)
		}
		if r.Prefix != "" && r.Regex != "" {
			return nil, fmt.Errorf("%s[%d]: prefix and regex are mutually exclusive", kind, i)
		}
		rule := protocol.GuardRule{Method: protocol.Method(r.Method), Match: protocol.GuardMatchAny}
		switch {
		case r.Regex != "":
			rule.Match, rule.Pattern = protocol.GuardMatchRegex, r.Regex
		case r.Prefix != "":
			rule.Match, rule.Pattern = protocol.GuardMatchPrefix, r.Prefix
		}
		out = append(out, rule)
	}
	if err := authz.ValidateRules(out); err != nil {
		return nil, fmt.Errorf("%s: %w", kind, err)
	}
	return out, nil
}

// buildEnvAllow validates the environment names a task may carry. PATH is always the fixed
// privileged PATH, so allowing a task to set it would only be misleading.
func buildEnvAllow(in []string) ([]string, error) {
	out := make([]string, 0, len(in))
	seen := make(map[string]struct{}, len(in))
	for _, name := range in {
		if name == "" || strings.ContainsAny(name, "=\x00") {
			return nil, fmt.Errorf("env_allow: invalid variable name %q", name)
		}
		if name == "PATH" {
			return nil, errors.New("env_allow: PATH is fixed by the privileged mode")
		}
		if _, dup := seen[name]; dup {
			continue
		}
		seen[name] = struct{}{}
		out = append(out, name)
	}
	return out, nil
}

// buildKey parses the signature key (or the local uids) of an entry.
func buildKey(raw *rawTrust, t *Trust) error {
	switch t.Format {
	case FormatSSHSig:
		if raw.CredentialID != "" || raw.RPID != "" || len(raw.Origins) > 0 || len(raw.UIDs) > 0 {
			return errors.New("key: credential_id, rp_id, origins and uids belong to other entry types")
		}
		key, comment, err := parseAuthorizedKey(raw.Key)
		if err != nil {
			return fmt.Errorf("key: %w", err)
		}
		if !supportedSSHKey(key.Type()) {
			return fmt.Errorf("key: unsupported key type %q", key.Type())
		}
		t.SSHKey = key
		t.SSHKeyText = authorizedKeyText(key, comment)

	case FormatWebAuthn:
		if raw.Key == "" || !strings.HasPrefix(raw.Key, "cose:") {
			return errors.New(`key: a webauthn entry needs "cose:" followed by the base64url COSE key`)
		}
		if len(raw.UIDs) > 0 {
			return errors.New("key: uids belong to a local entry")
		}
		cose, err := decodeBase64URL(strings.TrimPrefix(raw.Key, "cose:"))
		if err != nil {
			return fmt.Errorf("key: cose: %w", err)
		}
		if err := authz.ValidateCOSEKey(cose); err != nil {
			return fmt.Errorf("key: %w", err)
		}
		credentialID, err := decodeBase64URL(raw.CredentialID)
		if err != nil {
			return fmt.Errorf("credential_id: %w", err)
		}
		if len(credentialID) == 0 {
			return errors.New("credential_id: required")
		}
		if raw.RPID == "" {
			return errors.New("rp_id: required")
		}
		if len(raw.Origins) == 0 {
			return errors.New("origins: at least one origin is required")
		}
		origins := make([]string, 0, len(raw.Origins))
		for _, origin := range raw.Origins {
			if err := checkOrigin(origin); err != nil {
				return fmt.Errorf("origins: %w", err)
			}
			origins = append(origins, origin)
		}
		t.WebAuthn = &protocol.WebAuthnTrustKey{
			CredentialID: credentialID,
			COSEKey:      cose,
			RPID:         raw.RPID,
			Origins:      origins,
		}

	case "":
		if raw.Key != "" || raw.CredentialID != "" || raw.RPID != "" || len(raw.Origins) > 0 {
			return errors.New("key: a local entry is identified by uids, not by a key")
		}
		if len(raw.UIDs) == 0 {
			return errors.New("uids: required")
		}
		uids := make([]uint32, 0, len(raw.UIDs))
		seen := make(map[uint32]struct{}, len(raw.UIDs))
		for _, uid := range raw.UIDs {
			if _, dup := seen[uid]; dup {
				continue
			}
			seen[uid] = struct{}{}
			uids = append(uids, uid)
		}
		t.UIDs = uids
	}
	return nil
}

// parseAuthorizedKey parses the one authorized_keys line of an sshsig entry. Options
// (cert-authority, command=...) make no sense for a signing identity, so they are refused.
func parseAuthorizedKey(line string) (ssh.PublicKey, string, error) {
	if strings.TrimSpace(line) == "" {
		return nil, "", errors.New("required (an authorized_keys line)")
	}
	key, comment, options, rest, err := ssh.ParseAuthorizedKey([]byte(line))
	if err != nil {
		return nil, "", err
	}
	if len(options) > 0 {
		return nil, "", errors.New("authorized_keys options are not allowed on a signing key")
	}
	if strings.TrimSpace(string(rest)) != "" {
		return nil, "", errors.New("exactly one authorized_keys line is expected")
	}
	return key, comment, nil
}

// authorizedKeyText renders an authorized_keys line, comment included, for TrustSummary.
func authorizedKeyText(key ssh.PublicKey, comment string) string {
	line := strings.TrimSpace(string(ssh.MarshalAuthorizedKey(key)))
	if comment != "" {
		line += " " + comment
	}
	return protocol.CleanText(line)
}

func supportedSSHKey(keyType string) bool {
	switch keyType {
	case ssh.KeyAlgoED25519, ssh.KeyAlgoECDSA256, ssh.KeyAlgoSKED25519, ssh.KeyAlgoSKECDSA256:
		return true
	default:
		return false
	}
}

func isSKKey(keyType string) bool {
	return keyType == ssh.KeyAlgoSKED25519 || keyType == ssh.KeyAlgoSKECDSA256
}

// decodeBase64URL decodes base64url with or without padding.
func decodeBase64URL(s string) ([]byte, error) {
	if s == "" {
		return nil, errors.New("empty")
	}
	if raw, err := base64.RawURLEncoding.Strict().DecodeString(s); err == nil {
		return raw, nil
	}
	raw, err := base64.URLEncoding.Strict().DecodeString(s)
	if err != nil {
		return nil, errors.New("not base64url")
	}
	return raw, nil
}

// checkOrigin validates one WebAuthn origin. A browser sends scheme://host[:port] without a
// path, so anything else would never match.
func checkOrigin(origin string) error {
	u, err := url.Parse(origin)
	if err != nil {
		return fmt.Errorf("%q: %w", origin, err)
	}
	if u.Scheme != "https" && u.Scheme != "http" {
		return fmt.Errorf("%q: must be an http or https origin", origin)
	}
	if u.Host == "" || u.Path != "" || u.RawQuery != "" || u.Fragment != "" || u.User != nil {
		return fmt.Errorf("%q: must be scheme://host[:port]", origin)
	}
	return nil
}

// Entry returns the trust entry in the form the authorization decision uses.
func (t *Trust) Entry() authz.Entry {
	return authz.Entry{
		Name:         t.Name,
		Role:         t.Role,
		Kinds:        t.Kinds,
		RequireExact: t.RequireExact,
		RequireTask:  t.RequireTask,
		RequireUV:    t.RequireUV,
		MaxTTL:       t.MaxTTL,
		Allow:        t.Allow,
		Deny:         t.Deny,
		EnvAllow:     t.EnvAllow,
		UIDs:         t.UIDs,
	}
}

// Entries returns every trust entry for authz.Decide, in file order.
func (c *Config) Entries() []authz.Entry {
	out := make([]authz.Entry, 0, len(c.Trust))
	for i := range c.Trust {
		out = append(out, c.Trust[i].Entry())
	}
	return out
}

// Summary builds the TrustSummary this node reports to crhs. The identities are the
// unprivileged mode's uid (from the configuration) and the uid the privileged mode itself
// runs as (doc/protocol.md TrustSummary).
func (c *Config) Summary() *protocol.TrustSummary {
	trust := make([]protocol.TrustEntry, 0, len(c.Trust))
	for i := range c.Trust {
		trust = append(trust, c.Trust[i].Summary())
	}
	return &protocol.TrustSummary{
		NodeID:      c.NodeID,
		Aliases:     append([]string{}, c.Aliases...),
		ClockSkewMS: protocol.Uint(c.ClockSkew.Milliseconds()),
		Identities: protocol.Identities{
			Unprivileged: runningIdentity(c.UnprivilegedUID),
			Privileged:   runningIdentity(uint32(os.Geteuid())),
		},
		Trust: trust,
	}
}

// Summary builds one TrustEntry.
func (t *Trust) Summary() protocol.TrustEntry {
	var maxTTL *protocol.Uint
	if t.MaxTTL != nil {
		ms := protocol.Uint(t.MaxTTL.Milliseconds())
		maxTTL = &ms
	}
	return protocol.TrustEntry{
		Name:         t.Name,
		Source:       protocol.TrustSourceLocal,
		Role:         t.Role,
		Key:          t.summaryKey(),
		Kinds:        append([]protocol.TrustKind{}, t.Kinds...),
		RequireExact: t.RequireExact,
		RequireTask:  t.RequireTask,
		RequireUV:    t.RequireUV,
		MaxTTLMS:     maxTTL,
		Allow:        append([]protocol.GuardRule{}, t.Allow...),
		Deny:         append([]protocol.GuardRule{}, t.Deny...),
		EnvAllow:     append([]string{}, t.EnvAllow...),
	}
}

func (t *Trust) summaryKey() protocol.TrustKey {
	switch {
	case t.SSHKey != nil:
		return protocol.TrustKey{Kind: protocol.TrustKeySSHSig, SSHSig: &protocol.SSHTrustKey{
			PublicKey:   t.SSHKeyText,
			Fingerprint: ssh.FingerprintSHA256(t.SSHKey),
		}}
	case t.WebAuthn != nil:
		return protocol.TrustKey{Kind: protocol.TrustKeyWebAuthn, WebAuthn: t.WebAuthn}
	default:
		uids := make([]protocol.Uint, 0, len(t.UIDs))
		for _, uid := range t.UIDs {
			uids = append(uids, protocol.Uint(uid))
		}
		return protocol.TrustKey{Kind: protocol.TrustKeyLocal, Local: &protocol.LocalTrustKey{UIDs: uids}}
	}
}

// runningIdentity reports a running identity for TrustSummary. A uid without a passwd
// entry is still reported, with an empty user name and gid 0: the number is what
// authorization checks compare.
func runningIdentity(uid uint32) protocol.Identity {
	identity := protocol.Identity{UID: protocol.Uint(uid)}
	if u, err := user.LookupId(strconv.FormatUint(uint64(uid), 10)); err == nil {
		identity.User = protocol.CleanText(u.Username)
		if gid, err := strconv.ParseUint(u.Gid, 10, 32); err == nil {
			identity.GID = protocol.Uint(gid)
		}
	}
	return identity
}

// SSHEntry returns the sshsig trust entry whose key is exactly key, or nil. Matching is by
// the public key bytes, as doc/privilege.md requires.
func (c *Config) SSHEntry(key ssh.PublicKey) *Trust {
	if key == nil {
		return nil
	}
	want := key.Marshal()
	for i := range c.Trust {
		t := &c.Trust[i]
		if t.SSHKey != nil && bytes.Equal(t.SSHKey.Marshal(), want) {
			return t
		}
	}
	return nil
}

// CredentialEntry returns the webauthn trust entry with this credential id, or nil.
func (c *Config) CredentialEntry(credentialID []byte) *Trust {
	if len(credentialID) == 0 {
		return nil
	}
	for i := range c.Trust {
		t := &c.Trust[i]
		if t.WebAuthn != nil && bytes.Equal(t.WebAuthn.CredentialID, credentialID) {
			return t
		}
	}
	return nil
}

// LocalEntry returns the local trust entry that allows uid to approve, or nil.
func (c *Config) LocalEntry(uid uint32) *Trust {
	for i := range c.Trust {
		t := &c.Trust[i]
		if t.Role != protocol.TrustRoleLocal {
			continue
		}
		for _, allowed := range t.UIDs {
			if allowed == uid {
				return t
			}
		}
	}
	return nil
}

// HasLocalEntry reports whether the configuration has any local trust entry.
func (c *Config) HasLocalEntry() bool {
	for i := range c.Trust {
		if c.Trust[i].Role == protocol.TrustRoleLocal {
			return true
		}
	}
	return false
}
