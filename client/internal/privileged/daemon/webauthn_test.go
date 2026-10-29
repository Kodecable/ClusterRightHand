package daemon

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"os"
	"testing"
	"time"

	"github.com/fxamacker/cbor/v2"

	"github.com/Kodecable/ClusterRightHand/client/internal/privileged/authz"
	"github.com/Kodecable/ClusterRightHand/client/internal/protocol"
)

// webAuthnKey is one test passkey.
type webAuthnKey struct {
	private      *ecdsa.PrivateKey
	credentialID []byte
	cose         []byte
	rpID         string
	origin       string
}

func newWebAuthnKey(t *testing.T) *webAuthnKey {
	t.Helper()
	private, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	cose, err := cbor.Marshal(map[int64]any{
		1:  2,  // kty: EC2
		3:  -7, // alg: ES256
		-1: 1,  // crv: P-256
		-2: private.PublicKey.X.FillBytes(make([]byte, 32)),
		-3: private.PublicKey.Y.FillBytes(make([]byte, 32)),
	})
	if err != nil {
		t.Fatal(err)
	}
	credentialID := make([]byte, 16)
	if _, err := rand.Read(credentialID); err != nil {
		t.Fatal(err)
	}
	return &webAuthnKey{
		private: private, credentialID: credentialID, cose: cose,
		rpID: "crh.example.com", origin: "https://crh.example.com",
	}
}

func (k *webAuthnKey) trustEntry() string {
	return fmt.Sprintf(`
[[trust]]
name          = "alice-passkey"
role          = "user"
format        = "webauthn"
rp_id         = %q
origins       = [%q]
credential_id = %q
key           = "cose:%s"
require_uv    = true
kinds         = ["execute"]
`, k.rpID, k.origin,
		base64.RawURLEncoding.EncodeToString(k.credentialID),
		base64.RawURLEncoding.EncodeToString(k.cose))
}

// webauthnAssertion signs raw with a WebAuthn assertion. uv selects the user-verification
// flag; user presence is always set.
func (k *webAuthnKey) assertion(t *testing.T, raw []byte, uv bool) *protocol.WebAuthnSignature {
	t.Helper()
	challenge := sha256.Sum256(append([]byte(protocol.AuthNamespace+"\x00"), raw...))
	clientData, err := json.Marshal(map[string]any{
		"type":        "webauthn.get",
		"challenge":   base64.RawURLEncoding.EncodeToString(challenge[:]),
		"origin":      k.origin,
		"crossOrigin": false,
	})
	if err != nil {
		t.Fatal(err)
	}
	rpIDHash := sha256.Sum256([]byte(k.rpID))
	authenticatorData := make([]byte, 37)
	copy(authenticatorData, rpIDHash[:])
	authenticatorData[32] = 0x01 // user present
	if uv {
		authenticatorData[32] |= 0x04 // user verified
	}
	clientDataHash := sha256.Sum256(clientData)
	signed := append(append([]byte{}, authenticatorData...), clientDataHash[:]...)
	digest := sha256.Sum256(signed)
	signature, err := ecdsa.SignASN1(rand.Reader, k.private, digest[:])
	if err != nil {
		t.Fatal(err)
	}
	return &protocol.WebAuthnSignature{
		CredentialID:      k.credentialID,
		AuthenticatorData: authenticatorData,
		ClientDataJSON:    clientData,
		Signature:         signature,
	}
}

func (k *webAuthnKey) authorize(t *testing.T, payload *protocol.AuthorizationPayload, uv bool) []byte {
	t.Helper()
	raw := marshalPayload(t, payload)
	authorization := &protocol.Authorization{
		Payload: raw,
		Signatures: []protocol.Signature{{
			Kind:     protocol.SignatureWebAuthn,
			WebAuthn: k.assertion(t, raw, uv),
		}},
	}
	encoded, err := protocol.Marshal(authorization)
	if err != nil {
		t.Fatal(err)
	}
	return encoded
}

func TestWebAuthnPasskey(t *testing.T) {
	keys := newTestKeys(t)
	passkey := newWebAuthnKey(t)
	env := newTestEnv(t, keys, func(p envPaths) string {
		return baseConfig(p, os.Getuid()) + passkey.trustEntry()
	})
	client := dialForward(t, env.paths.Socket)
	ctx := requestContext(t)

	// The UV flag is present and require_uv is satisfied.
	ts := execTask("passkey-1", 1, "/bin/echo", "passkey")
	payload := payloadFor("passkey-1", 1, exactCommand(t, &ts.Spec), nil)
	ts.Authorizations = [][]byte{passkey.authorize(t, payload, true)}
	if err := client.start(ctx, ts); err != nil {
		t.Fatalf("task.start: %v", err)
	}
	if exit := client.waitExit(15 * time.Second); exit.Outcome.Code != 0 {
		t.Fatalf("task.exit = %+v", exit)
	}
	accepted := waitLogRecord(t, env.paths.Log, "task.accepted", "passkey-1", 5*time.Second)
	if accepted["entry"] != "alice-passkey" {
		t.Fatalf("accepted = %v", accepted)
	}

	// The signature itself verifies without UV, but Decide's step 7 requires it.
	ts = execTask("passkey-2", 1, "/bin/echo", "no-uv")
	payload = payloadFor("passkey-2", 1, exactCommand(t, &ts.Spec), nil)
	ts.Authorizations = [][]byte{passkey.authorize(t, payload, false)}
	expectRemoteCode(t, client.start(ctx, ts), "authorization_rejected")

	// The raw verifier reports the flag rather than rejecting on its own.
	raw := marshalPayload(t, payload)
	userVerified, err := authz.VerifyWebAuthn(raw, passkey.assertion(t, raw, false), &protocol.WebAuthnTrustKey{
		CredentialID: passkey.credentialID,
		COSEKey:      passkey.cose,
		RPID:         passkey.rpID,
		Origins:      []string{passkey.origin},
	})
	if err != nil || userVerified {
		t.Fatalf("VerifyWebAuthn without UV = %v, %v; want valid and not verified", userVerified, err)
	}
}
