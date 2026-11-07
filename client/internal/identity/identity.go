// Package identity stores crha's Noise static key and the pinned crhs public key under state_dir.
package identity

import (
	"crypto/sha256"
	"encoding/base64"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"

	"github.com/Kodecable/ClusterRightHand/client/internal/noise"
)

// Fingerprint is how keys are shown and compared: base64url(SHA-256(public key)), as in enrollment tokens.
func Fingerprint(public []byte) string {
	sum := sha256.Sum256(public)
	return base64.RawURLEncoding.EncodeToString(sum[:])
}

// LoadKeypair reads and decodes crha's static key pair. The key is opened once and both the
// permission check and the read use that fd: the mode that is checked is the mode of the file that
// is read, not of whatever the path names afterwards.
func LoadKeypair(path string) (noise.Keypair, error) {
	f, err := os.Open(path)
	if err != nil {
		return noise.Keypair{}, err
	}
	defer f.Close()
	info, err := f.Stat()
	if err != nil {
		return noise.Keypair{}, err
	}
	if info.Mode().Perm()&0o077 != 0 {
		return noise.Keypair{}, fmt.Errorf("%s must not be accessible by group or others (chmod 600)", path)
	}
	raw, err := decodeKey(f, path)
	if err != nil {
		return noise.Keypair{}, err
	}
	return noise.KeypairFromPrivate(raw)
}

func SaveKeypair(path string, kp noise.Keypair) error {
	return writeKey(path, kp.Private, 0o600)
}

func LoadServerKey(path string) ([]byte, error) {
	return readKey(path)
}

func SaveServerKey(path string, public []byte) error {
	return writeKey(path, public, 0o644)
}

func readKey(path string) ([]byte, error) {
	f, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	return decodeKey(f, path)
}

func decodeKey(r io.Reader, path string) ([]byte, error) {
	data, err := io.ReadAll(r)
	if err != nil {
		return nil, err
	}
	key, err := base64.StdEncoding.DecodeString(strings.TrimSpace(string(data)))
	if err != nil || len(key) != noise.KeyLen {
		return nil, fmt.Errorf("%s: not a base64 encoded %d-byte key", path, noise.KeyLen)
	}
	return key, nil
}

// writeKey publishes a new key file without ever replacing an existing one. The key is written to a
// temporary file in the same directory, fsynced, then linked to the final name: link(2) fails if the
// name exists, so a concurrent or earlier write is never clobbered, and a crash before the link
// leaves only a temporary file. The directory is fsynced once the name is published.
func writeKey(path string, key []byte, mode os.FileMode) error {
	dir := filepath.Dir(path)
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return err
	}
	tmp, err := os.CreateTemp(dir, "."+filepath.Base(path)+".crh-*")
	if err != nil {
		return err
	}
	tmpName := tmp.Name()
	defer os.Remove(tmpName)
	if err := tmp.Chmod(mode); err != nil {
		tmp.Close()
		return err
	}
	if _, err := tmp.WriteString(base64.StdEncoding.EncodeToString(key) + "\n"); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Sync(); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	if err := os.Link(tmpName, path); err != nil {
		if errors.Is(err, os.ErrExist) {
			return fmt.Errorf("%s already exists", path)
		}
		return err
	}
	if err := os.Remove(tmpName); err != nil {
		return err
	}
	return syncDir(dir)
}

// syncDir fsyncs the directory a key was published in.
func syncDir(dir string) error {
	d, err := os.Open(dir)
	if err != nil {
		return err
	}
	defer d.Close()
	return d.Sync()
}

// Keypair is a Noise static key pair.
type Keypair = noise.Keypair
