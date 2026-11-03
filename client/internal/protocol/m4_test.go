package protocol

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

// m4Fixture is the subset of test/interop/m4_vectors.json this package exercises. The
// crh-priv handshake and framed vectors belong to the crh-priv codec.
type m4Fixture struct {
	Specs []struct {
		ID        string `json:"id"`
		Spec      any    `json:"spec"`
		Hex       string `json:"hex"`
		SHA256Hex string `json:"sha256Hex"`
	} `json:"specs"`
	Payloads []struct {
		ID                 string `json:"id"`
		Description        string `json:"description"`
		Hex                string `json:"hex"`
		Payload            any    `json:"payload"`
		AuthorizationIDHex string `json:"authorizationIdHex"`
	} `json:"payloads"`
	PayloadNegative []struct {
		ID          string `json:"id"`
		Description string `json:"description"`
		Hex         string `json:"hex"`
	} `json:"payloadNegative"`
	Authorizations []struct {
		ID          string `json:"id"`
		Description string `json:"description"`
		Hex         string `json:"hex"`
	} `json:"authorizations"`
	Bodies []struct {
		ID          string `json:"id"`
		Description string `json:"description"`
		Codec       string `json:"codec"`
		Hex         string `json:"hex"`
		DigestHex   string `json:"digestHex"`
	} `json:"bodies"`
}

func readM4Fixture(t *testing.T) *m4Fixture {
	t.Helper()
	path := filepath.Join("..", "..", "..", "test", "interop", "m4_vectors.json")
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read %s: %v", path, err)
	}
	var fixture m4Fixture
	if err := json.Unmarshal(data, &fixture); err != nil {
		t.Fatalf("parse %s: %v", path, err)
	}
	return &fixture
}

func TestM4SpecVectors(t *testing.T) {
	fixture := readM4Fixture(t)
	if len(fixture.Specs) == 0 {
		t.Fatal("fixture has no specs")
	}
	for _, vector := range fixture.Specs {
		t.Run(vector.ID, func(t *testing.T) {
			raw := mustHex(t, vector.Hex)
			var spec TaskSpec
			if err := Unmarshal(raw, &spec); err != nil {
				t.Fatalf("decode: %v", err)
			}
			encoded, err := Marshal(&spec)
			if err != nil {
				t.Fatalf("re-encode: %v", err)
			}
			if got := hex.EncodeToString(encoded); got != vector.Hex {
				t.Fatalf("re-encoded as %s, want %s", got, vector.Hex)
			}
			digest, err := SpecSHA256(&spec)
			if err != nil {
				t.Fatalf("SpecSHA256: %v", err)
			}
			if got := hex.EncodeToString(digest[:]); got != vector.SHA256Hex {
				t.Fatalf("spec_sha256 = %s, want %s", got, vector.SHA256Hex)
			}
		})
	}
}

func TestM4PayloadVectors(t *testing.T) {
	fixture := readM4Fixture(t)
	if len(fixture.Payloads) == 0 {
		t.Fatal("fixture has no payloads")
	}
	for _, vector := range fixture.Payloads {
		t.Run(vector.ID, func(t *testing.T) {
			raw := mustHex(t, vector.Hex)
			payload, err := DecodeAuthorizationPayload(raw)
			if err != nil {
				t.Fatalf("DecodeAuthorizationPayload: %v", err)
			}
			encoded, err := Marshal(payload)
			if err != nil {
				t.Fatalf("re-encode: %v", err)
			}
			if !bytes.Equal(encoded, raw) {
				t.Fatalf("re-encoded as %x, want %x", encoded, raw)
			}
			id := AuthorizationID(raw)
			if got := hex.EncodeToString(id[:]); got != vector.AuthorizationIDHex {
				t.Fatalf("authorization id = %s, want %s", got, vector.AuthorizationIDHex)
			}
		})
	}
}

func TestM4PayloadNegativeVectors(t *testing.T) {
	fixture := readM4Fixture(t)
	if len(fixture.PayloadNegative) == 0 {
		t.Fatal("fixture has no negative payloads")
	}
	for _, vector := range fixture.PayloadNegative {
		t.Run(vector.ID, func(t *testing.T) {
			if _, err := DecodeAuthorizationPayload(mustHex(t, vector.Hex)); err == nil {
				t.Fatalf("accepted: %s", vector.Description)
			}
		})
	}
}

func TestM4AuthorizationVectors(t *testing.T) {
	fixture := readM4Fixture(t)
	if len(fixture.Authorizations) == 0 {
		t.Fatal("fixture has no authorizations")
	}
	for _, vector := range fixture.Authorizations {
		t.Run(vector.ID, func(t *testing.T) {
			raw := mustHex(t, vector.Hex)
			var authorization Authorization
			if err := Unmarshal(raw, &authorization); err != nil {
				t.Fatalf("decode: %v", err)
			}
			encoded, err := Marshal(&authorization)
			if err != nil {
				t.Fatalf("re-encode: %v", err)
			}
			if !bytes.Equal(encoded, raw) {
				t.Fatalf("re-encoded as %x, want %x", encoded, raw)
			}
			// The payload bytes are carried verbatim and are themselves a valid payload.
			if _, err := DecodeAuthorizationPayload(authorization.Payload); err != nil {
				t.Fatalf("embedded payload: %v", err)
			}
		})
	}
}

// decodeM4Body decodes the body codec named by the fixture.
func decodeM4Body(t *testing.T, codec string, raw []byte) any {
	t.Helper()
	switch codec {
	case "TrustSummary":
		var v TrustSummary
		if err := Unmarshal(raw, &v); err != nil {
			t.Fatalf("decode TrustSummary: %v", err)
		}
		return &v
	case "TrustReport":
		var v TrustReport
		if err := Unmarshal(raw, &v); err != nil {
			t.Fatalf("decode TrustReport: %v", err)
		}
		return &v
	case "LocalRequest":
		var v LocalRequest
		if err := Unmarshal(raw, &v); err != nil {
			t.Fatalf("decode LocalRequest: %v", err)
		}
		return &v
	case "LocalWithdraw":
		var v LocalWithdraw
		if err := Unmarshal(raw, &v); err != nil {
			t.Fatalf("decode LocalWithdraw: %v", err)
		}
		return &v
	case "LocalDecision":
		var v LocalDecision
		if err := Unmarshal(raw, &v); err != nil {
			t.Fatalf("decode LocalDecision: %v", err)
		}
		return &v
	case "PendingEntry":
		var v PendingEntry
		if err := Unmarshal(raw, &v); err != nil {
			t.Fatalf("decode PendingEntry: %v", err)
		}
		return &v
	default:
		t.Fatalf("fixture names unknown body codec %q", codec)
		return nil
	}
}

func TestM4BodyVectors(t *testing.T) {
	fixture := readM4Fixture(t)
	if len(fixture.Bodies) == 0 {
		t.Fatal("fixture has no bodies")
	}
	seen := make(map[string]bool, len(fixture.Bodies))
	for _, vector := range fixture.Bodies {
		t.Run(vector.ID, func(t *testing.T) {
			raw := mustHex(t, vector.Hex)
			value := decodeM4Body(t, vector.Codec, raw)
			encoded, err := Marshal(value)
			if err != nil {
				t.Fatalf("re-encode: %v", err)
			}
			if !bytes.Equal(encoded, raw) {
				t.Fatalf("re-encoded as %x, want %x", encoded, raw)
			}
			if vector.DigestHex != "" {
				summary, ok := value.(*TrustSummary)
				if !ok {
					t.Fatalf("digestHex is set on a %T", value)
				}
				digest, err := TrustDigest(summary)
				if err != nil {
					t.Fatalf("TrustDigest: %v", err)
				}
				if got := hex.EncodeToString(digest[:]); got != vector.DigestHex {
					t.Fatalf("trust digest = %s, want %s", got, vector.DigestHex)
				}
			}
			seen[vector.Codec] = true
		})
	}
	// Every codec this file mirrors must appear in the fixture, so a lost vector cannot
	// silently shrink coverage.
	for _, codec := range []string{
		"TrustSummary", "TrustReport", "LocalRequest",
		"LocalWithdraw", "LocalDecision", "PendingEntry",
	} {
		if !seen[codec] {
			t.Errorf("fixture has no %s body vector", codec)
		}
	}
}

// TestM4UnionBranches covers union branches the shared fixture does not contain.
func TestM4UnionBranches(t *testing.T) {
	tests := []struct {
		name string
		run  func(t *testing.T)
	}{
		{"LocalState.pending", func(t *testing.T) {
			checkRoundTrip(t, "", LocalState{Kind: LocalStatePending})
		}},
		{"LocalState.approved", func(t *testing.T) {
			checkRoundTrip(t, "", LocalState{Kind: LocalStateApproved})
		}},
		{"LocalState.denied", func(t *testing.T) {
			checkRoundTrip(t, "", LocalState{Kind: LocalStateDenied, Message: "no"})
		}},
		{"LocalVerdict", func(t *testing.T) {
			checkRoundTrip(t, "", LocalVerdict{TaskID: "t", Attempt: 2, Message: "ok"})
		}},
		{"TrustKey.sshsig", func(t *testing.T) {
			checkRoundTrip(t, "", TrustKey{Kind: TrustKeySSHSig, SSHSig: &SSHTrustKey{
				PublicKey: "ssh-ed25519 AAAA", Fingerprint: "SHA256:aaaa",
			}})
		}},
		{"TrustKey.webauthn", func(t *testing.T) {
			checkRoundTrip(t, "", TrustKey{Kind: TrustKeyWebAuthn, WebAuthn: &WebAuthnTrustKey{
				CredentialID: []byte{1, 2}, COSEKey: []byte{0xa0}, RPID: "r", Origins: []string{"https://r"},
			}})
		}},
		{"TrustKey.local", func(t *testing.T) {
			checkRoundTrip(t, "", TrustKey{Kind: TrustKeyLocal, Local: &LocalTrustKey{UIDs: []Uint{0, 1000}}})
		}},
		{"TrustReport.ok", func(t *testing.T) {
			checkRoundTrip(t, "", TrustReport{Kind: TrustReportOK, Summary: &TrustSummary{
				NodeID: "n", Groups: []string{}, ClockSkewMS: 1000, Trust: []TrustEntry{},
			}})
		}},
		{"AuthMatch.exact", func(t *testing.T) {
			checkRoundTrip(t, "", AuthMatch{Kind: AuthMatchExact, Exact: &AuthExact{Target: "t", SpecSHA256: Hash{1}}})
		}},
		{"AuthMatch.prefix", func(t *testing.T) {
			checkRoundTrip(t, "", AuthMatch{Kind: AuthMatchPrefix, Prefix: &AuthPrefix{Target: "t"}})
		}},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) { test.run(t) })
	}
}

func TestM4AuthorizationIDAndHashes(t *testing.T) {
	if _, err := SpecSHA256(nil); err == nil {
		t.Fatal("SpecSHA256(nil) accepted")
	}
	if _, err := TrustDigest(nil); err == nil {
		t.Fatal("TrustDigest(nil) accepted")
	}
	payload := []byte{0x80}
	if got, want := AuthorizationID(payload), sha256.Sum256(payload); got != want {
		t.Fatalf("AuthorizationID = %x, want %x", got, want)
	}
}
