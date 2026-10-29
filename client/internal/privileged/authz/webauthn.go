package authz

import (
	"bytes"
	"crypto"
	"crypto/ecdsa"
	"crypto/ed25519"
	"crypto/elliptic"
	"crypto/rsa"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"math/big"
	"slices"

	"github.com/fxamacker/cbor/v2"

	"github.com/Kodecable/ClusterRightHand/client/internal/protocol"
)

// WebAuthn authenticator data flag bits.
const (
	webauthnFlagUP byte = 0x01 // user present
	webauthnFlagUV byte = 0x04 // user verified
)

// COSE key labels (RFC 8152) and values used by WebAuthn.
const (
	coseLabelKty = 1
	coseLabelAlg = 3
	coseLabelCrv = -1
	coseLabelX   = -2
	coseLabelY   = -3
	coseLabelN   = -1
	coseLabelE   = -2

	coseKtyOKP = 1
	coseKtyEC2 = 2
	coseKtyRSA = 3

	coseAlgES256 = -7
	coseAlgEdDSA = -8
	coseAlgRS256 = -257

	coseCrvP256    = 1
	coseCrvEd25519 = 6
)

// coseDecMode strictly decodes a locally configured COSE public key.
var coseDecMode = func() cbor.DecMode {
	mode, err := cbor.DecOptions{
		DupMapKey:       cbor.DupMapKeyEnforcedAPF,
		IndefLength:     cbor.IndefLengthForbidden,
		TagsMd:          cbor.TagsForbidden,
		IntDec:          cbor.IntDecConvertNone,
		MaxNestedLevels: 16,
	}.DecMode()
	if err != nil {
		panic("authz: build COSE decoder: " + err.Error())
	}
	return mode
}()

// webAuthnClientData is the subset of clientDataJSON the verifier checks.
type webAuthnClientData struct {
	Type        string `json:"type"`
	Challenge   string `json:"challenge"`
	Origin      string `json:"origin"`
	CrossOrigin bool   `json:"crossOrigin"`
}

// VerifyWebAuthn verifies one WebAuthn assertion over payload
// (doc/privilege.md#签名方式):
//
//   - the assertion's credential id equals the trust key's;
//   - clientDataJSON.type is webauthn.get and its base64url challenge (no padding) is
//     SHA-256("crh-auth-v1\x00" || payload);
//   - origin is in the trust key's origins and crossOrigin is false;
//   - authenticatorData is at least 37 bytes, its rpIdHash is SHA-256(rp_id), user
//     presence is set and user verification is set when required;
//   - the COSE key is EC2/P-256 with ES256, OKP/Ed25519 with EdDSA, or RSA with RS256,
//     and the signature verifies over authenticatorData || SHA-256(clientDataJSON).
func VerifyWebAuthn(payload []byte, signature *protocol.WebAuthnSignature, key *protocol.WebAuthnTrustKey, requireUV bool) error {
	if signature == nil {
		return errors.New("authz: webauthn: nil signature")
	}
	if key == nil {
		return errors.New("authz: webauthn: nil trust key")
	}
	if len(key.CredentialID) == 0 {
		return errors.New("authz: webauthn: trust key has an empty credential id")
	}
	if !bytes.Equal(signature.CredentialID, key.CredentialID) {
		return errors.New("authz: webauthn: credential id does not match the trust key")
	}
	if key.RPID == "" {
		return errors.New("authz: webauthn: trust key has an empty rp_id")
	}

	var clientData webAuthnClientData
	if err := json.Unmarshal(signature.ClientDataJSON, &clientData); err != nil {
		return fmt.Errorf("authz: webauthn: client data: %w", err)
	}
	if clientData.Type != "webauthn.get" {
		return fmt.Errorf("authz: webauthn: client data type is %q, want webauthn.get", clientData.Type)
	}
	challenge, err := base64.RawURLEncoding.Strict().DecodeString(clientData.Challenge)
	if err != nil {
		return fmt.Errorf("authz: webauthn: challenge is not base64url without padding: %w", err)
	}
	expected := webauthnChallenge(payload)
	if len(challenge) != len(expected) || subtle.ConstantTimeCompare(challenge, expected) != 1 {
		return errors.New("authz: webauthn: challenge does not match the authorization payload")
	}
	if !slices.Contains(key.Origins, clientData.Origin) {
		return fmt.Errorf("authz: webauthn: origin %q is not trusted", clientData.Origin)
	}
	if clientData.CrossOrigin {
		return errors.New("authz: webauthn: crossOrigin is not allowed")
	}

	authenticatorData := signature.AuthenticatorData
	if len(authenticatorData) < 37 {
		return fmt.Errorf("authz: webauthn: authenticator data is %d bytes, want at least 37", len(authenticatorData))
	}
	rpIDHash := sha256.Sum256([]byte(key.RPID))
	if !bytes.Equal(authenticatorData[:32], rpIDHash[:]) {
		return errors.New("authz: webauthn: rpIdHash does not match the trust key's rp_id")
	}
	flags := authenticatorData[32]
	if flags&webauthnFlagUP == 0 {
		return errors.New("authz: webauthn: user presence flag is not set")
	}
	if requireUV && flags&webauthnFlagUV == 0 {
		return errors.New("authz: webauthn: user verification is required but not asserted")
	}

	signed := make([]byte, 0, len(authenticatorData)+sha256.Size)
	signed = append(signed, authenticatorData...)
	clientDataHash := sha256.Sum256(signature.ClientDataJSON)
	signed = append(signed, clientDataHash[:]...)

	return verifyCOSE(key.COSEKey, signed, signature.Signature)
}

// webauthnChallenge is SHA-256("crh-auth-v1\x00" || payload).
func webauthnChallenge(payload []byte) []byte {
	hash := sha256.New()
	hash.Write([]byte(protocol.AuthNamespace))
	hash.Write([]byte{0})
	hash.Write(payload)
	return hash.Sum(nil)
}

// verifyCOSE parses a COSE public key and verifies a WebAuthn assertion signature over
// signed. Only the algorithms of doc/protocol.md are accepted; a mismatched kty, alg or
// curve is rejected rather than reinterpreted.
func verifyCOSE(coseKey, signed, signature []byte) error {
	var fields map[int64]cbor.RawMessage
	if err := coseDecMode.Unmarshal(coseKey, &fields); err != nil {
		return fmt.Errorf("authz: webauthn: parse COSE key: %w", err)
	}
	kty, err := coseInt(fields, coseLabelKty)
	if err != nil {
		return err
	}
	alg, err := coseInt(fields, coseLabelAlg)
	if err != nil {
		return err
	}

	switch {
	case kty == coseKtyEC2 && alg == coseAlgES256:
		crv, err := coseInt(fields, coseLabelCrv)
		if err != nil {
			return err
		}
		if crv != coseCrvP256 {
			return fmt.Errorf("authz: webauthn: ES256 key has curve %d, want P-256", crv)
		}
		x, err := coseBytes(fields, coseLabelX)
		if err != nil {
			return err
		}
		y, err := coseBytes(fields, coseLabelY)
		if err != nil {
			return err
		}
		if len(x) != 32 || len(y) != 32 {
			return errors.New("authz: webauthn: P-256 coordinates are not 32 bytes")
		}
		publicKey := &ecdsa.PublicKey{
			Curve: elliptic.P256(),
			X:     new(big.Int).SetBytes(x),
			Y:     new(big.Int).SetBytes(y),
		}
		if !publicKey.Curve.IsOnCurve(publicKey.X, publicKey.Y) {
			return errors.New("authz: webauthn: P-256 point is not on the curve")
		}
		digest := sha256.Sum256(signed)
		if !ecdsa.VerifyASN1(publicKey, digest[:], signature) {
			return errors.New("authz: webauthn: ES256 signature did not verify")
		}
		return nil

	case kty == coseKtyOKP && alg == coseAlgEdDSA:
		crv, err := coseInt(fields, coseLabelCrv)
		if err != nil {
			return err
		}
		if crv != coseCrvEd25519 {
			return fmt.Errorf("authz: webauthn: EdDSA key has curve %d, want Ed25519", crv)
		}
		x, err := coseBytes(fields, coseLabelX)
		if err != nil {
			return err
		}
		if len(x) != ed25519.PublicKeySize {
			return fmt.Errorf("authz: webauthn: Ed25519 public key is %d bytes, want %d", len(x), ed25519.PublicKeySize)
		}
		if !ed25519.Verify(ed25519.PublicKey(x), signed, signature) {
			return errors.New("authz: webauthn: EdDSA signature did not verify")
		}
		return nil

	case kty == coseKtyRSA && alg == coseAlgRS256:
		modulus, err := coseBytes(fields, coseLabelN)
		if err != nil {
			return err
		}
		exponent, err := coseBytes(fields, coseLabelE)
		if err != nil {
			return err
		}
		n := new(big.Int).SetBytes(modulus)
		e := new(big.Int).SetBytes(exponent)
		if n.Sign() <= 0 {
			return errors.New("authz: webauthn: RSA modulus is not positive")
		}
		if !e.IsInt64() || e.Int64() < 3 || e.Int64()%2 == 0 {
			return errors.New("authz: webauthn: RSA exponent is invalid")
		}
		publicKey := &rsa.PublicKey{N: n, E: int(e.Int64())}
		digest := sha256.Sum256(signed)
		if err := rsa.VerifyPKCS1v15(publicKey, crypto.SHA256, digest[:], signature); err != nil {
			return fmt.Errorf("authz: webauthn: RS256 signature did not verify: %w", err)
		}
		return nil

	default:
		return fmt.Errorf("authz: webauthn: unsupported COSE key (kty %d, alg %d)", kty, alg)
	}
}

func coseInt(fields map[int64]cbor.RawMessage, label int64) (int64, error) {
	raw, ok := fields[label]
	if !ok {
		return 0, fmt.Errorf("authz: webauthn: COSE key has no label %d", label)
	}
	var value int64
	if err := coseDecMode.Unmarshal(raw, &value); err != nil {
		return 0, fmt.Errorf("authz: webauthn: COSE label %d: %w", label, err)
	}
	return value, nil
}

func coseBytes(fields map[int64]cbor.RawMessage, label int64) ([]byte, error) {
	raw, ok := fields[label]
	if !ok {
		return nil, fmt.Errorf("authz: webauthn: COSE key has no label %d", label)
	}
	var value []byte
	if err := coseDecMode.Unmarshal(raw, &value); err != nil {
		return nil, fmt.Errorf("authz: webauthn: COSE label %d: %w", label, err)
	}
	return value, nil
}
