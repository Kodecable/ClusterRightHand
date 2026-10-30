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
	"strconv"
	"strings"
	"syscall"

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
	var configPath string
	cmd := &cobra.Command{
		Use:   "enroll <server-url> <token>",
		Short: "Enroll this node with a crhs server",
		Long: `Enroll this node: fetch crhs's public key, check it against the fingerprint in the token, create
this node's identity key and register it. An administrator (or the token's owner) then confirms the node
in the WebUI, comparing the fingerprint printed here. Writes a minimal config file if none exists.`,
		Args: cobra.ExactArgs(2),
		RunE: func(cmd *cobra.Command, args []string) error {
			return enroll(cmd.Context(), cmd.OutOrStdout(), configPath, args[0], args[1])
		},
	}
	cmd.Flags().StringVar(&configPath, "config", config.DefaultPath, "path to the config file")
	return cmd
}

func enroll(ctx context.Context, out io.Writer, configPath, serverURL, token string) error {
	fingerprint, secret, err := parseToken(token)
	if err != nil {
		return err
	}
	cfg, err := config.Load(configPath)
	if errors.Is(err, fs.ErrNotExist) {
		if err := writeMinimalConfig(configPath, serverURL); err != nil {
			return err
		}
		fmt.Fprintf(out, "wrote %s\n", configPath)
		cfg, err = config.Load(configPath)
	}
	if err != nil {
		return err
	}
	if _, err := os.Stat(cfg.IdentityKeyPath()); err == nil {
		return fmt.Errorf("%s exists: this node is already enrolled (remove it to enroll again)", cfg.IdentityKeyPath())
	}
	// The enrollment facts carry the shells the node discovered; a node without sh cannot run tasks.
	env, err := resolveEnv(execenv.Options{})
	if err != nil {
		return err
	}

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

func writeMinimalConfig(path, serverURL string) error {
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return err
	}
	content := fmt.Sprintf("server = %q\n", serverURL)
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
	cmd.Flags().StringVar(&configPath, "config", config.DefaultPath, "path to the config file")
	return cmd
}

func newReloadCmd() *cobra.Command {
	var configPath string
	cmd := &cobra.Command{
		Use:   "reload",
		Short: "Make the running crha re-read its configuration",
		Args:  cobra.NoArgs,
		RunE: func(cmd *cobra.Command, _ []string) error {
			cfg, err := config.Load(configPath)
			if err != nil {
				return err
			}
			data, err := os.ReadFile(filepath.Join(cfg.StateDir, "crha.pid"))
			if err != nil {
				return fmt.Errorf("is crha running? %w", err)
			}
			pid, err := strconv.Atoi(strings.TrimSpace(string(data)))
			if err != nil {
				return fmt.Errorf("bad pid file: %w", err)
			}
			if err := syscall.Kill(pid, syscall.SIGHUP); err != nil {
				return fmt.Errorf("signal crha (pid %d): %w", pid, err)
			}
			fmt.Fprintf(cmd.OutOrStdout(), "sent SIGHUP to crha (pid %d); see its log for the result\n", pid)
			return nil
		},
	}
	cmd.Flags().StringVar(&configPath, "config", config.DefaultPath, "path to the config file")
	return cmd
}

func newRotateKeyCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "rotate-key",
		Short: "Rotate the node key",
		Args:  cobra.NoArgs,
		RunE:  notImplemented,
	}
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

func newMCPCmd() *cobra.Command {
	var url, tokenFile string
	cmd := &cobra.Command{
		Use:   "mcp",
		Short: "Bridge MCP over stdio to the crhs HTTP endpoint",
		Args:  cobra.NoArgs,
		RunE:  notImplemented,
	}
	cmd.Flags().StringVar(&url, "url", "", "MCP endpoint URL")
	cmd.Flags().StringVar(&tokenFile, "token-file", "", "file containing the access token")
	return cmd
}
