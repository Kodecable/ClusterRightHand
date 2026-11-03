package cli

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/spf13/cobra"

	"github.com/Kodecable/ClusterRightHand/client/internal/config"
	"github.com/Kodecable/ClusterRightHand/client/internal/execenv"
	"github.com/Kodecable/ClusterRightHand/client/internal/protocol"
)

func TestCommandPaths(t *testing.T) {
	paths := [][]string{
		{"run"}, {"privileged"}, {"privileged", "run"}, {"privileged", "stdio"},
		{"enroll"}, {"status"}, {"rotate-key"}, {"upgrade"},
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

// TestConfigFlagRequired covers that every command which reads crha.toml (or privileged.toml)
// gets the path explicitly and fails before doing anything when --config is missing.
func TestConfigFlagRequired(t *testing.T) {
	commands := [][]string{
		{"run"},
		{"privileged", "run"},
		{"enroll", "https://crh.example.com", "crh1.abc.secret"},
		{"status"},
	}
	for _, args := range commands {
		t.Run(strings.Join(args, " "), func(t *testing.T) {
			err := execute(args...)
			if err == nil || !strings.Contains(err.Error(), `required flag(s) "config" not set`) {
				t.Fatalf("error = %v, want the required --config error", err)
			}
		})
	}
}

// TestPrivilegedRevokeRemoved covers that the revocation command is gone: revocation was
// removed from the privileged mode, so crha advertises no way to add one.
func TestPrivilegedRevokeRemoved(t *testing.T) {
	root := NewRootCmd()
	privileged, _, err := root.Find([]string{"privileged"})
	if err != nil {
		t.Fatalf("find privileged: %v", err)
	}
	for _, child := range privileged.Commands() {
		if child.Name() == "revoke" {
			t.Fatal("crha privileged revoke is still registered")
		}
	}
}

// TestNoPersistUsedHelp covers the --no-persist-used switch of `crha privileged run`: the help
// must say what it does and that it lowers security.
func TestNoPersistUsedHelp(t *testing.T) {
	root := newPrivilegedCmd()
	run, _, err := root.Find([]string{"run"})
	if err != nil {
		t.Fatalf("find privileged run: %v", err)
	}
	flag := run.Flags().Lookup("no-persist-used")
	if flag == nil {
		t.Fatal("privileged run has no --no-persist-used flag")
	}
	if flag.DefValue != "false" {
		t.Fatalf("--no-persist-used default = %q, want false", flag.DefValue)
	}
	for _, want := range []string{"in memory only", "Lowers security", "can run again until its deadline"} {
		if !strings.Contains(flag.Usage, want) {
			t.Fatalf("--no-persist-used help = %q, want it to contain %q", flag.Usage, want)
		}
	}
}

// execute runs the command tree and returns the cobra error.
func execute(args ...string) error {
	root := NewRootCmd()
	root.SetOut(io.Discard)
	root.SetErr(io.Discard)
	root.SetArgs(args)
	return root.Execute()
}

// TestApprovalSocket covers the socket precedence of the manual local approval commands:
// --socket when explicitly set, then CRHA_PRIVILEGED_SOCKET, then the local default.
func TestApprovalSocket(t *testing.T) {
	t.Setenv(approvalSocketEnv, "")
	if got := resolveApprovalSocket("", false); got != defaultApprovalSocket {
		t.Fatalf("no flag, empty env: %q, want %q", got, defaultApprovalSocket)
	}
	t.Setenv(approvalSocketEnv, "/run/env.sock")
	if got := resolveApprovalSocket("", false); got != "/run/env.sock" {
		t.Fatalf("env: %q, want /run/env.sock", got)
	}
	if got := resolveApprovalSocket("/run/flag.sock", true); got != "/run/flag.sock" {
		t.Fatalf("flag over env: %q, want /run/flag.sock", got)
	}
	if got := resolveApprovalSocket("/run/flag.sock", false); got != "/run/env.sock" {
		t.Fatalf("unset flag must use env: %q", got)
	}
	t.Setenv(approvalSocketEnv, "")
	if got := resolveApprovalSocket("/run/flag.sock", true); got != "/run/flag.sock" {
		t.Fatalf("flag over default: %q, want /run/flag.sock", got)
	}
}

// TestApprovalSocketHelp checks that the local approval flags document the env var and default.
func TestApprovalSocketHelp(t *testing.T) {
	for _, cmd := range []*cobra.Command{newPendingCmd(), newApproveCmd(), newDenyCmd()} {
		flag := cmd.Flags().Lookup("socket")
		if flag == nil {
			t.Fatalf("%s has no --socket flag", cmd.Name())
		}
		if !strings.Contains(flag.Usage, approvalSocketEnv) || !strings.Contains(flag.Usage, defaultApprovalSocket) {
			t.Fatalf("%s --socket help = %q, want the env var and default", cmd.Name(), flag.Usage)
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
	if err := runPrivileged(context.Background(), filepath.Join(t.TempDir(), "missing.toml"), false); err == nil ||
		!strings.Contains(err.Error(), "no sh") {
		t.Fatalf("crha privileged run error = %v, want the shell resolution failure", err)
	}
	configPath := filepath.Join(t.TempDir(), "crha.toml")
	content := fmt.Sprintf("server = \"https://crh.example.com\"\nstate_dir = %q\n", t.TempDir())
	if err := os.WriteFile(configPath, []byte(content), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := enroll(context.Background(), io.Discard, configPath, "",
		"http://127.0.0.1:1", "crh1.abc.secret"); err == nil || !strings.Contains(err.Error(), "no sh") {
		t.Fatalf("crha enroll error = %v, want the shell resolution failure", err)
	}
}

// stubNoShell makes resolveEnv fail, so enrollment stops right after reading its config and never
// dials a server.
func stubNoShell(t *testing.T) {
	t.Helper()
	old := resolveEnv
	resolveEnv = func(execenv.Options) (*execenv.Environment, error) {
		return nil, errors.New("no sh to run tasks")
	}
	t.Cleanup(func() { resolveEnv = old })
}

// TestEnrollStateDirFlag covers that --state-dir has no default and the help documents it.
func TestEnrollStateDirFlag(t *testing.T) {
	cmd := newEnrollCmd()
	flag := cmd.Flags().Lookup("state-dir")
	if flag == nil {
		t.Fatal("enroll has no --state-dir flag")
	}
	if flag.DefValue != "" {
		t.Fatalf("--state-dir default = %q, want no default", flag.DefValue)
	}
	if !strings.Contains(cmd.Long, "--state-dir") {
		t.Fatalf("help does not mention --state-dir: %q", cmd.Long)
	}
}

// TestEnrollCreatesConfig covers one-command enrollment: --state-dir with a missing --config writes
// a config with server and state_dir, prints it, and enrollment continues with that config.
func TestEnrollCreatesConfig(t *testing.T) {
	stubNoShell(t)

	dir := t.TempDir()
	configPath := filepath.Join(dir, "etc", "crha", "crha.toml")
	stateDir := filepath.Join(dir, "lib", "crha")
	var out bytes.Buffer
	err := enroll(context.Background(), &out, configPath, stateDir, "https://crh.example.com", "crh1.abc.secret")
	if err == nil || !strings.Contains(err.Error(), "no sh") {
		t.Fatalf("enroll error = %v, want the shell resolution failure", err)
	}
	if got, want := out.String(), "wrote "+configPath+"\n"; got != want {
		t.Fatalf("output = %q, want %q", got, want)
	}
	want := fmt.Sprintf("server = %q\nstate_dir = %q\n", "https://crh.example.com", stateDir)
	data, err := os.ReadFile(configPath)
	if err != nil {
		t.Fatal(err)
	}
	if string(data) != want {
		t.Fatalf("config = %q, want %q", data, want)
	}
	cfg, err := config.Load(configPath)
	if err != nil {
		t.Fatal(err)
	}
	if cfg.Server != "https://crh.example.com" || cfg.StateDir != stateDir {
		t.Fatalf("config = server %q, state_dir %q", cfg.Server, cfg.StateDir)
	}
	if info, err := os.Stat(configPath); err != nil {
		t.Fatal(err)
	} else if info.Mode().Perm() != 0o644 {
		t.Fatalf("mode = %v, want 0644", info.Mode().Perm())
	}
	if info, err := os.Stat(filepath.Dir(configPath)); err != nil {
		t.Fatal(err)
	} else if info.Mode().Perm() != 0o755 {
		t.Fatalf("parent mode = %v, want 0755", info.Mode().Perm())
	}
}

// TestEnrollMissingConfigWithoutStateDir covers that a missing config without --state-dir is a clear
// error instead of a silently created file.
func TestEnrollMissingConfigWithoutStateDir(t *testing.T) {
	configPath := filepath.Join(t.TempDir(), "crha.toml")
	err := enroll(context.Background(), io.Discard, configPath, "", "https://crh.example.com", "crh1.abc.secret")
	if err == nil || !strings.Contains(err.Error(), "does not exist") || !strings.Contains(err.Error(), "--state-dir") {
		t.Fatalf("enroll error = %v, want a missing-config error pointing at --state-dir", err)
	}
	if _, statErr := os.Stat(configPath); !errors.Is(statErr, os.ErrNotExist) {
		t.Fatalf("config was created: %v", statErr)
	}
}

// TestEnrollStateDirWithExistingConfig covers that --state-dir is refused rather than ignored when
// the config file already exists.
func TestEnrollStateDirWithExistingConfig(t *testing.T) {
	stubNoShell(t)

	dir := t.TempDir()
	configPath := filepath.Join(dir, "crha.toml")
	content := fmt.Sprintf("server = \"https://crh.example.com\"\nstate_dir = %q\n", filepath.Join(dir, "state"))
	if err := os.WriteFile(configPath, []byte(content), 0o600); err != nil {
		t.Fatal(err)
	}
	err := enroll(context.Background(), io.Discard, configPath, filepath.Join(dir, "other"),
		"https://crh.example.com", "crh1.abc.secret")
	if err == nil || !strings.Contains(err.Error(), "only applies when creating a new config") {
		t.Fatalf("enroll error = %v, want the --state-dir refusal", err)
	}
	data, readErr := os.ReadFile(configPath)
	if readErr != nil || string(data) != content {
		t.Fatalf("config changed: %q, %v", data, readErr)
	}
}

// TestEnrollRelativeStateDir covers that --state-dir must be absolute.
func TestEnrollRelativeStateDir(t *testing.T) {
	configPath := filepath.Join(t.TempDir(), "crha.toml")
	err := enroll(context.Background(), io.Discard, configPath, "state",
		"https://crh.example.com", "crh1.abc.secret")
	if err == nil || !strings.Contains(err.Error(), "absolute") {
		t.Fatalf("enroll error = %v, want the absolute-path error", err)
	}
	if _, statErr := os.Stat(configPath); !errors.Is(statErr, os.ErrNotExist) {
		t.Fatalf("config was created: %v", statErr)
	}
}
