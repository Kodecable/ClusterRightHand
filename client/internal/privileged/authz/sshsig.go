package authz

import (
	"bytes"
	"crypto/sha256"
	"crypto/sha512"
	"encoding/binary"
	"errors"
	"fmt"

	"golang.org/x/crypto/ssh"

	"github.com/Kodecable/ClusterRightHand/client/internal/protocol"
)

// skFlags are the OpenSSH FIDO signature flags (PROTOCOL.u2f).
const (
	// SSHSIGUserPresent is the user-present (touch) flag.
	SSHSIGUserPresent byte = 0x01
	// SSHSIGUserVerified is the user-verified (PIN/biometric) flag.
	SSHSIGUserVerified byte = 0x04
)

// SSHSIGResult is the outcome of a successful SSHSIG verification.
type SSHSIGResult struct {
	// PublicKey is the key embedded in the signature, the signer's key. The caller matches
	// it against trust entries by authorized_keys line or SHA256 fingerprint.
	PublicKey ssh.PublicKey
	// Flags is the FIDO flags byte; zero for non-sk keys.
	Flags byte
	// UserPresent and UserVerified are Flags & SSHSIGUserPresent / SSHSIGUserVerified.
	UserPresent  bool
	UserVerified bool
}

// VerifySSHSIG verifies an OpenSSH SSHSIG blob over message and returns the signer's
// public key. It implements doc/protocol.md#授权对象 literally:
//
//   - magic "SSHSIG", version 1, no trailing bytes;
//   - namespace crh-auth-v1, empty reserved field;
//   - hash algorithm sha512 (ssh-keygen's default) or sha256;
//   - the SSHSIG inner signature must verify over the rebuilt signed data.
//
// The supported key types are the ones the specification lists: ssh-ed25519,
// ecdsa-sha2-nistp256 and their sk-* variants. An sk-* signature must assert user
// presence; OpenSSH's ssh-keygen -Y verify does not enforce that, but crha does.
func VerifySSHSIG(blob, message []byte) (*SSHSIGResult, error) {
	if len(blob) < 6 || !bytes.Equal(blob[:6], []byte("SSHSIG")) {
		return nil, errors.New("authz: sshsig: bad magic")
	}
	reader := &sshReader{data: blob, off: 6}

	version, err := reader.uint32()
	if err != nil {
		return nil, fmt.Errorf("authz: sshsig: version: %w", err)
	}
	if version != 1 {
		return nil, fmt.Errorf("authz: sshsig: unsupported version %d", version)
	}
	keyBlob, err := reader.string()
	if err != nil {
		return nil, fmt.Errorf("authz: sshsig: public key: %w", err)
	}
	namespace, err := reader.string()
	if err != nil {
		return nil, fmt.Errorf("authz: sshsig: namespace: %w", err)
	}
	reserved, err := reader.string()
	if err != nil {
		return nil, fmt.Errorf("authz: sshsig: reserved: %w", err)
	}
	hashAlgorithm, err := reader.string()
	if err != nil {
		return nil, fmt.Errorf("authz: sshsig: hash algorithm: %w", err)
	}
	signature, err := reader.string()
	if err != nil {
		return nil, fmt.Errorf("authz: sshsig: signature: %w", err)
	}
	if len(reader.rest()) != 0 {
		return nil, fmt.Errorf("authz: sshsig: %d trailing bytes", len(reader.rest()))
	}

	if string(namespace) != protocol.AuthNamespace {
		return nil, fmt.Errorf("authz: sshsig: namespace is %q, want %q", string(namespace), protocol.AuthNamespace)
	}
	if len(reserved) != 0 {
		return nil, errors.New("authz: sshsig: reserved field is not empty")
	}
	hash, err := sshsigHash(string(hashAlgorithm), message)
	if err != nil {
		return nil, err
	}

	key, err := ssh.ParsePublicKey(keyBlob)
	if err != nil {
		return nil, fmt.Errorf("authz: sshsig: parse public key: %w", err)
	}
	if !supportedSSHSIGKey(key.Type()) {
		return nil, fmt.Errorf("authz: sshsig: unsupported key type %q", key.Type())
	}

	signed := make([]byte, 0, 6+len(namespace)+len(reserved)+len(hashAlgorithm)+len(hash)+32)
	signed = append(signed, "SSHSIG"...)
	signed = appendSSHString(signed, namespace)
	signed = appendSSHString(signed, reserved)
	signed = appendSSHString(signed, hashAlgorithm)
	signed = appendSSHString(signed, hash)

	result := &SSHSIGResult{PublicKey: key}
	sk := isSKKey(key.Type())
	inner := &sshReader{data: signature}
	format, err := inner.string()
	if err != nil {
		return nil, fmt.Errorf("authz: sshsig: signature format: %w", err)
	}
	body, err := inner.string()
	if err != nil {
		return nil, fmt.Errorf("authz: sshsig: signature body: %w", err)
	}
	rest := inner.rest()
	if sk {
		// sk-* signatures append the FIDO flags and counter after the inner signature.
		if len(rest) != 5 {
			return nil, fmt.Errorf("authz: sshsig: sk signature has %d trailing bytes, want 5", len(rest))
		}
		result.Flags = rest[0]
		result.UserPresent = result.Flags&SSHSIGUserPresent != 0
		result.UserVerified = result.Flags&SSHSIGUserVerified != 0
		if !result.UserPresent {
			return nil, errors.New("authz: sshsig: sk signature does not assert user presence")
		}
	} else if len(rest) != 0 {
		return nil, fmt.Errorf("authz: sshsig: %d trailing bytes after the signature", len(rest))
	}
	if got := string(format); got != key.Type() {
		return nil, fmt.Errorf("authz: sshsig: signature type %q does not match key type %q", got, key.Type())
	}

	innerSignature := &ssh.Signature{Format: string(format), Blob: body}
	if sk {
		innerSignature.Rest = rest
	}
	if err := key.Verify(signed, innerSignature); err != nil {
		return nil, fmt.Errorf("authz: sshsig: %w", err)
	}
	return result, nil
}

// sshsigHash hashes the message with the SSHSIG-declared algorithm.
func sshsigHash(algorithm string, message []byte) ([]byte, error) {
	switch algorithm {
	case "sha512":
		sum := sha512.Sum512(message)
		return sum[:], nil
	case "sha256":
		sum := sha256.Sum256(message)
		return sum[:], nil
	default:
		return nil, fmt.Errorf("authz: sshsig: unsupported hash algorithm %q", algorithm)
	}
}

func supportedSSHSIGKey(keyType string) bool {
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

// appendSSHString appends one SSH string (uint32 length prefix and bytes).
func appendSSHString(dst, value []byte) []byte {
	dst = binary.BigEndian.AppendUint32(dst, uint32(len(value)))
	return append(dst, value...)
}

// sshReader reads SSH wire strings and rejects truncation.
type sshReader struct {
	data []byte
	off  int
}

func (r *sshReader) rest() []byte { return r.data[r.off:] }

func (r *sshReader) uint32() (uint32, error) {
	if len(r.data)-r.off < 4 {
		return 0, errors.New("truncated uint32")
	}
	value := binary.BigEndian.Uint32(r.data[r.off : r.off+4])
	r.off += 4
	return value, nil
}

func (r *sshReader) string() ([]byte, error) {
	length, err := r.uint32()
	if err != nil {
		return nil, err
	}
	if uint64(length) > uint64(len(r.data)-r.off) {
		return nil, fmt.Errorf("string of %d bytes, %d remain", length, len(r.data)-r.off)
	}
	value := r.data[r.off : r.off+int(length)]
	r.off += int(length)
	return value, nil
}
