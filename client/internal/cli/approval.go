package cli

import (
	"bufio"
	"context"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"unicode"
	"unicode/utf8"

	"github.com/spf13/cobra"

	"github.com/Kodecable/ClusterRightHand/client/internal/privileged/authz"
	"github.com/Kodecable/ClusterRightHand/client/internal/privileged/localclient"
	"github.com/Kodecable/ClusterRightHand/client/internal/protocol"
	"github.com/Kodecable/ClusterRightHand/client/internal/version"
)

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

// approvalView is the complete specification an approver decides on. `crha pending` and
// `crha approve` / `crha deny` print it, together with the spec_sha256 the verdict is bound to
// (doc/privilege.md 本地批准): method, target, argv, env, cwd, stdin or content size and hash,
// the line range of a file.read, mode, owner, overwrite and edits.
type approvalView struct {
	TaskID     string            `json:"task_id"`
	Attempt    uint64            `json:"attempt"`
	Method     string            `json:"method"`
	Target     string            `json:"target"`
	Argv       []string          `json:"argv,omitempty"`
	Shell      string            `json:"shell,omitempty"`
	Env        map[string]string `json:"env,omitempty"`
	Cwd        string            `json:"cwd,omitempty"`
	Stdin      *approvalInput    `json:"stdin,omitempty"`
	Path       string            `json:"path,omitempty"`
	StartLine  uint64            `json:"start_line,omitempty"`
	LineCount  uint64            `json:"line_count,omitempty"`
	Limit      uint64            `json:"limit,omitempty"`
	Content    *approvalInput    `json:"content,omitempty"`
	Overwrite  *bool             `json:"overwrite,omitempty"`
	Mode       string            `json:"mode,omitempty"`
	Owner      string            `json:"owner,omitempty"`
	Group      string            `json:"group,omitempty"`
	Edits      []approvalEdit    `json:"edits,omitempty"`
	Note       string            `json:"note"`
	ReceivedAt string            `json:"received_at"`
	SpecSHA256 string            `json:"spec_sha256"`
}

type approvalInput struct {
	Size   uint64 `json:"size"`
	SHA256 string `json:"sha256"`
	// Preview is the first bytes of the content, escaped for a terminal, or a binary description.
	// printApproval shows it as text below the JSON view. It is empty when the privileged mode did
	// not send a preview (doc/privilege.md 本地批准).
	Preview string `json:"-"`
}

type approvalEdit struct {
	OldText string `json:"old_text"`
	NewText string `json:"new_text"`
}

// approvalViewFor renders one pending request. The spec hash is computed exactly as the
// privileged mode does when it stored the request, so sending it back binds the verdict to the
// spec shown here.
func approvalViewFor(entry *protocol.PendingEntry) approvalView {
	spec := &entry.Spec
	view := approvalView{
		TaskID:     entry.TaskID,
		Attempt:    uint64(entry.Attempt),
		Method:     "-",
		Target:     "-",
		Note:       entry.Note,
		ReceivedAt: formatMillis(int64(entry.ReceivedAtMS)),
	}
	if method, target, err := authz.Target(spec); err == nil {
		view.Method, view.Target = method, target
	}
	if hash, err := protocol.SpecSHA256(spec); err == nil {
		view.SpecSHA256 = hex.EncodeToString(hash[:])
	}
	switch spec.Kind {
	case protocol.TaskSpecExec:
		if spec.Exec != nil {
			view.Argv = append([]string{}, spec.Exec.Command.Argv...)
			view.Shell = spec.Exec.Command.Shell
			if len(spec.Exec.Env) > 0 {
				view.Env = make(map[string]string, len(spec.Exec.Env))
				for name, value := range spec.Exec.Env {
					view.Env[name] = value
				}
			}
			view.Cwd = spec.Exec.Cwd
			view.Stdin = approvalInputFor(spec.Exec.Stdin, entry.InputPreview)
		}
	case protocol.TaskSpecFileRead:
		if spec.FileRead != nil {
			view.Path = spec.FileRead.Path
			view.StartLine = uint64(spec.FileRead.StartLine)
			view.LineCount = uint64(spec.FileRead.LineCount)
		}
	case protocol.TaskSpecFileWrite:
		if spec.FileWrite != nil {
			view.Path = spec.FileWrite.Path
			view.Content = approvalInputFor(&spec.FileWrite.Content, entry.InputPreview)
			overwrite := spec.FileWrite.Overwrite
			view.Overwrite = &overwrite
			if spec.FileWrite.Mode != 0 {
				view.Mode = fmt.Sprintf("0o%o", uint64(spec.FileWrite.Mode))
			}
			view.Owner = spec.FileWrite.Owner
			view.Group = spec.FileWrite.Group
		}
	case protocol.TaskSpecFileEdit:
		if spec.FileEdit != nil {
			view.Path = spec.FileEdit.Path
			for _, edit := range spec.FileEdit.Edits {
				view.Edits = append(view.Edits, approvalEdit{OldText: edit.OldText, NewText: edit.NewText})
			}
		}
	case protocol.TaskSpecFileStat:
		if spec.FileStat != nil {
			view.Path = spec.FileStat.Path
		}
	case protocol.TaskSpecFileList:
		if spec.FileList != nil {
			view.Path = spec.FileList.Path
			view.Limit = uint64(spec.FileList.Limit)
		}
	}
	return view
}

// approvalPreviewBytes bounds the content shown to an approver, matching what local.request carries.
const approvalPreviewBytes = 4 << 10

func approvalInputFor(ref *protocol.InputRef, preview []byte) *approvalInput {
	if ref == nil {
		return nil
	}
	sha := hex.EncodeToString(ref.SHA256[:])
	in := &approvalInput{Size: uint64(ref.Size), SHA256: sha}
	if preview != nil {
		in.Preview = approvalPreviewText(preview, uint64(ref.Size), sha)
	}
	return in
}

// approvalPreviewText renders the beginning of stdin or file content for an approver. Text keeps
// newlines and tabs but escapes every other control character; a truncated text ends with the
// number of bytes not shown, and content that is not valid UTF-8 is described instead.
func approvalPreviewText(preview []byte, size uint64, sha string) string {
	shown := preview
	if len(shown) > approvalPreviewBytes {
		shown = shown[:approvalPreviewBytes]
	}
	if !utf8.Valid(shown) {
		return fmt.Sprintf("binary, %d bytes, sha256 %s", size, sha)
	}
	text := escapeControl(shown)
	if text == "" {
		text = "(empty)"
	}
	if size > uint64(len(shown)) {
		text += fmt.Sprintf("\n(%d more bytes)", size-uint64(len(shown)))
	}
	return text
}

// escapeControl keeps newlines and tabs and escapes every other control character, so a terminal
// shows the content as text without acting on escape sequences.
func escapeControl(b []byte) string {
	var out strings.Builder
	for _, r := range string(b) {
		if r == '\n' || r == '\t' {
			out.WriteRune(r)
			continue
		}
		if unicode.IsControl(r) {
			quoted := strconv.QuoteRune(r)
			out.WriteString(quoted[1 : len(quoted)-1])
			continue
		}
		out.WriteRune(r)
	}
	return out.String()
}

// scriptInterpreters are the argv[0] base names whose stdin is commonly executed as a script.
func isScriptInterpreter(base string) bool {
	switch base {
	case "sh", "bash", "dash", "zsh", "ksh", "perl", "ruby", "node", "php", "lua":
		return true
	}
	return strings.HasPrefix(base, "python")
}

// interpreterWarning returns the warning shown when an interpreter's stdin is present, so an
// approver does not miss the script that will be read from it.
func interpreterWarning(view approvalView) string {
	if len(view.Argv) == 0 || view.Stdin == nil || view.Stdin.Size == 0 {
		return ""
	}
	base := filepath.Base(view.Argv[0])
	if !isScriptInterpreter(base) {
		return ""
	}
	return fmt.Sprintf("stdin is executed as a script by %q", base)
}

// printApproval writes one view as indented JSON so every field of the spec is visible, then the
// stdin or content preview as text, then the interpreter warning when the command reads its stdin
// as a script.
func printApproval(out io.Writer, view approvalView) error {
	encoded, err := json.MarshalIndent(view, "", "  ")
	if err != nil {
		return err
	}
	if _, err := fmt.Fprintf(out, "%s\n", encoded); err != nil {
		return err
	}
	if err := printInputPreview(out, "stdin", view.Stdin); err != nil {
		return err
	}
	if err := printInputPreview(out, "content", view.Content); err != nil {
		return err
	}
	if warning := interpreterWarning(view); warning != "" {
		_, err = fmt.Fprintf(out, "warning: %s\n", warning)
	}
	return err
}

// printInputPreview writes the content an approver must see as text, not as a JSON string: a
// newline in a stdin script stays a line break.
func printInputPreview(out io.Writer, label string, in *approvalInput) error {
	if in == nil || in.Preview == "" {
		return nil
	}
	_, err := fmt.Fprintf(out, "%s preview:\n%s\n", label, in.Preview)
	return err
}

// confirmApproval asks on the controlling terminal before a local verdict is sent. Without a
// terminal it refuses unless --yes was given: a verdict must not be sent for a spec nobody saw.
func confirmApproval(question string, yes bool) error {
	if yes {
		return nil
	}
	terminal, err := openTerminal()
	if err != nil {
		return fmt.Errorf("no terminal to confirm the specification, rerun with --yes: %w", err)
	}
	defer terminal.Close()
	if _, err := io.WriteString(terminal, question+" [y/N] "); err != nil {
		return fmt.Errorf("ask for confirmation: %w", err)
	}
	line, err := bufio.NewReader(terminal).ReadString('\n')
	if err != nil && line == "" {
		return fmt.Errorf("read the confirmation: %w", err)
	}
	switch strings.ToLower(strings.TrimSpace(line)) {
	case "y", "yes":
		return nil
	}
	return fmt.Errorf("the local request was not decided")
}
