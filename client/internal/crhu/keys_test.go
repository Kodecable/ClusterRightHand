package crhu

import (
	"crypto/ed25519"
	"crypto/rand"
	"crypto/rsa"
	"net"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"golang.org/x/crypto/ssh"
	"golang.org/x/crypto/ssh/agent"
)

// writePubKey writes an authorized_keys line for a fresh ed25519 key and returns its fingerprint.
func writePubKey(t *testing.T, path, comment string) string {
	t.Helper()
	public, _, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	key, err := ssh.NewPublicKey(public)
	if err != nil {
		t.Fatal(err)
	}
	line := strings.TrimSpace(string(ssh.MarshalAuthorizedKey(key))) + " " + comment + "\n"
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(line), 0o600); err != nil {
		t.Fatal(err)
	}
	return ssh.FingerprintSHA256(key)
}

// isolatedHome points HOME at a fresh directory and clears the agent socket.
func isolatedHome(t *testing.T) string {
	t.Helper()
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("SSH_AUTH_SOCK", "")
	t.Setenv(keyDirsEnv, "")
	return home
}

func TestDiscoverCandidates(t *testing.T) {
	home := isolatedHome(t)
	sshDir := filepath.Join(home, ".ssh")
	first := writePubKey(t, filepath.Join(sshDir, "id_ed25519.pub"), "first")
	second := writePubKey(t, filepath.Join(sshDir, "id_ecdsa.pub"), "second")
	keyDir := t.TempDir()
	third := writePubKey(t, filepath.Join(keyDir, "extra.pub"), "third")
	// A duplicate file is listed once, at its first position.
	duplicate, err := os.ReadFile(filepath.Join(sshDir, "id_ecdsa.pub"))
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(keyDir, "duplicate.pub"), duplicate, 0o600); err != nil {
		t.Fatal(err)
	}
	// A file that is not a public key is skipped.
	if err := os.WriteFile(filepath.Join(keyDir, "broken.pub"), []byte("not a key\n"), 0o600); err != nil {
		t.Fatal(err)
	}

	candidates, _, err := discoverCandidates(&keyChoice{keyDirs: []string{keyDir}})
	if err != nil {
		t.Fatal(err)
	}
	var got []string
	for _, candidate := range candidates {
		got = append(got, candidate.fingerprint)
	}
	want := []string{second, first, third}
	if strings.Join(got, ",") != strings.Join(want, ",") {
		t.Fatalf("candidates = %v, want %v", got, want)
	}
	if candidates[0].path != filepath.Join(sshDir, "id_ecdsa.pub") || candidates[0].comment != "second" {
		t.Fatalf("first candidate = %+v", candidates[0])
	}

	// A missing --key-dir is an error; a missing ~/.ssh is not.
	if _, _, err := discoverCandidates(&keyChoice{keyDirs: []string{filepath.Join(t.TempDir(), "missing")}}); err == nil {
		t.Fatal("a missing --key-dir was accepted")
	}
	if _, _, err := discoverCandidates(&keyChoice{}); err != nil {
		t.Fatalf("a home without .ssh: %v", err)
	}
}

// TestDiscoverCandidatesExtraDirs covers ~/.crhu/keys and $CRHU_KEY_DIRS: they come after ~/.ssh and
// before --key-dir, in their own order; an empty entry is ignored, and a missing directory the user
// named in the variable is an error while a missing ~/.crhu/keys is not.
func TestDiscoverCandidatesExtraDirs(t *testing.T) {
	home := isolatedHome(t)
	sshKey := writePubKey(t, filepath.Join(home, ".ssh", "id_ed25519.pub"), "ssh")
	crhu := writePubKey(t, filepath.Join(home, ".crhu", "keys", "miko0.pub"), "crhu")
	envA, envB := t.TempDir(), t.TempDir()
	a := writePubKey(t, filepath.Join(envA, "a.pub"), "a")
	b := writePubKey(t, filepath.Join(envB, "b.pub"), "b")
	flagDir := t.TempDir()
	flag := writePubKey(t, filepath.Join(flagDir, "flag.pub"), "flag")
	t.Setenv(keyDirsEnv, envB+string(os.PathListSeparator)+string(os.PathListSeparator)+envA)

	candidates, _, err := discoverCandidates(&keyChoice{keyDirs: []string{flagDir}})
	if err != nil {
		t.Fatal(err)
	}
	var got []string
	for _, candidate := range candidates {
		got = append(got, candidate.fingerprint)
	}
	want := []string{sshKey, crhu, b, a, flag}
	if strings.Join(got, ",") != strings.Join(want, ",") {
		t.Fatalf("candidates = %v, want %v", got, want)
	}

	t.Setenv(keyDirsEnv, filepath.Join(t.TempDir(), "missing"))
	if _, _, err := discoverCandidates(&keyChoice{}); err == nil || !strings.Contains(err.Error(), keyDirsEnv) {
		t.Fatalf("a missing %s directory: err = %v", keyDirsEnv, err)
	}

	// Without ~/.crhu/keys nothing fails.
	isolatedHome(t)
	if _, _, err := discoverCandidates(&keyChoice{}); err != nil {
		t.Fatalf("a home without .crhu/keys: %v", err)
	}
}

// writeRSAPubKey writes an authorized_keys line for a fresh RSA key, a type CRH does not verify,
// and returns its fingerprint.
func writeRSAPubKey(t *testing.T, path string) string {
	t.Helper()
	private, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatal(err)
	}
	key, err := ssh.NewPublicKey(&private.PublicKey)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, ssh.MarshalAuthorizedKey(key), 0o600); err != nil {
		t.Fatal(err)
	}
	return ssh.FingerprintSHA256(key)
}

// TestKeyChoiceSkipsUnsupported covers keys of a type CRH does not verify: discovery never offers
// them, and an error names them instead of letting ssh-keygen sign something that cannot verify.
func TestKeyChoiceSkipsUnsupported(t *testing.T) {
	home := isolatedHome(t)
	rsaKey := writeRSAPubKey(t, filepath.Join(home, ".ssh", "id_rsa.pub"))

	candidates, unsupported, err := discoverCandidates(&keyChoice{})
	if err != nil {
		t.Fatal(err)
	}
	if len(candidates) != 0 || len(unsupported) != 1 || unsupported[0].fingerprint != rsaKey {
		t.Fatalf("candidates = %+v, unsupported = %+v", candidates, unsupported)
	}
	if _, err := (&keyChoice{}).signer("register"); err == nil || !strings.Contains(err.Error(), rsaKey) ||
		!strings.Contains(err.Error(), "ssh-rsa") {
		t.Fatalf("only an RSA key = %v", err)
	}
	if _, err := (&keyChoice{hints: []string{rsaKey}}).signer("register"); err == nil || !strings.Contains(err.Error(), "ssh-rsa") {
		t.Fatalf("--hint of an RSA key = %v", err)
	}
	// --key is checked through the .pub beside it, before ssh-keygen runs.
	if _, err := (&keyChoice{key: filepath.Join(home, ".ssh", "id_rsa")}).signer("register"); err == nil ||
		!strings.Contains(err.Error(), "ssh-rsa") {
		t.Fatalf("--key of an RSA key = %v", err)
	}

	// With a supported key beside it, the RSA key does not make the choice ambiguous.
	ed := writePubKey(t, filepath.Join(home, ".ssh", "id_ed25519.pub"), "ed")
	candidate, err := (&keyChoice{yes: true}).signer("register")
	if err != nil || candidate.fingerprint != ed {
		t.Fatalf("signer = %+v, %v; want %s", candidate, err, ed)
	}
}

func TestKeyChoiceHints(t *testing.T) {
	home := isolatedHome(t)
	first := writePubKey(t, filepath.Join(home, ".ssh", "id_one.pub"), "one")
	second := writePubKey(t, filepath.Join(home, ".ssh", "id_two.pub"), "two")

	// With hints the first matching candidate wins.
	candidate, err := (&keyChoice{hints: []string{"SHA256:none", second}}).signer("sign")
	if err != nil {
		t.Fatal(err)
	}
	if got := ssh.FingerprintSHA256(candidate.publicKey); got != second {
		t.Fatalf("hint chose %s, want %s", got, second)
	}

	// No match lists the wanted hints and the fingerprints found.
	_, err = (&keyChoice{hints: []string{"SHA256:aaaa", "SHA256:bbbb"}}).signer("grant")
	if err == nil || !strings.Contains(err.Error(), "SHA256:aaaa") || !strings.Contains(err.Error(), first) {
		t.Fatalf("no-match error = %v", err)
	}
	if !strings.Contains(err.Error(), "SHA256:bbbb") || !strings.Contains(err.Error(), second) {
		t.Fatalf("no-match error omits a hint or a found key: %v", err)
	}

	// An ambiguous choice without a terminal fails with the list; --yes does the same.
	noTerminal(t)
	if _, err := (&keyChoice{}).signer("sign"); err == nil || !strings.Contains(err.Error(), "id_one.pub") {
		t.Fatalf("ambiguous without a terminal = %v", err)
	}
	yes := &keyChoice{yes: true}
	if _, err := yes.signer("sign"); err == nil || !strings.Contains(err.Error(), "--hint or --key") {
		t.Fatalf("ambiguous with --yes = %v", err)
	}

	// On a terminal the numbered choice selects the key.
	answerTerminal(t, "2\n")
	candidate, err = (&keyChoice{}).signer("sign")
	if err != nil {
		t.Fatal(err)
	}
	if got := ssh.FingerprintSHA256(candidate.publicKey); got != second {
		t.Fatalf("terminal chose %s, want the second key %s", got, second)
	}
}

func TestKeyChoiceSingle(t *testing.T) {
	home := isolatedHome(t)
	fingerprint := writePubKey(t, filepath.Join(home, ".ssh", "id_ed25519.pub"), "only")
	candidate, err := (&keyChoice{}).signer("sign")
	if err != nil {
		t.Fatal(err)
	}
	if got := ssh.FingerprintSHA256(candidate.publicKey); got != fingerprint {
		t.Fatalf("chose %s, want %s", got, fingerprint)
	}
}

func TestKeyChoiceExactKey(t *testing.T) {
	isolatedHome(t)
	path := filepath.Join(t.TempDir(), "explicit")
	candidate, err := (&keyChoice{key: path, hints: []string{"SHA256:ignored"}}).signer("sign")
	if err != nil {
		t.Fatal(err)
	}
	if candidate.path != path {
		t.Fatalf("path = %q, want %q", candidate.path, path)
	}
	// An empty candidate list is an error when no key was given.
	if _, err := (&keyChoice{}).signer("sign"); err == nil || !strings.Contains(err.Error(), "no SSH signing key found") {
		t.Fatalf("no candidates = %v", err)
	}
	if _, err := (&keyChoice{hints: []string{"not-a-fingerprint"}}).signer("sign"); err == nil {
		t.Fatal("a malformed hint was accepted")
	}
}

func TestAgentCandidates(t *testing.T) {
	isolatedHome(t)
	_, private, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	keyring := agent.NewKeyring()
	if err := keyring.Add(agent.AddedKey{PrivateKey: private, Comment: "agent key"}); err != nil {
		t.Fatal(err)
	}
	socket := filepath.Join(t.TempDir(), "agent.sock")
	listener, err := net.Listen("unix", socket)
	if err != nil {
		t.Fatal(err)
	}
	defer listener.Close()
	go func() {
		for {
			conn, err := listener.Accept()
			if err != nil {
				return
			}
			go func() { _ = agent.ServeAgent(keyring, conn); _ = conn.Close() }()
		}
	}()
	t.Setenv("SSH_AUTH_SOCK", socket)

	candidates, _, err := discoverCandidates(&keyChoice{})
	if err != nil {
		t.Fatal(err)
	}
	if len(candidates) != 1 {
		t.Fatalf("candidates = %+v, want the agent key only", candidates)
	}
	candidate := candidates[0]
	if candidate.path != "" || candidate.comment != "agent key" {
		t.Fatalf("agent candidate = %+v", candidate)
	}

	// An agent key without a .pub file is written to a 0600 temporary file for ssh-keygen.
	path, cleanup, err := candidate.signerPath()
	if err != nil {
		t.Fatal(err)
	}
	info, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	if info.Mode().Perm() != 0o600 {
		t.Fatalf("temporary key mode = %o, want 600", info.Mode().Perm())
	}
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	key, _, _, _, err := ssh.ParseAuthorizedKey(data)
	if err != nil {
		t.Fatal(err)
	}
	if ssh.FingerprintSHA256(key) != candidate.fingerprint {
		t.Fatalf("temporary key is not the agent key")
	}
	cleanup()
	if _, err := os.Stat(path); !os.IsNotExist(err) {
		t.Fatalf("temporary key was not removed: %v", err)
	}
}
