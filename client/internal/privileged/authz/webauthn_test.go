package authz

import (
	"testing"

	"github.com/fxamacker/cbor/v2"

	"github.com/Kodecable/ClusterRightHand/client/internal/protocol"
)

func webauthnTrust(t *testing.T, vector *webauthnVector) *protocol.WebAuthnTrustKey {
	t.Helper()
	return &protocol.WebAuthnTrustKey{
		CredentialID: decodeHex(t, vector.Trust.CredentialIDHex),
		COSEKey:      decodeHex(t, vector.Trust.COSEKeyHex),
		RPID:         vector.Trust.RPID,
		Origins:      vector.Trust.Origins,
	}
}

func webauthnSignature(t *testing.T, vector *webauthnVector) *protocol.WebAuthnSignature {
	t.Helper()
	return &protocol.WebAuthnSignature{
		CredentialID:      decodeHex(t, vector.Signature.CredentialIDHex),
		AuthenticatorData: decodeHex(t, vector.Signature.AuthenticatorDataHex),
		ClientDataJSON:    []byte(vector.Signature.ClientDataJSON),
		Signature:         decodeHex(t, vector.Signature.SignatureHex),
	}
}

func TestWebAuthnVectors(t *testing.T) {
	fixture := readM4CryptoFixture(t)
	if len(fixture.WebAuthn) == 0 {
		t.Fatal("fixture has no webauthn vectors")
	}
	for i := range fixture.WebAuthn {
		vector := &fixture.WebAuthn[i]
		t.Run(vector.ID, func(t *testing.T) {
			payload := decodeHex(t, vector.PayloadHex)
			userVerified, err := VerifyWebAuthn(payload, webauthnSignature(t, vector), webauthnTrust(t, vector))
			// User verification is not a signature error any more; a trust entry that
			// requires it is checked by Decide's step 7, so the vector is accepted only
			// when the flag satisfies require_uv as well.
			valid := err == nil && (!vector.Trust.RequireUV || userVerified)
			if vector.Valid && !valid {
				t.Fatalf("rejected: %s: %v (user verified %v)", vector.Description, err, userVerified)
			}
			if !vector.Valid && valid {
				t.Fatalf("accepted: %s", vector.Description)
			}
		})
	}
}

// TestWebAuthnRejectsMismatchedCOSEKeys checks that a COSE key is never reinterpreted
// under a different kty, alg or curve.
func TestWebAuthnRejectsMismatchedCOSEKeys(t *testing.T) {
	fixture := readM4CryptoFixture(t)
	var es256 *webauthnVector
	for i := range fixture.WebAuthn {
		if fixture.WebAuthn[i].ID == "webauthn.es256" {
			es256 = &fixture.WebAuthn[i]
			break
		}
	}
	if es256 == nil {
		t.Fatal("fixture has no webauthn.es256 vector")
	}
	payload := decodeHex(t, es256.PayloadHex)
	signature := webauthnSignature(t, es256)

	rewrite := func(t *testing.T, mutate func(map[int64]any)) *protocol.WebAuthnTrustKey {
		t.Helper()
		var fields map[int64]any
		if err := cbor.Unmarshal(decodeHex(t, es256.Trust.COSEKeyHex), &fields); err != nil {
			t.Fatalf("decode COSE key: %v", err)
		}
		mutate(fields)
		coseKey, err := cbor.Marshal(fields)
		if err != nil {
			t.Fatalf("encode COSE key: %v", err)
		}
		key := webauthnTrust(t, es256)
		key.COSEKey = coseKey
		return key
	}

	tests := []struct {
		name   string
		mutate func(map[int64]any)
	}{
		{"kty mismatch", func(fields map[int64]any) { fields[coseLabelKty] = uint64(coseKtyOKP) }},
		{"alg mismatch", func(fields map[int64]any) { fields[coseLabelAlg] = int64(coseAlgEdDSA) }},
		{"curve mismatch", func(fields map[int64]any) { fields[coseLabelCrv] = uint64(2) }},
		{"missing y", func(fields map[int64]any) { delete(fields, coseLabelY) }},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			key := rewrite(t, test.mutate)
			if _, err := VerifyWebAuthn(payload, signature, key); err == nil {
				t.Fatal("mismatched COSE key accepted")
			}
		})
	}

	t.Run("malformed cose key", func(t *testing.T) {
		key := webauthnTrust(t, es256)
		key.COSEKey = []byte{0xff}
		if _, err := VerifyWebAuthn(payload, signature, key); err == nil {
			t.Fatal("malformed COSE key accepted")
		}
	})
}
