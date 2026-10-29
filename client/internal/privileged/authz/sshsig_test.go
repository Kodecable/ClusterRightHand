package authz

import (
	"encoding/hex"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"

	"golang.org/x/crypto/ssh"
)

type sshsigVector struct {
	ID           string  `json:"id"`
	Description  string  `json:"description"`
	PublicKey    string  `json:"publicKey"`
	PayloadHex   string  `json:"payloadHex"`
	BlobHex      string  `json:"blobHex"`
	Valid        bool    `json:"valid"`
	SSHKeygen    *string `json:"sshKeygen"`
	UserPresent  *bool   `json:"userPresent"`
	UserVerified *bool   `json:"userVerified"`
}

type webauthnTrustVector struct {
	CredentialIDHex string   `json:"credentialIdHex"`
	COSEKeyHex      string   `json:"coseKeyHex"`
	RPID            string   `json:"rpId"`
	Origins         []string `json:"origins"`
	RequireUV       bool     `json:"requireUv"`
}

type webauthnSignatureVector struct {
	CredentialIDHex      string `json:"credentialIdHex"`
	AuthenticatorDataHex string `json:"authenticatorDataHex"`
	ClientDataJSON       string `json:"clientDataJson"`
	SignatureHex         string `json:"signatureHex"`
}

type webauthnVector struct {
	ID          string                  `json:"id"`
	Description string                  `json:"description"`
	Trust       webauthnTrustVector     `json:"trust"`
	PayloadHex  string                  `json:"payloadHex"`
	Signature   webauthnSignatureVector `json:"signature"`
	Valid       bool                    `json:"valid"`
}

type m4CryptoFixture struct {
	SSHSIG   []sshsigVector   `json:"sshsig"`
	WebAuthn []webauthnVector `json:"webauthn"`
}

func readM4CryptoFixture(t *testing.T) *m4CryptoFixture {
	t.Helper()
	path := filepath.Join("..", "..", "..", "..", "test", "interop", "m4_vectors.json")
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read %s: %v", path, err)
	}
	var fixture m4CryptoFixture
	if err := json.Unmarshal(data, &fixture); err != nil {
		t.Fatalf("parse %s: %v", path, err)
	}
	return &fixture
}

func decodeHex(t *testing.T, value string) []byte {
	t.Helper()
	raw, err := hex.DecodeString(value)
	if err != nil {
		t.Fatalf("bad hex %q: %v", value, err)
	}
	return raw
}

func expectedSSHKey(t *testing.T, authorized string) ssh.PublicKey {
	t.Helper()
	key, _, _, rest, err := ssh.ParseAuthorizedKey([]byte(authorized))
	if err != nil {
		t.Fatalf("parse fixture public key: %v", err)
	}
	if len(rest) != 0 {
		t.Fatalf("fixture public key has trailing lines: %q", rest)
	}
	return key
}

func TestSSHSIGVectors(t *testing.T) {
	fixture := readM4CryptoFixture(t)
	if len(fixture.SSHSIG) == 0 {
		t.Fatal("fixture has no sshsig vectors")
	}
	for _, vector := range fixture.SSHSIG {
		t.Run(vector.ID, func(t *testing.T) {
			message := decodeHex(t, vector.PayloadHex)
			blob := decodeHex(t, vector.BlobHex)
			result, err := VerifySSHSIG(blob, message)
			if !vector.Valid {
				if err == nil {
					t.Fatalf("accepted: %s", vector.Description)
				}
				return
			}
			if err != nil {
				t.Fatalf("rejected: %s: %v", vector.Description, err)
			}
			expected := expectedSSHKey(t, vector.PublicKey)
			if got, want := ssh.FingerprintSHA256(result.PublicKey), ssh.FingerprintSHA256(expected); got != want {
				t.Fatalf("signer fingerprint = %s, want %s", got, want)
			}
			if vector.UserPresent != nil && result.UserPresent != *vector.UserPresent {
				t.Errorf("user presence = %v, want %v", result.UserPresent, *vector.UserPresent)
			}
			if vector.UserVerified != nil && result.UserVerified != *vector.UserVerified {
				t.Errorf("user verified = %v, want %v", result.UserVerified, *vector.UserVerified)
			}
		})
	}
}

func TestSSHSIGRejectsMalformedBlobs(t *testing.T) {
	fixture := readM4CryptoFixture(t)
	var valid sshsigVector
	for _, vector := range fixture.SSHSIG {
		if vector.Valid && vector.UserVerified == nil {
			valid = vector
			break
		}
	}
	if valid.ID == "" {
		t.Fatal("no valid non-sk sshsig vector")
	}
	blob := decodeHex(t, valid.BlobHex)
	message := decodeHex(t, valid.PayloadHex)
	for _, test := range []struct {
		name string
		blob []byte
	}{
		{"empty", nil},
		{"magic-only", []byte("SSHSIG")},
		{"truncated", blob[:len(blob)/2]},
		{"trailing", append(append([]byte{}, blob...), 0)},
	} {
		t.Run(test.name, func(t *testing.T) {
			if _, err := VerifySSHSIG(test.blob, message); err == nil {
				t.Fatal("malformed blob accepted")
			}
		})
	}
	// A valid signature over different data must not verify.
	if len(message) == 0 {
		t.Fatal("empty payload")
	}
	if _, err := VerifySSHSIG(blob, append(append([]byte{}, message...), 0)); err == nil {
		t.Fatal("signature accepted over a different message")
	}
}
