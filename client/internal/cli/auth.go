package cli

import (
	"bufio"
	"bytes"
	"context"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"encoding/pem"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"strings"
	"time"

	"github.com/spf13/cobra"
	"golang.org/x/crypto/ssh"

	"github.com/Kodecable/ClusterRightHand/client/internal/privileged/authz"
	"github.com/Kodecable/ClusterRightHand/client/internal/privileged/localclient"
	"github.com/Kodecable/ClusterRightHand/client/internal/protocol"
	"github.com/Kodecable/ClusterRightHand/client/internal/version"
)

// grantOptions are the flags of `crha grant`.
type grantOptions struct {
	payload    string
	nodes      []string
	method     string
	anyCommand bool
	exact      string
	specSHA256 string
	prefix     string
	deadline   string
	tasks      []string
	attempt    uint64
	note       string
	key        string
	yes        bool
}

// sshKeygen is the signing program of `crha grant`. It is located through PATH when signing;
// tests replace it with a fake.
var sshKeygen = "ssh-keygen"

// openTerminal opens the controlling terminal for the confirmation prompt. Tests replace it.
var openTerminal = func() (io.ReadWriteCloser, error) {
	return os.OpenFile("/dev/tty", os.O_RDWR, 0)
}

func newGrantCmd() *cobra.Command {
	opts := &grantOptions{}
	cmd := &cobra.Command{
		Use:   "grant",
		Short: "Sign an authorization for privileged tasks",
		Long: `Sign an authorization with an SSH key and print it as base64.

With --payload the payload of a WebUI authorization request is signed. Without it the flags
build a new payload: --nodes gives the node or node group UUIDs the authorization is for, --method
with --exact or --prefix restricts what it allows, --deadline (required) bounds how long it can be
used, and --task makes it one-shot. Every authorization carries a deadline.

The payload is shown and confirmed before signing. crha runs
"ssh-keygen -Y sign -n crh-auth-v1" with the payload on stdin and never reads the private key
itself, so OpenSSH handles encrypted keys, ssh-agent and FIDO touches. The printed line is what
the WebUI accepts (POST /api/authorizations).`,
		Args: cobra.NoArgs,
		RunE: func(cmd *cobra.Command, _ []string) error {
			return runGrant(cmd, opts)
		},
	}
	f := cmd.Flags()
	f.StringVar(&opts.payload, "payload", "", "base64 payload from the WebUI")
	f.StringSliceVar(&opts.nodes, "nodes", nil, `node or node group UUIDs, or "*"`)
	f.StringVar(&opts.method, "method", "", "exec, file.read or file.write")
	f.BoolVar(&opts.anyCommand, "any-command", false, "do not restrict the method and target")
	f.StringVar(&opts.exact, "exact", "", "allow exactly this target")
	f.StringVar(&opts.specSHA256, "spec-sha256", "", "hex SHA-256 of the complete task spec (with --exact)")
	f.StringVar(&opts.prefix, "prefix", "", "allow targets starting with this prefix")
	f.StringVar(&opts.deadline, "deadline", "", "deadline (required): a duration (24h) or an RFC 3339 time")
	f.StringArrayVar(&opts.tasks, "task", nil, "bind the authorization to a task id (repeatable)")
	f.Uint64Var(&opts.attempt, "attempt", 0, "task attempt (default 1 with --task)")
	f.StringVar(&opts.note, "note", "", "note shown with the authorization; it is signed")
	f.StringVar(&opts.key, "key", "", "path to the signing SSH key")
	f.BoolVar(&opts.yes, "yes", false, "do not ask for confirmation")
	cmd.MarkFlagsMutuallyExclusive("exact", "prefix")
	return cmd
}

// runGrant shows the payload, asks for confirmation and prints the signed authorization.
func runGrant(cmd *cobra.Command, opts *grantOptions) error {
	stdout, stderr := cmd.OutOrStdout(), cmd.ErrOrStderr()
	payload, raw, err := grantPayload(opts)
	if err != nil {
		return err
	}
	view, err := json.MarshalIndent(grantViewFor(payload, raw), "", "  ")
	if err != nil {
		return err
	}
	fmt.Fprintf(stderr, "%s\n", view)

	if !opts.yes {
		confirmed, err := confirmGrant()
		if err != nil {
			return err
		}
		if !confirmed {
			return errors.New("grant: the authorization was not signed")
		}
	}

	blob, signer, err := signPayload(raw, opts.key)
	if err != nil {
		return err
	}
	authorization := protocol.Authorization{
		Payload: raw,
		Signatures: []protocol.Signature{{
			Kind:   protocol.SignatureSSHSig,
			SSHSig: &protocol.SSHSigSignature{Blob: blob},
		}},
	}
	encoded, err := protocol.Marshal(&authorization)
	if err != nil {
		return fmt.Errorf("grant: encode the authorization: %w", err)
	}
	fmt.Fprintln(stdout, base64.StdEncoding.EncodeToString(encoded))
	fmt.Fprintf(stderr, "signed with %s %s\n", signer.Type(), ssh.FingerprintSHA256(signer))
	fmt.Fprintln(stderr, "paste the line above into CRH (POST /api/authorizations)")
	return nil
}

// grantPayload returns the payload to sign and its canonical bytes: the --payload of a WebUI
// authorization request, or one built from the flags.
func grantPayload(opts *grantOptions) (*protocol.AuthorizationPayload, []byte, error) {
	if err := opts.validate(); err != nil {
		return nil, nil, err
	}
	if opts.payload != "" {
		return decodeGrantPayload(opts.payload)
	}
	payload, err := buildPayload(opts, time.Now())
	if err != nil {
		return nil, nil, err
	}
	raw, err := protocol.Marshal(payload)
	if err != nil {
		return nil, nil, fmt.Errorf("grant: encode the payload: %w", err)
	}
	return payload, raw, nil
}

// validate checks the flags before anything is shown or signed.
func (o *grantOptions) validate() error {
	if o.key == "" {
		return errors.New("grant: --key is required")
	}
	if o.payload != "" {
		switch {
		case len(o.nodes) > 0:
			return errors.New("grant: --payload and --nodes cannot be combined")
		case o.method != "" || o.exact != "" || o.prefix != "" || o.specSHA256 != "" || o.anyCommand:
			return errors.New("grant: --payload cannot be combined with the command restriction flags")
		case o.deadline != "" || len(o.tasks) > 0 || o.attempt != 0 || o.note != "":
			return errors.New("grant: --payload cannot be combined with the payload building flags")
		}
		return nil
	}
	// Every authorization the flags build must expire. Without a deadline it could be used
	// forever and the privileged mode refuses it anyway.
	if o.deadline == "" {
		return errors.New("grant: --deadline is required")
	}
	if len(o.nodes) == 0 {
		return errors.New("grant: --nodes or --payload is required")
	}
	switch {
	case o.anyCommand:
		if o.method != "" {
			return errors.New("grant: --any-command and --method cannot be combined")
		}
	case o.method == "":
		return errors.New("grant: --method is required unless --any-command is given")
	case o.exact == "" && o.prefix == "":
		return errors.New("grant: --method needs --exact or --prefix")
	}
	switch {
	case o.exact != "" && o.specSHA256 == "":
		return errors.New("grant: --exact requires --spec-sha256")
	case o.specSHA256 != "" && o.exact == "":
		return errors.New("grant: --spec-sha256 requires --exact")
	case o.anyCommand && (o.exact != "" || o.prefix != "" || o.specSHA256 != ""):
		return errors.New("grant: --any-command cannot be combined with --exact, --prefix or --spec-sha256")
	}
	if len(o.tasks) > 0 {
		if err := checkOneShotNodes(o.nodes, o.tasks); err != nil {
			return err
		}
	} else if o.attempt != 0 {
		return errors.New("grant: --attempt requires --task")
	}
	return nil
}

// checkOneShotNodes enforces the per-position node binding of a one-shot authorization
// (doc/protocol.md 授权对象): every task id needs exactly one node id, in the same order, and
// neither a group nor "*" can stand for a node.
func checkOneShotNodes(nodes, tasks []string) error {
	if len(nodes) != len(tasks) {
		return fmt.Errorf("grant: --task needs one --nodes node id per task, got %d node(s) for %d task(s)", len(nodes), len(tasks))
	}
	for _, node := range nodes {
		if node == "*" || !protocol.IsUUID(node) {
			return fmt.Errorf("grant: --task needs node UUIDs in --nodes, not %q", node)
		}
	}
	return nil
}

// decodeGrantPayload decodes the base64 payload of a WebUI authorization request. The protocol
// decoder applies the structural rules of doc/protocol.md 授权对象.
func decodeGrantPayload(text string) (*protocol.AuthorizationPayload, []byte, error) {
	raw, err := base64.StdEncoding.DecodeString(strings.TrimSpace(text))
	if err != nil {
		return nil, nil, fmt.Errorf("grant: --payload is not base64: %w", err)
	}
	payload, err := protocol.DecodeAuthorizationPayload(raw)
	if err != nil {
		return nil, nil, fmt.Errorf("grant: --payload: %w", err)
	}
	if payload.TaskIDs != nil {
		if err := checkOneShotNodes(payload.Nodes, *payload.TaskIDs); err != nil {
			return nil, nil, fmt.Errorf("grant: --payload: %w", err)
		}
	}
	// The privileged mode rejects an authorization without a deadline; refuse it here, before
	// the user confirms and signs it.
	if payload.DeadlineMS == nil {
		return nil, nil, errors.New("grant: --payload has no deadline; every authorization must carry one")
	}
	return payload, raw, nil
}

// buildPayload constructs an authorization payload from the flags. It is issued now.
func buildPayload(opts *grantOptions, now time.Time) (*protocol.AuthorizationPayload, error) {
	nodes, err := grantNodes(opts.nodes)
	if err != nil {
		return nil, err
	}
	payload := &protocol.AuthorizationPayload{
		V:          protocol.AuthPayloadVersion,
		Nodes:      nodes,
		IssuedAtMS: protocol.Int(now.UnixMilli()),
		Note:       opts.note,
	}
	if !opts.anyCommand {
		method, err := grantMethod(opts.method)
		if err != nil {
			return nil, err
		}
		command := &protocol.AuthCommand{Method: method}
		switch {
		case opts.exact != "":
			hash, err := parseSpecSHA256(opts.specSHA256)
			if err != nil {
				return nil, err
			}
			command.Match = protocol.AuthMatch{
				Kind:  protocol.AuthMatchExact,
				Exact: &protocol.AuthExact{Target: opts.exact, SpecSHA256: protocol.Hash(hash)},
			}
		case opts.prefix != "":
			command.Match = protocol.AuthMatch{
				Kind:   protocol.AuthMatchPrefix,
				Prefix: &protocol.AuthPrefix{Target: opts.prefix},
			}
		}
		payload.Command = command
	}
	if opts.deadline != "" {
		deadline, err := parseDeadline(opts.deadline, now)
		if err != nil {
			return nil, err
		}
		ms := protocol.Int(deadline.UnixMilli())
		payload.DeadlineMS = &ms
	}
	if len(opts.tasks) > 0 {
		tasks := append([]string{}, opts.tasks...)
		attempt := opts.attempt
		if attempt == 0 {
			attempt = 1
		}
		value := protocol.Uint(attempt)
		payload.TaskIDs, payload.Attempt = &tasks, &value
	}
	return payload, nil
}

// grantNodes validates the --nodes the authorization is addressed to: node or node group UUIDs, or
// exactly "*". Names and the removed "group:<name>" syntax are refused here.
func grantNodes(in []string) ([]string, error) {
	nodes := make([]string, 0, len(in))
	seen := make(map[string]struct{}, len(in))
	for _, node := range in {
		node = strings.TrimSpace(node)
		if node == "" {
			return nil, errors.New("grant: --nodes contains an empty node")
		}
		if node != "*" && !protocol.IsUUID(node) {
			if strings.HasPrefix(node, "group:") {
				return nil, fmt.Errorf(`grant: --nodes no longer accepts %q; use node or node group UUIDs, or "*"`, node)
			}
			return nil, fmt.Errorf("grant: --nodes %q is not a node or node group UUID (names are not accepted)", node)
		}
		if _, dup := seen[node]; dup {
			return nil, fmt.Errorf("grant: --nodes repeats %q", node)
		}
		seen[node] = struct{}{}
		nodes = append(nodes, node)
	}
	if _, star := seen["*"]; star && len(nodes) > 1 {
		return nil, errors.New(`grant: "*" must be the only node`)
	}
	return nodes, nil
}

// grantMethod validates --method.
func grantMethod(name string) (protocol.Method, error) {
	method := protocol.Method(name)
	switch method {
	case protocol.MethodExec, protocol.MethodFileRead, protocol.MethodFileWrite:
		return method, nil
	default:
		return "", fmt.Errorf("grant: --method %q is not exec, file.read or file.write", name)
	}
}

// parseSpecSHA256 parses the hex spec hash of an exact authorization.
func parseSpecSHA256(text string) ([32]byte, error) {
	var hash [32]byte
	raw, err := hex.DecodeString(text)
	if err != nil || len(raw) != len(hash) {
		return hash, fmt.Errorf("grant: --spec-sha256 %q is not 32 bytes of hex", text)
	}
	copy(hash[:], raw)
	return hash, nil
}

// parseDeadline parses --deadline: a positive duration from now, or an RFC 3339 time in the
// future.
func parseDeadline(text string, now time.Time) (time.Time, error) {
	if d, err := time.ParseDuration(text); err == nil {
		if d <= 0 {
			return time.Time{}, fmt.Errorf("grant: --deadline %q must be in the future", text)
		}
		return now.Add(d), nil
	}
	deadline, err := time.Parse(time.RFC3339, text)
	if err != nil {
		return time.Time{}, fmt.Errorf("grant: --deadline %q is neither a duration nor an RFC 3339 time", text)
	}
	if !deadline.After(now) {
		return time.Time{}, fmt.Errorf("grant: --deadline %q is in the past", text)
	}
	return deadline, nil
}

// grantView is the human-readable form of a payload: what the user confirms before signing.
type grantView struct {
	Nodes           []string      `json:"nodes"`
	Command         *grantCommand `json:"command"`
	IssuedAt        string        `json:"issued_at"`
	IssuedAtMS      int64         `json:"issued_at_ms"`
	Deadline        *string       `json:"deadline"`
	DeadlineMS      *int64        `json:"deadline_ms"`
	TaskIDs         []string      `json:"task_ids"`
	Attempt         *uint64       `json:"attempt"`
	Note            string        `json:"note"`
	AuthorizationID string        `json:"authorization_id"`
}

// grantCommand is the command restriction of a payload as shown to the user.
type grantCommand struct {
	Method     string `json:"method"`
	Match      string `json:"match"`
	Target     string `json:"target"`
	SpecSHA256 string `json:"spec_sha256,omitempty"`
}

// grantViewFor renders a payload for confirmation. Times are RFC 3339 with milliseconds; the
// raw millisecond values are repeated for exact comparison.
func grantViewFor(payload *protocol.AuthorizationPayload, raw []byte) grantView {
	id := protocol.AuthorizationID(raw)
	view := grantView{
		Nodes:           append([]string{}, payload.Nodes...),
		IssuedAt:        formatMillis(int64(payload.IssuedAtMS)),
		IssuedAtMS:      int64(payload.IssuedAtMS),
		Note:            payload.Note,
		AuthorizationID: hex.EncodeToString(id[:]),
	}
	if command := payload.Command; command != nil {
		shown := &grantCommand{Method: string(command.Method)}
		switch match := command.Match; match.Kind {
		case protocol.AuthMatchExact:
			if match.Exact != nil {
				shown.Match, shown.Target = "exact", match.Exact.Target
				shown.SpecSHA256 = hex.EncodeToString(match.Exact.SpecSHA256[:])
			}
		case protocol.AuthMatchPrefix:
			if match.Prefix != nil {
				shown.Match, shown.Target = "prefix", match.Prefix.Target
			}
		}
		view.Command = shown
	}
	if payload.DeadlineMS != nil {
		text := formatMillis(int64(*payload.DeadlineMS))
		ms := int64(*payload.DeadlineMS)
		view.Deadline, view.DeadlineMS = &text, &ms
	}
	if payload.TaskIDs != nil {
		view.TaskIDs = append([]string{}, (*payload.TaskIDs)...)
	}
	if payload.Attempt != nil {
		attempt := uint64(*payload.Attempt)
		view.Attempt = &attempt
	}
	return view
}

// formatMillis renders a Unix millisecond timestamp as RFC 3339 with milliseconds.
func formatMillis(ms int64) string {
	return time.UnixMilli(ms).Format("2006-01-02T15:04:05.000Z07:00")
}

// confirmGrant asks on the controlling terminal. Without one it refuses: signing a payload the
// user has not seen would defeat the confirmation.
func confirmGrant() (bool, error) {
	terminal, err := openTerminal()
	if err != nil {
		return false, fmt.Errorf("grant: no terminal to confirm the authorization, rerun with --yes: %w", err)
	}
	defer terminal.Close()
	if _, err := io.WriteString(terminal, "Sign this authorization? [y/N] "); err != nil {
		return false, fmt.Errorf("grant: ask for confirmation: %w", err)
	}
	line, err := bufio.NewReader(terminal).ReadString('\n')
	if err != nil && line == "" {
		return false, fmt.Errorf("grant: read the confirmation: %w", err)
	}
	switch strings.ToLower(strings.TrimSpace(line)) {
	case "y", "yes":
		return true, nil
	}
	return false, nil
}

// signPayload runs ssh-keygen -Y sign with the payload on stdin and returns the SSHSIG blob and
// the signer's key. The signature is verified locally before it is used, and the key file must
// hold the key that signed.
func signPayload(payload []byte, keyPath string) ([]byte, ssh.PublicKey, error) {
	program, err := exec.LookPath(sshKeygen)
	if err != nil {
		return nil, nil, fmt.Errorf("grant: ssh-keygen is required to sign: %w", err)
	}
	cmd := exec.Command(program, "-Y", "sign", "-n", protocol.AuthNamespace, "-f", keyPath)
	cmd.Stdin = bytes.NewReader(payload)
	var stdout, stderr bytes.Buffer
	cmd.Stdout, cmd.Stderr = &stdout, &stderr
	if err := cmd.Run(); err != nil {
		if message := strings.TrimSpace(stderr.String()); message != "" {
			return nil, nil, fmt.Errorf("grant: ssh-keygen -Y sign: %w: %s", err, message)
		}
		return nil, nil, fmt.Errorf("grant: ssh-keygen -Y sign: %w", err)
	}
	blob, err := dearmorSignature(stdout.Bytes())
	if err != nil {
		return nil, nil, fmt.Errorf("grant: %w", err)
	}
	result, err := authz.VerifySSHSIG(blob, payload)
	if err != nil {
		return nil, nil, fmt.Errorf("grant: the signature from ssh-keygen does not verify: %w", err)
	}
	if err := checkSignerKey(program, keyPath, result.PublicKey); err != nil {
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

// checkSignerKey makes sure the key file holds the key that signed. crha never reads a private
// key itself, so ssh-keygen reports the public key; for a private key file it takes the
// unencrypted public part, so no passphrase is asked for.
func checkSignerKey(program, keyPath string, signer ssh.PublicKey) error {
	cmd := exec.Command(program, "-l", "-f", keyPath)
	var stdout, stderr bytes.Buffer
	cmd.Stdout, cmd.Stderr = &stdout, &stderr
	if err := cmd.Run(); err != nil {
		return fmt.Errorf("grant: cannot determine the public key of %s: %w: %s",
			keyPath, err, strings.TrimSpace(stderr.String()))
	}
	want := ssh.FingerprintSHA256(signer)
	for _, field := range strings.Fields(stdout.String()) {
		if !strings.HasPrefix(field, "SHA256:") {
			continue
		}
		if field != want {
			return fmt.Errorf("grant: %s holds key %s, but the signature is from %s", keyPath, field, want)
		}
		return nil
	}
	return fmt.Errorf("grant: ssh-keygen did not report a fingerprint for %s", keyPath)
}

// defaultApprovalSocket is the socket `crha pending`, `crha approve` and `crha deny` try when
// neither --socket nor CRHA_PRIVILEGED_SOCKET is set. It exists only for manual local approval
// typed on the node; nothing else in crha may use it.
const defaultApprovalSocket = "/run/crha/privileged.sock"

// approvalSocketEnv overrides defaultApprovalSocket for the local approval commands.
const approvalSocketEnv = "CRHA_PRIVILEGED_SOCKET"

// approvalSocketUsage is the --socket help of the local approval commands.
const approvalSocketUsage = "path to the privileged mode's socket (default: $" + approvalSocketEnv + " or " + defaultApprovalSocket + ")"

// resolveApprovalSocket resolves the socket of the local approval commands. An explicitly set
// --socket wins, then a non-empty CRHA_PRIVILEGED_SOCKET, then defaultApprovalSocket.
func resolveApprovalSocket(flagValue string, flagSet bool) string {
	if flagSet {
		return flagValue
	}
	if value := os.Getenv(approvalSocketEnv); value != "" {
		return value
	}
	return defaultApprovalSocket
}

func newPendingCmd() *cobra.Command {
	var socketPath string
	cmd := &cobra.Command{
		Use:   "pending",
		Short: "List tasks pending local approval",
		Args:  cobra.NoArgs,
		RunE: func(cmd *cobra.Command, _ []string) error {
			socket := resolveApprovalSocket(socketPath, cmd.Flags().Changed("socket"))
			return showPending(cmd.Context(), cmd.OutOrStdout(), socket)
		},
	}
	cmd.Flags().StringVar(&socketPath, "socket", "", approvalSocketUsage)
	return cmd
}

func newApproveCmd() *cobra.Command {
	var socketPath string
	var attempt uint64
	var yes bool
	cmd := &cobra.Command{
		Use:   "approve <task-id>",
		Short: "Approve a pending task locally",
		Long: `Approve the local request of one task. The complete specification and its spec_sha256 are
shown, and the same hash is sent with the approval; the privileged mode refuses it if the
pending specification changed in the meantime. When several attempts of the task are pending,
the highest attempt is approved unless --attempt is given. The verdict is confirmed on the
terminal; --yes skips the confirmation.`,
		Args: cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			socket := resolveApprovalSocket(socketPath, cmd.Flags().Changed("socket"))
			return decidePending(cmd.Context(), cmd.OutOrStdout(), socket, args[0], attempt, "", true, yes)
		},
	}
	cmd.Flags().StringVar(&socketPath, "socket", "", approvalSocketUsage)
	cmd.Flags().Uint64Var(&attempt, "attempt", 0, "approve this attempt instead of the highest pending one")
	cmd.Flags().BoolVar(&yes, "yes", false, "do not ask for confirmation")
	return cmd
}

func newDenyCmd() *cobra.Command {
	var socketPath, message string
	var attempt uint64
	var yes bool
	cmd := &cobra.Command{
		Use:   "deny <task-id>",
		Short: "Deny a pending task locally",
		Long: `Deny the local request of one task. The complete specification and its spec_sha256 are shown,
and the same hash is sent with the denial; the privileged mode refuses it if the pending
specification changed in the meantime. The verdict is confirmed on the terminal; --yes skips
the confirmation.`,
		Args: cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			socket := resolveApprovalSocket(socketPath, cmd.Flags().Changed("socket"))
			return decidePending(cmd.Context(), cmd.OutOrStdout(), socket, args[0], attempt, message, false, yes)
		},
	}
	cmd.Flags().StringVar(&socketPath, "socket", "", approvalSocketUsage)
	cmd.Flags().Uint64Var(&attempt, "attempt", 0, "deny this attempt instead of the highest pending one")
	cmd.Flags().StringVar(&message, "message", "", "reason shown to crhs and the user")
	cmd.Flags().BoolVar(&yes, "yes", false, "do not ask for confirmation")
	return cmd
}

// showPending prints the tasks waiting for local approval with their complete specification
// and spec_sha256, which `crha approve` and `crha deny` need to bind the verdict.
func showPending(ctx context.Context, out io.Writer, socket string) error {
	client, err := localclient.Dial(ctx, socket, version.Version)
	if err != nil {
		return err
	}
	defer client.Close()
	entries, err := client.Pending(ctx)
	if err != nil {
		return err
	}
	if len(entries) == 0 {
		fmt.Fprintln(out, "no tasks are pending local approval")
		return nil
	}
	for i := range entries {
		fmt.Fprintf(out, "task %s attempt %d (received %s, note %s)\n",
			entries[i].TaskID, entries[i].Attempt,
			formatMillis(int64(entries[i].ReceivedAtMS)), noteText(entries[i].Note))
		if err := printApproval(out, approvalViewFor(&entries[i])); err != nil {
			return err
		}
	}
	return nil
}

// noteText keeps a note on one line and quotes it when it has spaces.
func noteText(note string) string {
	if note == "" {
		return "-"
	}
	return fmt.Sprintf("%q", note)
}

// decidePending approves or denies one task after showing the complete specification. attempt
// 0 selects the highest pending attempt of that task, as the brief for `crha approve` requires.
func decidePending(ctx context.Context, out io.Writer, socket, taskID string, attempt uint64, message string, approve, yes bool) error {
	client, err := localclient.Dial(ctx, socket, version.Version)
	if err != nil {
		return err
	}
	defer client.Close()
	entries, err := client.Pending(ctx)
	if err != nil {
		return err
	}
	entry, ok := chooseEntry(entries, taskID, attempt)
	if !ok {
		if attempt != 0 {
			return fmt.Errorf("no pending local request for task %s attempt %d", taskID, attempt)
		}
		return fmt.Errorf("no pending local request for task %s", taskID)
	}
	view := approvalViewFor(entry)
	if err := printApproval(out, view); err != nil {
		return err
	}
	hash, err := protocol.SpecSHA256(&entry.Spec)
	if err != nil {
		return fmt.Errorf("hash the task spec: %w", err)
	}
	action, verb := "approve", "Approve"
	if !approve {
		action, verb = "deny", "Deny"
	}
	question := fmt.Sprintf("%s task %s attempt %d with spec_sha256 %s?", verb, taskID, entry.Attempt, view.SpecSHA256)
	if err := confirmApproval(question, yes); err != nil {
		return fmt.Errorf("%s task %s: %w", action, taskID, err)
	}
	if approve {
		err = client.Approve(ctx, taskID, uint64(entry.Attempt), hash, message)
	} else {
		err = client.Deny(ctx, taskID, uint64(entry.Attempt), hash, message)
	}
	if err != nil {
		return err
	}
	decided := "approved"
	if !approve {
		decided = "denied"
	}
	fmt.Fprintf(out, "%s task %s attempt %d\n", decided, taskID, entry.Attempt)
	return nil
}

// chooseEntry returns the requested pending attempt or, when attempt is 0, the highest pending
// attempt of taskID.
func chooseEntry(entries []protocol.PendingEntry, taskID string, attempt uint64) (*protocol.PendingEntry, bool) {
	var best *protocol.PendingEntry
	for i := range entries {
		entry := &entries[i]
		if entry.TaskID != taskID {
			continue
		}
		if attempt != 0 {
			if uint64(entry.Attempt) == attempt {
				return entry, true
			}
			continue
		}
		if best == nil || uint64(entry.Attempt) > uint64(best.Attempt) {
			best = entry
		}
	}
	return best, best != nil
}
