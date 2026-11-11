package cli

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
	"github.com/Kodecable/ClusterRightHand/client/internal/identity"
	"github.com/Kodecable/ClusterRightHand/client/internal/noise"
	"github.com/Kodecable/ClusterRightHand/client/internal/protocol"
	"github.com/Kodecable/ClusterRightHand/client/internal/transport"
	"github.com/Kodecable/ClusterRightHand/client/internal/version"
	"github.com/spf13/cobra"
)

func newEnrollCmd() *cobra.Command {
	var configPath, stateDir string
	var replace bool
	cmd := &cobra.Command{
		Use:   "enroll <server-url> <token>",
		Short: "Enroll this node with a crhs server",
		Long: `Enroll this node: fetch crhs's public key, check it against the fingerprint in the token, create
this node's identity key and register it. An administrator then confirms the node
in the WebUI, comparing the fingerprint printed here. The configuration file must already exist and
set server and state_dir; when it does not exist, --state-dir creates it with that state directory
instead. --replace re-enrolls a node that already has keys: the old identity.key and server.pub are
moved aside as identity.key.old and server.pub.old, and restored if enrollment fails.`,
		Args: cobra.ExactArgs(2),
		RunE: func(cmd *cobra.Command, args []string) error {
			return enroll(cmd.Context(), cmd.OutOrStdout(), configPath, stateDir, args[0], args[1], replace)
		},
	}
	cmd.Flags().StringVar(&configPath, "config", "", "path to the config file (required)")
	_ = cmd.MarkFlagRequired("config")
	cmd.Flags().StringVar(&stateDir, "state-dir", "", "state directory of a created config (only when --config does not exist; absolute)")
	cmd.Flags().BoolVar(&replace, "replace", false, "replace an existing identity key and server key (re-enrollment)")
	return cmd
}

func enroll(ctx context.Context, out io.Writer, configPath, stateDir, serverURL, token string, replace bool) (err error) {
	fingerprint, secret, err := parseToken(token)
	if err != nil {
		return err
	}
	if stateDir != "" && !filepath.IsAbs(stateDir) {
		return fmt.Errorf("--state-dir %q must be an absolute path", stateDir)
	}
	cfg, err := config.Load(configPath)
	if errors.Is(err, fs.ErrNotExist) {
		if stateDir == "" {
			return fmt.Errorf("config %s does not exist: pass --state-dir to create it, or write the file first", configPath)
		}
		if err := writeMinimalConfig(configPath, serverURL, stateDir); err != nil {
			return err
		}
		fmt.Fprintf(out, "wrote %s\n", configPath)
		cfg, err = config.Load(configPath)
	} else if err == nil && stateDir != "" {
		return fmt.Errorf("--state-dir only applies when creating a new config: %s exists", configPath)
	}
	if err != nil {
		return err
	}
	if _, err := os.Stat(cfg.IdentityKeyPath()); err == nil && !replace {
		return fmt.Errorf("%s exists: this node is already enrolled (pass --replace to re-enroll it with a new key)", cfg.IdentityKeyPath())
	}
	// The enrollment facts carry the shells the node discovered; a node without sh cannot run tasks.
	env, err := resolveEnv(execenv.Options{})
	if err != nil {
		return err
	}
	// Everything that does not touch the state directory has been checked. A failed enrollment puts the
	// previous keys back, so the node is unchanged.
	restore, err := backupEnrollmentKeys(cfg, replace)
	if err != nil {
		return err
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
		return err
	}
	key, err := noise.GenerateKeypair()
	if err != nil {
		return err
	}
	hostname, _ := os.Hostname()
	init := &protocol.HandshakeInit{
		CRHAVersion: version.Version,
		Enroll: &protocol.Enrollment{
			TokenSecret: secret,
			Hostname:    protocol.CleanText(hostname),
			Facts:       nodeFacts(cfg, env),
		},
	}
	conn, err := transport.Dial(ctx, dialOptions(cfg, key, serverKey, init))
	if err != nil {
		return fmt.Errorf("enroll: %w", err)
	}
	defer conn.Close("enrolled")
	// Only now persist the keys: a rejected token leaves no half-enrolled state behind.
	if err := identity.SaveServerKey(cfg.ServerKeyPath(), serverKey); err != nil {
		return err
	}
	if err := identity.SaveKeypair(cfg.IdentityKeyPath(), key); err != nil {
		return err
	}
	fmt.Fprintf(out, "enrolled as node %s, waiting for approval\nnode key fingerprint: %s\n",
		conn.Response.NodeID, identity.Fingerprint(key.Public))
	return nil
}

// movedKey is one key file backupEnrollmentKeys moved aside. backup is empty when the file did not exist.
type movedKey struct {
	path   string
	backup string
}

// backupEnrollmentKeys moves identity.key and server.pub aside as *.old so enrollment can write new keys,
// replacing older backups. With replace false it changes nothing. The returned restore removes any key
// enrollment wrote and puts the moved files back, so a failed enrollment leaves the node unchanged.
func backupEnrollmentKeys(cfg *config.Config, replace bool) (func() error, error) {
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
	for _, path := range []string{cfg.IdentityKeyPath(), cfg.ServerKeyPath()} {
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

func parseToken(token string) (fingerprint, secret string, err error) {
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

// writeMinimalConfig creates the configuration of a one-command enrollment. --state-dir has no
// default, so its value is written explicitly; config.Parse validates the result before it is
// written.
func writeMinimalConfig(path, serverURL, stateDir string) error {
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return err
	}
	content := fmt.Sprintf("server = %q\nstate_dir = %q\n", serverURL, stateDir)
	if _, err := config.Parse([]byte(content)); err != nil {
		return err
	}
	return os.WriteFile(path, []byte(content), 0o644)
}

func newStatusCmd() *cobra.Command {
	var configPath string
	cmd := &cobra.Command{
		Use:   "status",
		Short: "Show this node's identity and configuration",
		Args:  cobra.NoArgs,
		RunE: func(cmd *cobra.Command, _ []string) error {
			cfg, err := config.Load(configPath)
			if err != nil {
				return err
			}
			out := cmd.OutOrStdout()
			fmt.Fprintf(out, "server:          %s\n", cfg.AgentURL())
			if key, err := identity.LoadKeypair(cfg.IdentityKeyPath()); err == nil {
				fmt.Fprintf(out, "node key:        %s\n", identity.Fingerprint(key.Public))
			} else {
				fmt.Fprintf(out, "node key:        not enrolled (%v)\n", err)
			}
			if key, err := identity.LoadServerKey(cfg.ServerKeyPath()); err == nil {
				fmt.Fprintf(out, "server key:      %s\n", identity.Fingerprint(key))
			}
			fmt.Fprintf(out, "privileged mode: %s\n", cfg.Privilege.Mode)
			return nil
		},
	}
	cmd.Flags().StringVar(&configPath, "config", "", "path to the config file (required)")
	_ = cmd.MarkFlagRequired("config")
	return cmd
}

func newUpgradeCmd() *cobra.Command {
	var apply string
	cmd := &cobra.Command{
		Use:   "upgrade",
		Short: "Apply a crha binary upgrade",
		Args:  cobra.NoArgs,
		RunE:  notImplemented,
	}
	cmd.Flags().StringVar(&apply, "apply", "", "path to the new crha binary")
	_ = cmd.MarkFlagRequired("apply")
	return cmd
}
