package cli

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"io"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/Kodecable/ClusterRightHand/client/internal/config"
	"github.com/Kodecable/ClusterRightHand/client/internal/execenv"
	"github.com/Kodecable/ClusterRightHand/client/internal/protocol"
)

func TestCommandPaths(t *testing.T) {
	paths := [][]string{
		{"run"}, {"privileged"}, {"privileged", "run"}, {"privileged", "revoke"}, {"privileged", "stdio"},
		{"enroll"}, {"status"}, {"reload"}, {"rotate-key"}, {"upgrade"},
		{"grant"}, {"pending"}, {"approve"}, {"deny"}, {"version"},
	}
	root := NewRootCmd()
	for _, p := range paths {
		cmd, _, err := root.Find(p)
		if err != nil || cmd == root || cmd.Name() != p[len(p)-1] {
			t.Errorf("command %v not found (got %v, err %v)", p, cmd.Name(), err)
		}
	}
}

func TestNotImplemented(t *testing.T) {
	root := NewRootCmd()
	root.SetArgs([]string{"rotate-key"})
	if err := root.Execute(); err != errNotImplemented {
		t.Fatalf("got %v, want errNotImplemented", err)
	}
}

// TestNoMCPCommand covers D65 (doc/README.md): crha does not provide an stdio MCP bridge, so the
// command must not be registered at all.
func TestNoMCPCommand(t *testing.T) {
	root := NewRootCmd()
	if cmd, _, _ := root.Find([]string{"mcp"}); cmd != root {
		t.Fatalf("crha mcp is registered as %q", cmd.Name())
	}
	root.SetArgs([]string{"mcp"})
	if err := root.Execute(); err == nil || err == errNotImplemented {
		t.Fatalf("crha mcp = %v, want an unknown-command error", err)
	}
}

func TestNativeEscalation(t *testing.T) {
	for tool, want := range map[string][]string{
		config.NativeSudo: {"sudo", "-n"},
		config.NativeDoas: {"doas", "-n"},
		config.NativeRun0: {"run0", "--pipe", "--no-ask-password"},
	} {
		if got := nativeEscalation(tool); !reflect.DeepEqual(got, want) {
			t.Errorf("%s: got %v, want %v", tool, got, want)
		}
	}
}

func TestVersionOutput(t *testing.T) {
	root := NewRootCmd()
	var buf bytes.Buffer
	root.SetOut(&buf)
	root.SetArgs([]string{"version"})
	if err := root.Execute(); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(buf.String(), "crha") {
		t.Errorf("unexpected output %q", buf.String())
	}
}

func TestChooseEntry(t *testing.T) {
	entries := []protocol.PendingEntry{
		{TaskID: "a", Attempt: 1},
		{TaskID: "a", Attempt: 3},
		{TaskID: "b", Attempt: 2},
	}
	if entry, ok := chooseEntry(entries, "a", 0); !ok || entry.Attempt != 3 {
		t.Fatalf("highest attempt = %v, %v", entry, ok)
	}
	if entry, ok := chooseEntry(entries, "a", 1); !ok || entry.Attempt != 1 {
		t.Fatalf("requested attempt = %v, %v", entry, ok)
	}
	if _, ok := chooseEntry(entries, "a", 2); ok {
		t.Fatal("non-pending attempt selected")
	}
	if _, ok := chooseEntry(entries, "c", 0); ok {
		t.Fatal("unknown task selected")
	}
}

// TestApprovalView covers the specification `crha pending`, `crha approve` and `crha deny` show:
// every field of the spec and the spec_sha256 the verdict is bound to (doc/privilege.md 本地批准).
func TestApprovalView(t *testing.T) {
	data := []byte("hello")
	sum := sha256.Sum256(data)
	stdin := &protocol.InputRef{Size: protocol.Uint(len(data)), SHA256: protocol.Hash(sum)}
	entries := []protocol.PendingEntry{
		{
			TaskID: "t-exec", Attempt: 2, Note: "restart nginx",
			ReceivedAtMS: protocol.Int(time.Date(2026, 10, 30, 12, 0, 0, 0, time.UTC).UnixMilli()),
			Spec: protocol.TaskSpec{Kind: protocol.TaskSpecExec, Exec: &protocol.ExecSpec{
				Command: protocol.Command{Kind: protocol.CommandArgv, Argv: []string{"systemctl", "restart", "nginx"}},
				Env:     map[string]string{"DEBIAN_FRONTEND": "noninteractive"},
				Cwd:     "/srv",
				Stdin:   stdin,
			}},
		},
		{
			TaskID: "t-write", Attempt: 1,
			Spec: protocol.TaskSpec{Kind: protocol.TaskSpecFileWrite, FileWrite: &protocol.FileWriteSpec{
				Path:      "/etc/nginx/nginx.conf",
				Content:   *stdin,
				Overwrite: true,
				Mode:      0o4755,
				Owner:     "root",
				Group:     "root",
			}},
		},
		{
			TaskID: "t-edit", Attempt: 1,
			Spec: protocol.TaskSpec{Kind: protocol.TaskSpecFileEdit, FileEdit: &protocol.FileEditSpec{
				Path:  "/etc/hosts",
				Edits: []protocol.Edit{{OldText: "a", NewText: "b"}},
			}},
		},
		{
			TaskID: "t-read", Attempt: 1,
			Spec: protocol.TaskSpec{Kind: protocol.TaskSpecFileRead, FileRead: &protocol.FileReadSpec{
				Path: "/var/log/app.log", StartLine: 10, LineCount: 50,
			}},
		},
	}

	exec := approvalViewFor(&entries[0])
	hash, err := protocol.SpecSHA256(&entries[0].Spec)
	if err != nil {
		t.Fatal(err)
	}
	if exec.TaskID != "t-exec" || exec.Attempt != 2 || exec.Method != "exec" ||
		exec.Target != "systemctl restart nginx" || exec.Cwd != "/srv" || exec.Note != "restart nginx" {
		t.Fatalf("exec view = %+v", exec)
	}
	if strings.Join(exec.Argv, " ") != "systemctl restart nginx" || exec.Env["DEBIAN_FRONTEND"] != "noninteractive" {
		t.Fatalf("exec command = %+v", exec)
	}
	if exec.Stdin == nil || exec.Stdin.Size != 5 || exec.Stdin.SHA256 != hex.EncodeToString(sum[:]) {
		t.Fatalf("stdin = %+v", exec.Stdin)
	}
	if exec.SpecSHA256 != hex.EncodeToString(hash[:]) {
		t.Fatalf("spec_sha256 = %q, want %x", exec.SpecSHA256, hash)
	}
	if exec.ReceivedAt != formatMillis(time.Date(2026, 10, 30, 12, 0, 0, 0, time.UTC).UnixMilli()) {
		t.Fatalf("received_at = %q", exec.ReceivedAt)
	}

	write := approvalViewFor(&entries[1])
	if write.Method != "file.write" || write.Path != "/etc/nginx/nginx.conf" || write.Content == nil ||
		write.Content.Size != 5 || write.Mode != "0o4755" || write.Owner != "root" || write.Group != "root" ||
		write.Overwrite == nil || !*write.Overwrite {
		t.Fatalf("write view = %+v", write)
	}

	edit := approvalViewFor(&entries[2])
	if edit.Method != "file.write" || edit.Path != "/etc/hosts" || len(edit.Edits) != 1 ||
		edit.Edits[0].OldText != "a" || edit.Edits[0].NewText != "b" {
		t.Fatalf("edit view = %+v", edit)
	}

	// A read's line range is part of the specification the approver decides on, so it is shown too.
	read := approvalViewFor(&entries[3])
	if read.Method != "file.read" || read.Path != "/var/log/app.log" || read.StartLine != 10 || read.LineCount != 50 {
		t.Fatalf("read view = %+v", read)
	}

	var out bytes.Buffer
	if err := printApproval(&out, exec); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(out.String(), "spec_sha256") || !strings.Contains(out.String(), exec.SpecSHA256) {
		t.Fatalf("printed view has no spec hash:\n%s", out.String())
	}
	out.Reset()
	if err := printApproval(&out, read); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(out.String(), `"start_line": 10`) || !strings.Contains(out.String(), `"line_count": 50`) {
		t.Fatalf("printed read view has no line range:\n%s", out.String())
	}
}

// TestConfirmApproval covers the confirmation of a local verdict: --yes skips it, a terminal is
// asked, and without a terminal the verdict is refused.
func TestConfirmApproval(t *testing.T) {
	if err := confirmApproval("Approve?", true); err != nil {
		t.Fatalf("--yes was refused: %v", err)
	}
	answerTerminal(t, "yes\n")
	if err := confirmApproval("Approve?", false); err != nil {
		t.Fatalf("a yes answer was refused: %v", err)
	}
	answerTerminal(t, "no\n")
	if err := confirmApproval("Approve?", false); err == nil {
		t.Fatal("a no answer was accepted")
	}
	noTerminal(t)
	err := confirmApproval("Approve?", false)
	if err == nil || !strings.Contains(err.Error(), "--yes") {
		t.Fatalf("no terminal: %v, want a --yes hint", err)
	}
}

func TestParseAuthorizationID(t *testing.T) {
	id, err := parseAuthorizationID(strings.Repeat("ab", 32))
	if err != nil || id[0] != 0xab || id[31] != 0xab {
		t.Fatalf("parse = %x, %v", id, err)
	}
	for _, bad := range []string{"", "ab", strings.Repeat("zz", 32)} {
		if _, err := parseAuthorizationID(bad); err == nil {
			t.Fatalf("accepted %q", bad)
		}
	}
}

// TestStartupFailsWithoutShell checks that both modes refuse to start when no sh can be resolved:
// a node that cannot say which shell runs its `shell` tasks must not run tasks at all.
func TestStartupFailsWithoutShell(t *testing.T) {
	old := resolveEnv
	resolveEnv = func(execenv.Options) (*execenv.Environment, error) {
		return nil, errors.New("no sh to run tasks")
	}
	defer func() { resolveEnv = old }()

	if err := run(context.Background(), filepath.Join(t.TempDir(), "missing.toml")); err == nil ||
		!strings.Contains(err.Error(), "no sh") {
		t.Fatalf("crha run error = %v, want the shell resolution failure", err)
	}
	if err := runPrivileged(context.Background(), filepath.Join(t.TempDir(), "missing.toml")); err == nil ||
		!strings.Contains(err.Error(), "no sh") {
		t.Fatalf("crha privileged run error = %v, want the shell resolution failure", err)
	}
	if err := enroll(context.Background(), io.Discard, filepath.Join(t.TempDir(), "missing.toml"),
		"http://127.0.0.1:1", "crh1.abc.secret"); err == nil || !strings.Contains(err.Error(), "no sh") {
		t.Fatalf("crha enroll error = %v, want the shell resolution failure", err)
	}
}
