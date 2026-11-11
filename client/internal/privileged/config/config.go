// Package config loads and validates privileged.toml, the trust configuration of crha's
// privileged mode (doc/design/privilege.md "Trust configuration"). It turns the file into the trust entries the
// authorization decision uses and into the TrustSummary the node reports to crhs.
package config

import (
	"bytes"
	"errors"
	"fmt"
	"io"
	"os"
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

	// guard is Allow and Deny compiled once when the entry is built.
	guard *authz.Guard

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
// (doc/design/privilege.md "Trust configuration").
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
	// Groups is not a setting any more. It stays declared so a config written for the old
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
// be a canonical lowercase UUID and may appear only once (doc/design/privilege.md "Trust configuration").
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

// SSHEntry returns the sshsig trust entry whose key is exactly key, or nil. Matching is by
// the public key bytes, as doc/design/privilege.md requires.
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
