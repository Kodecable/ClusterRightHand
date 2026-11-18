package crhu

import (
	"bytes"
	"encoding/base64"
	"errors"
	"fmt"
	"strings"

	"github.com/spf13/cobra"
	"golang.org/x/crypto/ssh"

	"github.com/Kodecable/ClusterRightHand/client/internal/protocol"
)

// registrationPrefix is the first line of every registration challenge; crhu signs nothing else.
const registrationPrefix = protocol.RegisterNamespace + "\n"

// registerOptions are the flags of `crhu register`.
type registerOptions struct {
	challenge string
	keys      keyChoice
}

func newRegisterCmd() *cobra.Command {
	opts := &registerOptions{}
	cmd := &cobra.Command{
		Use:   "register <challenge>",
		Short: "Sign a signing-credential registration challenge for the WebUI",
		Long: `Sign the challenge the WebUI shows when registering an SSH signing credential.

The challenge is the base64url value from "POST /api/me/signing-credentials/ssh/challenge". crhu
signs the decoded bytes with "ssh-keygen -Y sign -n crh-register-v1" and prints the base64 SSHSIG
to paste into the WebUI. It never reads the private key; OpenSSH handles encrypted keys, ssh-agent
and FIDO touches.`,
		Args: cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			opts.challenge = args[0]
			return runRegister(cmd, opts)
		},
	}
	opts.keys.addFlags(cmd.Flags(), false)
	return cmd
}

// runRegister decodes the challenge, signs its exact bytes and prints the SSHSIG as base64.
func runRegister(cmd *cobra.Command, opts *registerOptions) error {
	challenge, err := decodeChallenge(opts.challenge)
	if err != nil {
		return err
	}
	if !bytes.HasPrefix(challenge, []byte(registrationPrefix)) {
		return errors.New("register: the challenge is not a " + protocol.RegisterNamespace + " registration challenge")
	}
	candidate, err := opts.keys.signer("register")
	if err != nil {
		return err
	}
	keyPath, cleanup, err := candidate.signerPath()
	if err != nil {
		return fmt.Errorf("register: %w", err)
	}
	defer cleanup()
	blob, signer, err := signPayload(challenge, keyPath, protocol.RegisterNamespace, "register")
	if err != nil {
		return err
	}
	fmt.Fprintln(cmd.OutOrStdout(), base64.StdEncoding.EncodeToString(blob))
	fmt.Fprintf(cmd.ErrOrStderr(), "signed with %s %s\n", signer.Type(), ssh.FingerprintSHA256(signer))
	fmt.Fprintln(cmd.ErrOrStderr(), "paste the line above into the WebUI to register the key")
	return nil
}

// decodeChallenge accepts the base64url challenge the API returns and, for convenience, the same
// bytes in standard base64. The decoded challenge is what is signed.
func decodeChallenge(text string) ([]byte, error) {
	compact := strings.TrimSpace(text)
	if compact == "" {
		return nil, errors.New("register: the challenge is empty")
	}
	for _, encoding := range []*base64.Encoding{
		base64.RawURLEncoding,
		base64.URLEncoding,
		base64.StdEncoding,
		base64.RawStdEncoding,
	} {
		raw, err := encoding.DecodeString(compact)
		if err == nil && len(raw) > 0 {
			return raw, nil
		}
	}
	return nil, errors.New("register: the challenge is not base64")
}
