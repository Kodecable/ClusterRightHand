// Package identity stores crha's Noise static key and the pinned crhs public key under state_dir.
package identity

import (
	"crypto/sha256"
	"encoding/base64"
	"errors"
	"fmt"
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

func LoadKeypair(path string) (noise.Keypair, error) {
	raw, err := readKey(path)
	if err != nil {
		return noise.Keypair{}, err
	}
	info, err := os.Stat(path)
	if err == nil && info.Mode().Perm()&0o077 != 0 {
		return noise.Keypair{}, fmt.Errorf("%s must not be accessible by group or others (chmod 600)", path)
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
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	key, err := base64.StdEncoding.DecodeString(strings.TrimSpace(string(data)))
	if err != nil || len(key) != noise.KeyLen {
		return nil, fmt.Errorf("%s: not a base64 encoded %d-byte key", path, noise.KeyLen)
	}
	return key, nil
}

func writeKey(path string, key []byte, mode os.FileMode) error {
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return err
	}
	f, err := os.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_EXCL, mode)
	if errors.Is(err, os.ErrExist) {
		return fmt.Errorf("%s already exists", path)
	}
	if err != nil {
		return err
	}
	if _, err := f.WriteString(base64.StdEncoding.EncodeToString(key) + "\n"); err != nil {
		f.Close()
		return err
	}
	return f.Close()
}

// Keypair is a Noise static key pair.
type Keypair = noise.Keypair
