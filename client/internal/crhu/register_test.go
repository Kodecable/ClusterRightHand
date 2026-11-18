package crhu

import (
	"bytes"
	"encoding/base64"
	"strings"
	"testing"

	"golang.org/x/crypto/ssh"

	"github.com/Kodecable/ClusterRightHand/client/internal/privileged/authz"
	"github.com/Kodecable/ClusterRightHand/client/internal/protocol"
)

// TestRegisterSignsChallenge signs the decoded challenge in the registration namespace and prints
// one base64 line the WebUI can paste.
func TestRegisterSignsChallenge(t *testing.T) {
	keyPath, public := generateSSHKey(t)
	useSSHKeygen(t, "ssh-keygen")
	challenge := []byte(protocol.RegisterNamespace + "\nuser:0192f000-0000-7000-8000-000000000001\nserver:test-server\nnonce:AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8\n")

	stdout, stderr, err := runCLI(t, "register", base64.RawURLEncoding.EncodeToString(challenge), "--key", keyPath)
	if err != nil {
		t.Fatalf("register: %v\nstderr: %s", err, stderr)
	}
	line := strings.TrimSpace(stdout)
	blob, err := base64.StdEncoding.DecodeString(line)
	if err != nil {
		t.Fatalf("stdout %q is not base64: %v", stdout, err)
	}
	result, err := authz.VerifySSHSIGNamespace(blob, challenge, protocol.RegisterNamespace)
	if err != nil {
		t.Fatalf("verify: %v", err)
	}
	if !bytes.Equal(result.PublicKey.Marshal(), public.Marshal()) {
		t.Fatalf("signed by %s, want %s", result.PublicKey.Type(), public.Type())
	}
	if !strings.Contains(stderr, ssh.FingerprintSHA256(public)) || !strings.Contains(stderr, "WebUI") {
		t.Fatalf("stderr does not name the signer and the paste target: %s", stderr)
	}

	// The same challenge in standard base64 is accepted too.
	stdout, _, err = runCLI(t, "register", base64.StdEncoding.EncodeToString(challenge), "--key", keyPath)
	if err != nil {
		t.Fatal(err)
	}
	if strings.TrimSpace(stdout) == "" {
		t.Fatal("standard base64 challenge printed nothing")
	}

	// A registration signature never verifies as an authorization.
	if _, err := authz.VerifySSHSIG(blob, challenge); err == nil {
		t.Fatal("a registration signature verified as an authorization")
	}

	// Bytes that are not a registration challenge are refused before signing.
	if _, _, err := runCLI(t, "register", base64.RawURLEncoding.EncodeToString([]byte("something else")), "--key", keyPath); err == nil {
		t.Fatal("a non-registration challenge was signed")
	}
	if _, _, err := runCLI(t, "register", "not base64!", "--key", keyPath); err == nil {
		t.Fatal("a non-base64 challenge was accepted")
	}
}
