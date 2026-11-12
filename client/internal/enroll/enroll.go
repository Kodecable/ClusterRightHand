// Package enroll implements the enrollment handshake shared by `crha register` and `crha enroll`: it
// parses the one-time token, checks crhs's key against its fingerprint, creates this node's identity
// key and registers it, saving the keys only once crhs accepted the token.
package enroll

import (
	"context"
	"crypto/tls"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"net/http"
	"os"
	"path/filepath"
	"strings"

	"github.com/Kodecable/ClusterRightHand/client/internal/config"
	"github.com/Kodecable/ClusterRightHand/client/internal/execenv"
	"github.com/Kodecable/ClusterRightHand/client/internal/facts"
	"github.com/Kodecable/ClusterRightHand/client/internal/identity"
	"github.com/Kodecable/ClusterRightHand/client/internal/noise"
	"github.com/Kodecable/ClusterRightHand/client/internal/protocol"
	"github.com/Kodecable/ClusterRightHand/client/internal/transport"
	"github.com/Kodecable/ClusterRightHand/client/internal/version"
)

// Result is what the handshake returned: the node id and the fingerprint of the new identity key.
type Result struct {
	NodeID      string
	Fingerprint string
}

// Options configures Run.
type Options struct {
	// Replace re-enrolls a node that already has keys: the old identity.key and server.pub are moved
	// aside as *.old and restored if enrollment fails.
	Replace bool
	// Env is the task environment whose discovered shells are reported to crhs. Required.
	Env *execenv.Environment
	// Root prefixes every path under StateDir, so tests can run against a temporary filesystem root.
	// Empty means the real paths.
	Root string
}

// Run performs one enrollment against crhs. The configuration must be loaded and validated.
func Run(ctx context.Context, cfg *config.Config, token string, opts Options) (result Result, err error) {
	fingerprint, secret, err := ParseToken(token)
	if err != nil {
		return Result{}, err
	}
	if opts.Env == nil {
		return Result{}, errors.New("enroll: no task environment")
	}
	identityPath := under(opts.Root, cfg.IdentityKeyPath())
	serverKeyPath := under(opts.Root, cfg.ServerKeyPath())
	if _, err := os.Stat(identityPath); err == nil && !opts.Replace {
		return Result{}, fmt.Errorf("%s exists: this node is already enrolled (pass --replace to re-enroll it with a new key)", cfg.IdentityKeyPath())
	}
	// Everything that does not touch the state directory has been checked. A failed enrollment puts the
	// previous keys back, so the node is unchanged.
	restore, err := backupEnrollmentKeys(identityPath, serverKeyPath, opts.Replace)
	if err != nil {
		return Result{}, err
	}
	defer func() {
		if err == nil {
			return
		}
		if restoreErr := restore(); restoreErr != nil {
			err = fmt.Errorf("%w (restoring the previous keys also failed: %v)", err, restoreErr)
		}
	}()

	serverKey, err := fetchServerKey(ctx, cfg, fingerprint)
	if err != nil {
		return Result{}, err
	}
	key, err := noise.GenerateKeypair()
	if err != nil {
		return Result{}, err
	}
	hostname, _ := os.Hostname()
	init := &protocol.HandshakeInit{
		CRHAVersion: version.Version,
		Enroll: &protocol.Enrollment{
			TokenSecret: secret,
			Hostname:    protocol.CleanText(hostname),
			Facts:       nodeFacts(cfg, opts.Env),
		},
	}
	conn, err := transport.Dial(ctx, transport.DialOptions{
		URL:                cfg.AgentURL(),
		InsecureSkipVerify: cfg.TLSVerify == config.TLSVerifyNone,
		Identity:           key,
		ServerPublic:       serverKey,
		Init:               init,
	})
	if err != nil {
		return Result{}, fmt.Errorf("enroll: %w", err)
	}
	defer conn.Close("enrolled")
	// Only now persist the keys: a rejected token leaves no half-enrolled state behind.
	if err := identity.SaveServerKey(serverKeyPath, serverKey); err != nil {
		return Result{}, err
	}
	if err := identity.SaveKeypair(identityPath, key); err != nil {
		return Result{}, err
	}
	result = Result{NodeID: conn.Response.NodeID, Fingerprint: identity.Fingerprint(key.Public)}
	return result, nil
}

// under prefixes a state file path with the test filesystem root.
func under(root, path string) string {
	if root == "" {
		return path
	}
	return filepath.Join(root, path)
}

// nodeFacts collects this node's facts; the shells are the ones the process discovered, since that
// is what `shell` commands run on (doc/design/protocol.md "Events").
func nodeFacts(cfg *config.Config, env *execenv.Environment) protocol.Facts {
	f := facts.Collect()
	if cfg.Notes != "" {
		notes := cfg.Notes
		f.NotesPath = &notes
	}
	f.Shells = &protocol.Shells{Sh: env.Shell}
	if env.Bash != "" {
		bash := env.Bash
		f.Shells.Bash = &bash
	}
	return facts.Clean(f)
}

// movedKey is one key file backupEnrollmentKeys moved aside. backup is empty when the file did not exist.
type movedKey struct {
	path   string
	backup string
}

// backupEnrollmentKeys moves identity.key and server.pub aside as *.old so enrollment can write new keys,
// replacing older backups. With replace false it changes nothing. The returned restore removes any key
// enrollment wrote and puts the moved files back, so a failed enrollment leaves the node unchanged.
func backupEnrollmentKeys(identityPath, serverKeyPath string, replace bool) (func() error, error) {
	if !replace {
		return func() error { return nil }, nil
	}
	moved := make([]movedKey, 0, 2)
	restore := func() error {
		var firstErr error
		keep := func(err error) {
			if err != nil && firstErr == nil {
				firstErr = err
			}
		}
		for i := len(moved) - 1; i >= 0; i-- {
			item := moved[i]
			if err := os.Remove(item.path); err != nil && !errors.Is(err, fs.ErrNotExist) {
				keep(err)
			}
			if item.backup == "" {
				continue
			}
			keep(os.Rename(item.backup, item.path))
		}
		return firstErr
	}
	for _, path := range []string{identityPath, serverKeyPath} {
		if _, err := os.Stat(path); err != nil {
			if !errors.Is(err, fs.ErrNotExist) {
				_ = restore()
				return nil, err
			}
			moved = append(moved, movedKey{path: path})
			continue
		}
		backup := path + ".old"
		if err := os.Remove(backup); err != nil && !errors.Is(err, fs.ErrNotExist) {
			_ = restore()
			return nil, err
		}
		if err := os.Rename(path, backup); err != nil {
			_ = restore()
			return nil, err
		}
		moved = append(moved, movedKey{path: path, backup: backup})
	}
	return restore, nil
}

// ParseToken splits crh1.<fingerprint>.<secret> into the fingerprint crhs's key must match and the
// one-time secret.
func ParseToken(token string) (fingerprint, secret string, err error) {
	parts := strings.Split(token, ".")
	if len(parts) != 3 || parts[0] != "crh1" || parts[1] == "" || parts[2] == "" {
		return "", "", errors.New("malformed enrollment token (expected crh1.<fingerprint>.<secret>)")
	}
	return parts[1], parts[2], nil
}

// fetchServerKey gets crhs's public key over HTTPS and accepts it only if it matches the token, so the
// token alone bootstraps trust (like kubeadm's discovery token CA hash).
func fetchServerKey(ctx context.Context, cfg *config.Config, fingerprint string) ([]byte, error) {
	u := strings.TrimSuffix(cfg.Server, "/") + "/agent/identity"
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, u, nil)
	if err != nil {
		return nil, err
	}
	client := http.DefaultClient
	if cfg.TLSVerify == config.TLSVerifyNone {
		client = &http.Client{Transport: &http.Transport{TLSClientConfig: &tls.Config{InsecureSkipVerify: true}}} //nolint:gosec // checked against the fingerprint below
	}
	resp, err := client.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("GET %s: %s", u, resp.Status)
	}
	var body struct{ PublicKey string }
	if err := json.NewDecoder(io.LimitReader(resp.Body, 4096)).Decode(&body); err != nil {
		return nil, fmt.Errorf("GET %s: %w", u, err)
	}
	key, err := base64.StdEncoding.DecodeString(body.PublicKey)
	if err != nil || len(key) != noise.KeyLen {
		return nil, errors.New("crhs returned a malformed public key")
	}
	if got := identity.Fingerprint(key); got != fingerprint {
		return nil, fmt.Errorf("crhs public key fingerprint %s does not match the token (%s): wrong server or interception", got, fingerprint)
	}
	return key, nil
}
