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

	"github.com/Kodecable/ClusterRightHand/client/internal/fsutil"
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

// Owner is the uid and gid a key file is created with before it is published. A nil Owner leaves
// the file owned by the process that writes it.
type Owner struct {
	UID uint32
	GID uint32
}

// SaveKeypair writes crha's static key pair. owner is set on the temporary file before the final
// name is published; nil leaves the writer's owner (the tests' non-root case).
func SaveKeypair(path string, kp noise.Keypair, owner *Owner) error {
	return writeKey(path, kp.Private, 0o600, owner)
}

func LoadServerKey(path string) ([]byte, error) {
	return readKey(path)
}

// SaveServerKey writes the pinned server public key. owner has the same meaning as in
// SaveKeypair.
func SaveServerKey(path string, public []byte, owner *Owner) error {
	return writeKey(path, public, 0o644, owner)
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

// writeKey publishes a new key file without ever replacing an existing one: an earlier or concurrent
// write is never clobbered, and a crash leaves at most a temporary file. The owner is set through the
// temporary file before the name exists, so no chown ever runs on a path the unprivileged account could
// have replaced with a symlink.
func writeKey(path string, key []byte, mode os.FileMode, owner *Owner) error {
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return err
	}
	opts := fsutil.WriteOptions{Exclusive: true}
	if owner != nil {
		opts.Owner = &fsutil.Owner{UID: int(owner.UID), GID: int(owner.GID)}
	}
	err := fsutil.WriteFile(path, []byte(base64.StdEncoding.EncodeToString(key)+"\n"), mode, opts)
	if errors.Is(err, os.ErrExist) {
		return fmt.Errorf("%s already exists", path)
	}
	return err
}

// Keypair is a Noise static key pair.
type Keypair = noise.Keypair
