package config

import (
	"encoding/base64"
	"errors"
	"fmt"
	"net/url"
	"strings"
	"time"

	"golang.org/x/crypto/ssh"

	"github.com/Kodecable/ClusterRightHand/client/internal/privileged/authz"
	"github.com/Kodecable/ClusterRightHand/client/internal/protocol"
)

// buildTrust validates one [[trust]] entry against the role/format/kinds table of
// doc/design/privilege.md "Trust configuration" and the field table below it.
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
		// crhs authorizations always carry task_ids (doc/design/privilege.md "Authorizations"); the field may
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
	t.guard = authz.CompileGuard(allow, deny)

	env, err := buildEnvAllow(raw.EnvAllow)
	if err != nil {
		return nil, err
	}
	t.EnvAllow = env

	if err := buildKey(raw, t); err != nil {
		return nil, err
	}
	// require_uv is a user-only requirement, and a plain SSH key cannot assert user
	// verification (doc/design/privilege.md "Trust configuration", require_uv).
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
