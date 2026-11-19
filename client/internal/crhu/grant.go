package crhu

import (
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"strings"
	"time"

	"github.com/spf13/cobra"
	"golang.org/x/crypto/ssh"

	"github.com/Kodecable/ClusterRightHand/client/internal/privileged/authz"
	"github.com/Kodecable/ClusterRightHand/client/internal/protocol"
)

// grantOptions are the flags of `crhu grant`.
type grantOptions struct {
	nodes      []string
	method     string
	anyCommand bool
	spec       string
	prefix     string
	deadline   string
	tasks      []string
	attempt    uint64
	note       string
	keys       keyChoice
}

func newGrantCmd() *cobra.Command {
	opts := &grantOptions{}
	cmd := &cobra.Command{
		Use:   "grant",
		Short: "Build and sign an offline authorization",
		Long: `Build an authorization, sign it with an SSH key and print it as base64.

--nodes gives the node or node group UUIDs the authorization is for. Exactly one command limit
restricts what it allows: --spec binds one complete task spec by its hash (the method is derived
from the spec), and --method with --prefix binds a method and a target prefix; --any-command leaves
it unrestricted. --deadline (required) bounds how long it can be used, and --task makes it
one-shot. Every authorization carries a deadline.

--spec is standard base64 of the canonical CBOR TaskSpec that the payload's spec_sha256 hashes
(the encoding SpecSHA256 uses, with a file transfer's id stripped); --spec - reads it from standard
input. The spec, its rendered method and target, and the resulting hash are shown before signing.

The payload is shown and confirmed before signing. crhu runs
"ssh-keygen -Y sign -n crh-auth-v1" with the payload on stdin and never reads the private key
itself, so OpenSSH handles encrypted keys, ssh-agent and FIDO touches. The printed line is what
the WebUI accepts (POST /api/authorizations).`,
		Args: cobra.NoArgs,
		RunE: func(cmd *cobra.Command, _ []string) error {
			return runGrant(cmd, opts)
		},
	}
	f := cmd.Flags()
	f.StringSliceVar(&opts.nodes, "nodes", nil, `node or node group UUIDs, or "*"`)
	f.StringVar(&opts.method, "method", "", "exec, file.read or file.write (with --prefix)")
	f.BoolVar(&opts.anyCommand, "any-command", false, "do not restrict the method and target")
	f.StringVar(&opts.spec, "spec", "", "base64 of the canonical CBOR task spec to bind, or - for stdin")
	f.StringVar(&opts.prefix, "prefix", "", "allow targets starting with this prefix")
	f.StringVar(&opts.deadline, "deadline", "", "deadline (required): a duration (24h) or an RFC 3339 time")
	f.StringArrayVar(&opts.tasks, "task", nil, "bind the authorization to a task id (repeatable)")
	f.Uint64Var(&opts.attempt, "attempt", 0, "task attempt (default 1 with --task)")
	f.StringVar(&opts.note, "note", "", "note shown with the authorization; it is signed")
	opts.keys.addFlags(f, true)
	return cmd
}

// runGrant builds the payload from the flags, shows it, asks for confirmation and prints the
// signed authorization.
func runGrant(cmd *cobra.Command, opts *grantOptions) error {
	if err := opts.validate(); err != nil {
		return err
	}
	payload, spec, err := buildPayload(opts, time.Now(), cmd.InOrStdin())
	if err != nil {
		return err
	}
	raw, err := protocol.Marshal(payload)
	if err != nil {
		return fmt.Errorf("grant: encode the payload: %w", err)
	}
	return signAuthorization(cmd, &opts.keys, "grant", payload, spec, raw)
}

// validate checks the flags before anything is shown or signed.
func (o *grantOptions) validate() error {
	// Every authorization the flags build must expire. Without a deadline it could be used
	// forever and the privileged mode refuses it anyway.
	if o.deadline == "" {
		return errors.New("grant: --deadline is required")
	}
	if len(o.nodes) == 0 {
		return errors.New("grant: --nodes is required")
	}
	switch {
	case o.anyCommand:
		if o.method != "" {
			return errors.New("grant: --any-command and --method cannot be combined")
		}
		if o.spec != "" || o.prefix != "" {
			return errors.New("grant: --any-command cannot be combined with --spec or --prefix")
		}
	case o.spec != "" && o.prefix != "":
		return errors.New("grant: --spec and --prefix cannot be combined")
	case o.spec != "":
		if o.method != "" {
			return errors.New("grant: --spec derives the method from the spec; --method is only for --prefix")
		}
	case o.prefix != "":
		if o.method == "" {
			return errors.New("grant: --prefix needs --method")
		}
	default:
		return errors.New("grant: one of --any-command, --spec or --prefix is required")
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
// (doc/design/protocol.md "Authorization object"): every task id needs exactly one node id, in the same order, and
// neither a group nor "*" can stand for a node.
func checkOneShotNodes(nodes, tasks []string) error {
	if len(nodes) != len(tasks) {
		return fmt.Errorf("crhu: --task needs one --nodes node id per task, got %d node(s) for %d task(s)", len(nodes), len(tasks))
	}
	for _, node := range nodes {
		if node == "*" || !protocol.IsUUID(node) {
			return fmt.Errorf("crhu: --task needs node UUIDs in --nodes, not %q", node)
		}
	}
	return nil
}

// buildPayload constructs an authorization payload from the flags. It is issued now. The spec a
// `--spec` command binds is returned with it, for the confirmation display.
func buildPayload(opts *grantOptions, now time.Time, stdin io.Reader) (*protocol.AuthorizationPayload, *protocol.TaskSpec, error) {
	nodes, err := grantNodes(opts.nodes)
	if err != nil {
		return nil, nil, err
	}
	payload := &protocol.AuthorizationPayload{
		V:          protocol.AuthPayloadVersion,
		Nodes:      nodes,
		IssuedAtMS: protocol.Int(now.UnixMilli()),
		Note:       opts.note,
	}
	var boundSpec *protocol.TaskSpec
	switch {
	case opts.spec != "":
		spec, err := readSpec(opts.spec, stdin)
		if err != nil {
			return nil, nil, fmt.Errorf("grant: %w", err)
		}
		// The rendered method and target are what a guard rule matches, so a spec the node cannot
		// render is one no authorization should bind.
		if _, _, err := authz.Target(spec); err != nil {
			return nil, nil, fmt.Errorf("grant: --spec: %w", err)
		}
		hash, err := protocol.SpecSHA256(spec)
		if err != nil {
			return nil, nil, fmt.Errorf("grant: --spec: %w", err)
		}
		payload.Command = protocol.SpecCommand(hash)
		boundSpec = spec
	case opts.prefix != "":
		method, err := grantMethod(opts.method)
		if err != nil {
			return nil, nil, err
		}
		payload.Command = &protocol.AuthCommand{Kind: protocol.AuthCommandPrefix, Prefix: &protocol.AuthPrefix{
			Method: method,
			Target: opts.prefix,
		}}
	}
	if opts.deadline != "" {
		deadline, err := parseDeadline(opts.deadline, now)
		if err != nil {
			return nil, nil, err
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
	return payload, boundSpec, nil
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

// prefixWarning explains that a prefix is matched by characters, not path components or words: a
// file prefix that does not end in "/" also allows sibling paths, and an exec prefix that does not
// end in a space also allows longer arguments. Matching itself is unchanged.
func prefixWarning(command *protocol.AuthCommand) string {
	if command == nil || command.Kind != protocol.AuthCommandPrefix || command.Prefix == nil {
		return ""
	}
	prefix := command.Prefix.Target
	switch command.Prefix.Method {
	case protocol.MethodExec:
		if strings.HasSuffix(prefix, " ") {
			return ""
		}
		return fmt.Sprintf("warning: --prefix %q also matches longer words, for example %q; end it with a space if longer matches are not intended",
			prefix, prefix+"-evil")
	case protocol.MethodFileRead, protocol.MethodFileWrite:
		if strings.HasSuffix(prefix, "/") {
			return ""
		}
		return fmt.Sprintf("warning: --prefix %q also matches sibling paths, for example %q; end it with \"/\" to keep it to one directory",
			prefix, prefix+"-evil")
	default:
		return ""
	}
}

// grantView is the human-readable form of a payload and, when the signer has it, the spec a `spec`
// command binds: what the user confirms before signing.
type grantView struct {
	Nodes           []string      `json:"nodes"`
	Command         *grantCommand `json:"command"`
	Spec            *specView     `json:"spec,omitempty"`
	IssuedAt        string        `json:"issued_at"`
	IssuedAtMS      int64         `json:"issued_at_ms"`
	Deadline        *string       `json:"deadline"`
	DeadlineMS      *int64        `json:"deadline_ms"`
	TaskIDs         []string      `json:"task_ids"`
	Attempt         *uint64       `json:"attempt"`
	Note            string        `json:"note"`
	AuthorizationID string        `json:"authorization_id"`
}

// grantCommand is the command restriction of a payload as shown to the user. A spec command
// derives its method and target from the spec the signer supplies.
type grantCommand struct {
	Method     string `json:"method,omitempty"`
	Match      string `json:"match"`
	Target     string `json:"target,omitempty"`
	SpecSHA256 string `json:"spec_sha256,omitempty"`
}

// grantViewFor renders a payload for confirmation. Times are RFC 3339 with milliseconds; the
// raw millisecond values are repeated for exact comparison. spec is the complete task spec a
// `spec` command binds, when the signer supplied it.
func grantViewFor(payload *protocol.AuthorizationPayload, spec *protocol.TaskSpec, raw []byte) (grantView, error) {
	id := protocol.AuthorizationID(raw)
	view := grantView{
		Nodes:           append([]string{}, payload.Nodes...),
		IssuedAt:        formatMillis(int64(payload.IssuedAtMS)),
		IssuedAtMS:      int64(payload.IssuedAtMS),
		Note:            payload.Note,
		AuthorizationID: hex.EncodeToString(id[:]),
	}
	if spec != nil {
		shown, err := specViewFor(spec)
		if err != nil {
			return grantView{}, fmt.Errorf("show the spec: %w", err)
		}
		view.Spec = shown
	}
	if command := payload.Command; command != nil {
		shown := &grantCommand{Match: string(command.Kind)}
		switch command.Kind {
		case protocol.AuthCommandSpec:
			if command.Spec == nil {
				return grantView{}, errors.New("the payload has a spec command with no hash")
			}
			shown.SpecSHA256 = hex.EncodeToString(command.Spec[:])
			if view.Spec != nil {
				shown.Method, shown.Target = view.Spec.Method, view.Spec.Target
			}
		case protocol.AuthCommandPrefix:
			if command.Prefix == nil {
				return grantView{}, errors.New("the payload has a prefix command with no target")
			}
			shown.Method, shown.Target = string(command.Prefix.Method), command.Prefix.Target
		default:
			return grantView{}, fmt.Errorf("the payload has an unknown command limit %q", string(command.Kind))
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
	return view, nil
}

// formatMillis renders a Unix millisecond timestamp as RFC 3339 with milliseconds.
func formatMillis(ms int64) string {
	return time.UnixMilli(ms).Format("2006-01-02T15:04:05.000Z07:00")
}

// signAuthorization shows a payload (and the spec it binds), selects the signing key, confirms and
// prints the signed authorization as the one base64 line the WebUI accepts.
func signAuthorization(cmd *cobra.Command, keys *keyChoice, command string, payload *protocol.AuthorizationPayload, spec *protocol.TaskSpec, raw []byte) error {
	stdout, stderr := cmd.OutOrStdout(), cmd.ErrOrStderr()
	if warning := prefixWarning(payload.Command); warning != "" {
		fmt.Fprintln(stderr, warning)
	}
	view, err := grantViewFor(payload, spec, raw)
	if err != nil {
		return fmt.Errorf("%s: %w", command, err)
	}
	shown, err := json.MarshalIndent(view, "", "  ")
	if err != nil {
		return err
	}
	fmt.Fprintf(stderr, "%s\n", shown)

	candidate, err := keys.signer(command)
	if err != nil {
		return err
	}
	if !keys.yes {
		confirmed, err := confirmAuthorization(command)
		if err != nil {
			return err
		}
		if !confirmed {
			return fmt.Errorf("%s: the authorization was not signed", command)
		}
	}
	keyPath, cleanup, err := candidate.signerPath()
	if err != nil {
		return fmt.Errorf("%s: %w", command, err)
	}
	defer cleanup()
	blob, signer, err := signPayload(raw, keyPath, protocol.AuthNamespace, command)
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
		return fmt.Errorf("%s: encode the authorization: %w", command, err)
	}
	fmt.Fprintln(stdout, base64.StdEncoding.EncodeToString(encoded))
	fmt.Fprintf(stderr, "signed with %s %s\n", signer.Type(), ssh.FingerprintSHA256(signer))
	fmt.Fprintln(stderr, "paste the line above into CRH (POST /api/authorizations)")
	return nil
}
