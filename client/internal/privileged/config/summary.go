package config

import (
	"os"
	"os/user"
	"strconv"

	"golang.org/x/crypto/ssh"

	"github.com/Kodecable/ClusterRightHand/client/internal/privileged/authz"
	"github.com/Kodecable/ClusterRightHand/client/internal/protocol"
)

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
		Guard:        t.guard,
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
// runs as (doc/design/protocol.md "Trust summary").
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
