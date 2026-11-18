// Package sshkey identifies the SSH public key types the privileged mode accepts.
package sshkey

import "golang.org/x/crypto/ssh"

// Supported reports whether keyType is one of the signing key types crha accepts: Ed25519, ECDSA
// P-256 and their FIDO sk-* variants.
func Supported(keyType string) bool {
	switch keyType {
	case ssh.KeyAlgoED25519, ssh.KeyAlgoECDSA256, ssh.KeyAlgoSKED25519, ssh.KeyAlgoSKECDSA256:
		return true
	default:
		return false
	}
}

// IsSK reports whether keyType is a FIDO sk-* key, whose signatures carry user-presence flags.
func IsSK(keyType string) bool {
	return keyType == ssh.KeyAlgoSKED25519 || keyType == ssh.KeyAlgoSKECDSA256
}
