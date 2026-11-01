package cli

import (
	"bufio"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"strings"

	"github.com/Kodecable/ClusterRightHand/client/internal/privileged/authz"
	"github.com/Kodecable/ClusterRightHand/client/internal/protocol"
)

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
			view.Stdin = approvalInputFor(spec.Exec.Stdin)
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
			view.Content = approvalInputFor(&spec.FileWrite.Content)
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

func approvalInputFor(ref *protocol.InputRef) *approvalInput {
	if ref == nil {
		return nil
	}
	return &approvalInput{Size: uint64(ref.Size), SHA256: hex.EncodeToString(ref.SHA256[:])}
}

// printApproval writes one view as indented JSON so every field of the spec is visible.
func printApproval(out io.Writer, view approvalView) error {
	encoded, err := json.MarshalIndent(view, "", "  ")
	if err != nil {
		return err
	}
	_, err = fmt.Fprintf(out, "%s\n", encoded)
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
