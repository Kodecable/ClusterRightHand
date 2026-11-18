package identity

import (
	"bytes"
	"os"
	"path/filepath"
	"strings"
	"syscall"
	"testing"

	"github.com/Kodecable/ClusterRightHand/client/internal/noise"
)

func newKeypair(t *testing.T) noise.Keypair {
	t.Helper()
	kp, err := noise.GenerateKeypair()
	if err != nil {
		t.Fatal(err)
	}
	return kp
}

// TestLoadKeypairChecksModeBeforeDecoding covers the order of the load: the opened fd is fstat'ed
// before the key is read, so a key whose mode is too open is refused even when its content is not a
// valid key at all.
func TestLoadKeypairChecksModeBeforeDecoding(t *testing.T) {
	path := filepath.Join(t.TempDir(), "identity.key")
	want := newKeypair(t)
	if err := SaveKeypair(path, want, nil); err != nil {
		t.Fatal(err)
	}
	got, err := LoadKeypair(path)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(got.Private, want.Private) || !bytes.Equal(got.Public, want.Public) {
		t.Fatal("loaded a different key")
	}

	if err := os.WriteFile(path, []byte("not a key"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(path, 0o644); err != nil {
		t.Fatal(err)
	}
	_, err = LoadKeypair(path)
	if err == nil || !strings.Contains(err.Error(), "must not be accessible by group or others") {
		t.Fatalf("got %v, want the permission error before decoding", err)
	}
}

// TestSaveKeypairMode covers the mode of the published file.
func TestSaveKeypairMode(t *testing.T) {
	dir := t.TempDir()
	keyPath := filepath.Join(dir, "identity.key")
	if err := SaveKeypair(keyPath, newKeypair(t), nil); err != nil {
		t.Fatal(err)
	}
	fi, err := os.Stat(keyPath)
	if err != nil {
		t.Fatal(err)
	}
	if fi.Mode().Perm() != 0o600 {
		t.Fatalf("identity key mode = %v, want 0600", fi.Mode())
	}

	serverPath := filepath.Join(dir, "server.pub")
	if err := SaveServerKey(serverPath, make([]byte, noise.KeyLen), nil); err != nil {
		t.Fatal(err)
	}
	fi, err = os.Stat(serverPath)
	if err != nil {
		t.Fatal(err)
	}
	if fi.Mode().Perm() != 0o644 {
		t.Fatalf("server key mode = %v, want 0644", fi.Mode())
	}
}

// TestWriteKeyNeverOverwrites covers the O_EXCL semantics of a key file: a later write fails and
// leaves the existing key untouched.
func TestWriteKeyNeverOverwrites(t *testing.T) {
	path := filepath.Join(t.TempDir(), "identity.key")
	first := newKeypair(t)
	if err := SaveKeypair(path, first, nil); err != nil {
		t.Fatal(err)
	}
	before, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}

	if err := SaveKeypair(path, newKeypair(t), nil); err == nil || !strings.Contains(err.Error(), "already exists") {
		t.Fatalf("got %v, want already exists", err)
	}
	after, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(before, after) {
		t.Fatal("an existing key was modified")
	}
	got, err := LoadKeypair(path)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(got.Private, first.Private) {
		t.Fatal("loaded a different key")
	}
}

// TestWriteKeyIgnoresLeftoverTemp covers a write interrupted after its temporary file was fsynced:
// the temporary file left in the directory does not block a later write, which publishes the final
// name from a new temporary file.
func TestWriteKeyIgnoresLeftoverTemp(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "identity.key")
	stale := filepath.Join(dir, ".identity.key.crh-stale")
	if err := os.WriteFile(stale, []byte("partial key\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	want := newKeypair(t)
	if err := SaveKeypair(path, want, nil); err != nil {
		t.Fatalf("write after a leftover temp: %v", err)
	}
	got, err := LoadKeypair(path)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(got.Private, want.Private) {
		t.Fatal("loaded a different key")
	}
	if _, err := os.Stat(path); err != nil {
		t.Fatal(err)
	}
}

// TestSaveKeypairOwner covers the owner set on the temporary file before publication: the
// published key belongs to the requested uid/gid, which a non-root writer can ask for when it
// names its own. The setup path uses this to publish root-written keys as crha's.
func TestSaveKeypairOwner(t *testing.T) {
	owner := &Owner{UID: uint32(os.Geteuid()), GID: uint32(os.Getegid())}
	dir := t.TempDir()
	keyPath := filepath.Join(dir, "identity.key")
	if err := SaveKeypair(keyPath, newKeypair(t), owner); err != nil {
		t.Fatal(err)
	}
	serverPath := filepath.Join(dir, "server.pub")
	if err := SaveServerKey(serverPath, make([]byte, noise.KeyLen), owner); err != nil {
		t.Fatal(err)
	}
	for _, path := range []string{keyPath, serverPath} {
		fi, err := os.Stat(path)
		if err != nil {
			t.Fatal(err)
		}
		st, ok := fi.Sys().(*syscall.Stat_t)
		if !ok {
			t.Fatalf("%s: cannot determine the owner", path)
		}
		if st.Uid != owner.UID || st.Gid != owner.GID {
			t.Fatalf("%s owner = %d:%d, want %d:%d", path, st.Uid, st.Gid, owner.UID, owner.GID)
		}
	}
}
