package enroll

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"

	"github.com/Kodecable/ClusterRightHand/client/internal/config"
	"github.com/Kodecable/ClusterRightHand/client/internal/execenv"
)

func TestParseToken(t *testing.T) {
	fingerprint, secret, err := ParseToken("crh1.abc.def")
	if err != nil || fingerprint != "abc" || secret != "def" {
		t.Fatalf("ParseToken = %q, %q, %v", fingerprint, secret, err)
	}
	for _, token := range []string{"", "crh1.abc", "crh2.abc.def", "crh1..def", "crh1.abc."} {
		if _, _, err := ParseToken(token); err == nil {
			t.Fatalf("%q was accepted", token)
		}
	}
}

// TestBackupEnrollmentKeys covers that --replace moves the keys aside, overwrites older backups, and
// that the returned restore reverses the move.
func TestBackupEnrollmentKeys(t *testing.T) {
	stateDir := filepath.Join(t.TempDir(), "state")
	if err := os.MkdirAll(stateDir, 0o700); err != nil {
		t.Fatal(err)
	}
	cfg, err := config.Parse([]byte("server = \"https://crh.example.com\"\nstate_dir = \"" + stateDir + "\"\n"))
	if err != nil {
		t.Fatal(err)
	}
	identityPath := cfg.IdentityKeyPath()
	serverPath := cfg.ServerKeyPath()
	for path, content := range map[string]string{
		identityPath:          "identity\n",
		identityPath + ".old": "older identity\n",
		serverPath:            "server\n",
		serverPath + ".old":   "older server\n",
	} {
		if err := os.WriteFile(path, []byte(content), 0o600); err != nil {
			t.Fatal(err)
		}
	}

	restore, err := backupEnrollmentKeys(identityPath, serverPath, true)
	if err != nil {
		t.Fatal(err)
	}
	for path, want := range map[string]string{
		identityPath + ".old": "identity\n",
		serverPath + ".old":   "server\n",
	} {
		data, readErr := os.ReadFile(path)
		if readErr != nil || string(data) != want {
			t.Fatalf("%s = %q, %v; want %q", path, data, readErr, want)
		}
	}
	if _, statErr := os.Stat(identityPath); !errors.Is(statErr, os.ErrNotExist) {
		t.Fatalf("identity.key still exists after the move: %v", statErr)
	}
	if err := restore(); err != nil {
		t.Fatal(err)
	}
	for path, want := range map[string]string{
		identityPath: "identity\n",
		serverPath:   "server\n",
	} {
		data, readErr := os.ReadFile(path)
		if readErr != nil || string(data) != want {
			t.Fatalf("%s = %q, %v; want %q", path, data, readErr, want)
		}
		if _, statErr := os.Stat(path + ".old"); !errors.Is(statErr, os.ErrNotExist) {
			t.Fatalf("%s.old left behind: %v", path, statErr)
		}
	}
	// Without --replace the helper is a no-op.
	noop, err := backupEnrollmentKeys(identityPath, serverPath, false)
	if err != nil {
		t.Fatal(err)
	}
	if err := noop(); err != nil {
		t.Fatal(err)
	}
	if _, statErr := os.Stat(identityPath); statErr != nil {
		t.Fatalf("identity.key missing after a no-op: %v", statErr)
	}
}

// TestRunRestoresKeysOnFailure covers that a failed enrollment against a server without an identity
// restores the keys moved aside by --replace.
func TestRunRestoresKeysOnFailure(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		http.Error(w, "no identity", http.StatusInternalServerError)
	}))
	defer server.Close()
	stateDir := t.TempDir()
	cfg, err := config.Parse([]byte("server = \"" + server.URL + "\"\nstate_dir = \"" + stateDir + "\"\n"))
	if err != nil {
		t.Fatal(err)
	}
	identityPath := cfg.IdentityKeyPath()
	if err := os.WriteFile(identityPath, []byte("old identity\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	_, err = Run(context.Background(), cfg, "crh1.abc.secret", Options{
		Replace: true,
		Env:     &execenv.Environment{Shell: "/bin/sh", Path: "/usr/bin"},
	})
	if err == nil {
		t.Fatal("Run succeeded against a server that returns 500")
	}
	data, readErr := os.ReadFile(identityPath)
	if readErr != nil || string(data) != "old identity\n" {
		t.Fatalf("identity = %q, %v; want it restored", data, readErr)
	}
}
