package crhu

import (
	"bufio"
	"bytes"
	"encoding/base64"
	"encoding/pem"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"strings"

	"github.com/spf13/cobra"
	"golang.org/x/crypto/ssh"

	"github.com/Kodecable/ClusterRightHand/client/internal/privileged/authz"
	"github.com/Kodecable/ClusterRightHand/client/internal/protocol"
)

// signOptions are the flags of `crhu sign`.
type signOptions struct {
	payload string
	keys    keyChoice
}

// sshKeygen is the signing program. It is located through PATH when signing; tests replace it with
// a fake.
var sshKeygen = "ssh-keygen"

// openTerminal opens the controlling terminal for confirmation and key selection. Tests replace it.
var openTerminal = func() (io.ReadWriteCloser, error) {
	return os.OpenFile("/dev/tty", os.O_RDWR, 0)
}

func newSignCmd() *cobra.Command {
	opts := &signOptions{}
	cmd := &cobra.Command{
		Use:   "sign",
		Short: "Sign an authorization payload from the WebUI",
		Long: `Sign the payload of a WebUI authorization request and print the signed authorization.

--payload is the base64 payload the WebUI shows. The exact bytes are signed with
"ssh-keygen -Y sign -n crh-auth-v1", so encrypted keys, ssh-agent and FIDO touches work; crhu never
reads the private key itself. The payload is shown and confirmed first. The printed line is what the
WebUI accepts (POST /api/authorizations).`,
		Args: cobra.NoArgs,
		RunE: func(cmd *cobra.Command, _ []string) error {
			return runSign(cmd, opts)
		},
	}
	cmd.Flags().StringVar(&opts.payload, "payload", "", "base64 payload from the WebUI")
	opts.keys.addFlags(cmd.Flags(), true)
	return cmd
}

// runSign decodes the WebUI payload, shows it, asks for confirmation and prints the signed
// authorization.
func runSign(cmd *cobra.Command, opts *signOptions) error {
	if strings.TrimSpace(opts.payload) == "" {
		return errors.New("sign: --payload is required")
	}
	payload, raw, err := decodePayload(opts.payload)
	if err != nil {
		return err
	}
	return signAuthorization(cmd, &opts.keys, "sign", payload, raw)
}

// decodePayload decodes the base64 payload of a WebUI authorization request. The protocol decoder
// applies the structural rules of doc/design/protocol.md "Authorization object".
func decodePayload(text string) (*protocol.AuthorizationPayload, []byte, error) {
	raw, err := base64.StdEncoding.DecodeString(strings.TrimSpace(text))
	if err != nil {
		return nil, nil, fmt.Errorf("sign: --payload is not base64: %w", err)
	}
	payload, err := protocol.DecodeAuthorizationPayload(raw)
	if err != nil {
		return nil, nil, fmt.Errorf("sign: --payload: %w", err)
	}
	if payload.TaskIDs != nil {
		if err := checkOneShotNodes(payload.Nodes, *payload.TaskIDs); err != nil {
			return nil, nil, fmt.Errorf("sign: --payload: %w", err)
		}
	}
	// The privileged mode rejects an authorization without a deadline; refuse it here, before the
	// user confirms and signs it.
	if payload.DeadlineMS == nil {
		return nil, nil, errors.New("sign: --payload has no deadline; every authorization must carry one")
	}
	return payload, raw, nil
}

// confirmAuthorization asks on the controlling terminal. Without one it refuses: signing a
// payload the user has not seen would defeat the confirmation.
func confirmAuthorization(command string) (bool, error) {
	terminal, err := openTerminal()
	if err != nil {
		return false, fmt.Errorf("%s: no terminal to confirm the authorization, rerun with --yes: %w", command, err)
	}
	defer terminal.Close()
	if _, err := io.WriteString(terminal, "Sign this authorization? [y/N] "); err != nil {
		return false, fmt.Errorf("%s: ask for confirmation: %w", command, err)
	}
	line, err := bufio.NewReader(terminal).ReadString('\n')
	if err != nil && line == "" {
		return false, fmt.Errorf("%s: read the confirmation: %w", command, err)
	}
	switch strings.ToLower(strings.TrimSpace(line)) {
	case "y", "yes":
		return true, nil
	}
	return false, nil
}

// signPayload runs ssh-keygen -Y sign with the payload on stdin and returns the SSHSIG blob and the
// signer's key. The signature is verified locally in the given namespace before it is used, and the
// key file must hold the key that signed.
func signPayload(payload []byte, keyPath, namespace, command string) ([]byte, ssh.PublicKey, error) {
	program, err := exec.LookPath(sshKeygen)
	if err != nil {
		return nil, nil, fmt.Errorf("%s: ssh-keygen is required to sign: %w", command, err)
	}
	cmd := exec.Command(program, "-Y", "sign", "-n", namespace, "-f", keyPath)
	cmd.Stdin = bytes.NewReader(payload)
	var stdout, stderr bytes.Buffer
	cmd.Stdout, cmd.Stderr = &stdout, &stderr
	if err := cmd.Run(); err != nil {
		if message := strings.TrimSpace(stderr.String()); message != "" {
			return nil, nil, fmt.Errorf("%s: ssh-keygen -Y sign: %w: %s", command, err, message)
		}
		return nil, nil, fmt.Errorf("%s: ssh-keygen -Y sign: %w", command, err)
	}
	blob, err := dearmorSignature(stdout.Bytes())
	if err != nil {
		return nil, nil, fmt.Errorf("%s: %w", command, err)
	}
	result, err := authz.VerifySSHSIGNamespace(blob, payload, namespace)
	if err != nil {
		return nil, nil, fmt.Errorf("%s: the signature from ssh-keygen does not verify: %w", command, err)
	}
	if err := checkSignerKey(program, keyPath, result.PublicKey, command); err != nil {
		return nil, nil, err
	}
	return blob, result.PublicKey, nil
}

// dearmorSignature decodes the PEM armor ssh-keygen wraps an SSHSIG blob in.
func dearmorSignature(data []byte) ([]byte, error) {
	block, rest := pem.Decode(data)
	if block == nil {
		return nil, errors.New("ssh-keygen printed no SSH signature")
	}
	if block.Type != "SSH SIGNATURE" {
		return nil, fmt.Errorf("ssh-keygen printed a %q block, want SSH SIGNATURE", block.Type)
	}
	if len(bytes.TrimSpace(rest)) != 0 {
		return nil, errors.New("ssh-keygen printed trailing data after the signature")
	}
	return block.Bytes, nil
}

// checkSignerKey makes sure the key file holds the key that signed. crhu never reads a private key
// itself, so ssh-keygen reports the public key; for a private key file it takes the unencrypted
// public part, so no passphrase is asked for.
func checkSignerKey(program, keyPath string, signer ssh.PublicKey, command string) error {
	cmd := exec.Command(program, "-l", "-f", keyPath)
	var stdout, stderr bytes.Buffer
	cmd.Stdout, cmd.Stderr = &stdout, &stderr
	if err := cmd.Run(); err != nil {
		return fmt.Errorf("%s: cannot determine the public key of %s: %w: %s",
			command, keyPath, err, strings.TrimSpace(stderr.String()))
	}
	want := ssh.FingerprintSHA256(signer)
	for _, field := range strings.Fields(stdout.String()) {
		if !strings.HasPrefix(field, "SHA256:") {
			continue
		}
		if field != want {
			return fmt.Errorf("%s: %s holds key %s, but the signature is from %s", command, keyPath, field, want)
		}
		return nil
	}
	return fmt.Errorf("%s: ssh-keygen did not report a fingerprint for %s", command, keyPath)
}
