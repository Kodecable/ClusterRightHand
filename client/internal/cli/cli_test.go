package cli

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
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
	"github.com/Kodecable/ClusterRightHand/client/internal/version"
)

func TestCommandPaths(t *testing.T) {
	paths := [][]string{
		{"run"}, {"privileged"}, {"privileged", "run"}, {"privileged", "stdio"},
		{"enroll"}, {"register"}, {"status"}, {"upgrade"},
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
		{"register"},
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
	root.SetArgs([]string{"upgrade", "--apply", "/tmp/crha"})
	err := root.Execute()
	if version.PackageManaged {
		if err == nil || err.Error() != "crha is managed by the system package manager; upgrade it with apt or dnf" {
			t.Fatalf("got %v, want the package-manager refusal", err)
		}
		return
	}
	if err != errNotImplemented {
		t.Fatalf("got %v, want errNotImplemented", err)
	}
}

// TestRotateKeyRemoved covers that key rotation happens by re-enrolling (doc/guide/operations.md
// "Rotating and revoking node keys"), not with an online command.
func TestRotateKeyRemoved(t *testing.T) {
	root := NewRootCmd()
	if cmd, _, _ := root.Find([]string{"rotate-key"}); cmd != root {
		t.Fatalf("crha rotate-key is registered as %q", cmd.Name())
	}
	root.SetArgs([]string{"rotate-key"})
	if err := root.Execute(); err == nil || err == errNotImplemented {
		t.Fatalf("crha rotate-key = %v, want an unknown-command error", err)
	}
}

// TestNoMCPCommand covers the no-stdio-bridge limitation (doc/design/architecture.md "Known limitations"): crha does not provide an stdio MCP bridge, so the
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
// every field of the spec and the spec_sha256 the verdict is bound to (doc/design/privilege.md "Local approval").
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
			InputPreview: []byte("hello"),
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
			InputPreview: []byte("hello"),
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
	if exec.Stdin.Preview != "hello" {
		t.Fatalf("stdin preview = %q, want hello", exec.Stdin.Preview)
	}
	if exec.SpecSHA256 != hex.EncodeToString(hash[:]) {
		t.Fatalf("spec_sha256 = %q, want %x", exec.SpecSHA256, hash)
	}
	if exec.ReceivedAt != formatMillis(time.Date(2026, 10, 30, 12, 0, 0, 0, time.UTC).UnixMilli()) {
		t.Fatalf("received_at = %q", exec.ReceivedAt)
	}

	write := approvalViewFor(&entries[1])
	if write.Method != "file.write" || write.Path != "/etc/nginx/nginx.conf" || write.Content == nil ||
		write.Content.Size != 5 || write.Content.Preview != "hello" ||
		write.Mode != "0o4755" || write.Owner != "root" || write.Group != "root" ||
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

// TestApprovalPreview covers what an approver sees of stdin or file content: text with control
// characters escaped, a truncation marker, a binary description, and the interpreter warning.
func TestApprovalPreview(t *testing.T) {
	sha := "abc123"
	for _, tc := range []struct {
		name    string
		preview []byte
		size    uint64
		want    string
	}{
		{"text", []byte("echo hello\n"), 11, "echo hello\n"},
		{"control characters", []byte("a\x00b\x1b[31m\n\t"), 10, "a\\x00b\\x1b[31m\n\t"},
		{"empty", []byte{}, 0, "(empty)"},
		{"truncated", bytes.Repeat([]byte("x"), 4096), 5000, strings.Repeat("x", 4096) + "\n(904 more bytes)"},
		{"binary", []byte{0xff, 0xfe, 0x00}, 3, "binary, 3 bytes, sha256 " + sha},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if got := approvalPreviewText(tc.preview, tc.size, sha); got != tc.want {
				t.Fatalf("preview = %q, want %q", got, tc.want)
			}
		})
	}

	for _, tc := range []struct {
		name  string
		argv  []string
		stdin *approvalInput
		want  string
	}{{"bash reads stdin", []string{"/bin/bash", "-s"}, &approvalInput{Size: 3}, `warning: stdin is executed as a script by "bash"`},
		{"python3 reads stdin", []string{"python3.12", "-"}, &approvalInput{Size: 3}, `warning: stdin is executed as a script by "python3.12"`},
		{"no stdin", []string{"bash"}, nil, ""},
		{"empty stdin", []string{"bash"}, &approvalInput{Size: 0}, ""},
		{"not an interpreter", []string{"bashful"}, &approvalInput{Size: 3}, ""},
	} {
		t.Run(tc.name, func(t *testing.T) {
			view := approvalView{Argv: tc.argv, Stdin: tc.stdin}
			var out bytes.Buffer
			if err := printApproval(&out, view); err != nil {
				t.Fatal(err)
			}
			if tc.want == "" {
				if strings.Contains(out.String(), "warning:") {
					t.Fatalf("unexpected warning:\n%s", out.String())
				}
				return
			}
			if !strings.Contains(out.String(), tc.want) {
				t.Fatalf("output has no %q:\n%s", tc.want, out.String())
			}
		})
	}

	// The preview is printed as text below the JSON view, so a newline in a script stays a line
	// break instead of becoming a JSON escape.
	view := approvalView{Stdin: &approvalInput{Size: 11, Preview: "echo hello\n"}}
	var out bytes.Buffer
	if err := printApproval(&out, view); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(out.String(), "stdin preview:\necho hello\n") {
		t.Fatalf("output has no readable preview:\n%s", out.String())
	}
	if strings.Contains(out.String(), `"preview"`) {
		t.Fatalf("preview is still inside the JSON view:\n%s", out.String())
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
	if err := register(context.Background(), io.Discard, strings.NewReader("crh1.abc.secret\n"), io.Discard,
		configPath, false); err == nil || !strings.Contains(err.Error(), "no sh") {
		t.Fatalf("crha register error = %v, want the shell resolution failure", err)
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

// stubResolvedEnv makes resolveEnv succeed, so a test reaches the steps after reading the config.
func stubResolvedEnv(t *testing.T) {
	t.Helper()
	old := resolveEnv
	resolveEnv = func(execenv.Options) (*execenv.Environment, error) {
		return &execenv.Environment{Shell: "/bin/sh", Path: "/usr/bin"}, nil
	}
	t.Cleanup(func() { resolveEnv = old })
}

func writeEnrollConfig(t *testing.T, server, stateDir string) string {
	t.Helper()
	configPath := filepath.Join(t.TempDir(), "crha.toml")
	content := fmt.Sprintf("server = %q\nstate_dir = %q\n", server, stateDir)
	if err := os.WriteFile(configPath, []byte(content), 0o600); err != nil {
		t.Fatal(err)
	}
	return configPath
}

// TestEnrollFlags covers the new enrollment command: --config has a default, the answers flags
// exist, and there are no positional arguments.
func TestEnrollFlags(t *testing.T) {
	cmd := newEnrollCmd()
	if cmd.Args == nil {
		t.Fatal("enroll accepts positional arguments")
	}
	configFlag := cmd.Flags().Lookup("config")
	if configFlag == nil || configFlag.DefValue != "/etc/crha/crha.toml" {
		t.Fatalf("--config = %v, want the default /etc/crha/crha.toml", configFlag)
	}
	for _, name := range []string{"answers", "save-answers"} {
		if cmd.Flags().Lookup(name) == nil {
			t.Fatalf("enroll has no --%s flag", name)
		}
	}
	if err := execute("enroll", "extra"); err == nil {
		t.Fatal("enroll accepted a positional argument")
	}
}

// TestRegisterFlags covers that crha register reads an existing config and re-enrolls only with
// --replace.
func TestRegisterFlags(t *testing.T) {
	cmd := newRegisterCmd()
	flag := cmd.Flags().Lookup("replace")
	if flag == nil || flag.DefValue != "false" {
		t.Fatalf("--replace = %v, want false", flag)
	}
	for _, want := range []string{"standard input", "no user, file or unit", "*.old"} {
		if !strings.Contains(cmd.Long, want) {
			t.Fatalf("help does not mention %q: %q", want, cmd.Long)
		}
	}
}

// TestRegisterMissingConfig covers that register uses an existing file only.
func TestRegisterMissingConfig(t *testing.T) {
	configPath := filepath.Join(t.TempDir(), "crha.toml")
	err := register(context.Background(), io.Discard, strings.NewReader("crh1.abc.secret\n"), io.Discard, configPath, false)
	if err == nil || !strings.Contains(err.Error(), "does not exist") {
		t.Fatalf("register error = %v, want a missing-config error", err)
	}
}

// TestRegisterMissingToken covers that an empty standard input is refused before any network work.
func TestRegisterMissingToken(t *testing.T) {
	stubNoShell(t)
	configPath := writeEnrollConfig(t, "https://crh.example.com", t.TempDir())
	err := register(context.Background(), io.Discard, strings.NewReader("\n"), io.Discard, configPath, false)
	if err == nil || !strings.Contains(err.Error(), "no enrollment token") {
		t.Fatalf("register error = %v, want a missing-token error", err)
	}
}

// TestRegisterRefusesExistingKeyWithoutReplace covers that the existing refusal stays unless
// --replace is passed, and that its message points at the flag.
func TestRegisterRefusesExistingKeyWithoutReplace(t *testing.T) {
	dir := t.TempDir()
	stateDir := filepath.Join(dir, "state")
	if err := os.MkdirAll(stateDir, 0o700); err != nil {
		t.Fatal(err)
	}
	configPath := writeEnrollConfig(t, "https://crh.example.com", stateDir)
	identityPath := filepath.Join(stateDir, "identity.key")
	if err := os.WriteFile(identityPath, []byte("old identity\n"), 0o600); err != nil {
		t.Fatal(err)
	}

	err := register(context.Background(), io.Discard, strings.NewReader("crh1.abc.secret\n"), io.Discard, configPath, false)
	if err == nil || !strings.Contains(err.Error(), "already enrolled") || !strings.Contains(err.Error(), "--replace") {
		t.Fatalf("register error = %v, want the existing refusal to mention --replace", err)
	}
	data, readErr := os.ReadFile(identityPath)
	if readErr != nil || string(data) != "old identity\n" {
		t.Fatalf("identity changed: %q, %v", data, readErr)
	}
	if _, statErr := os.Stat(identityPath + ".old"); !errors.Is(statErr, os.ErrNotExist) {
		t.Fatalf("identity was backed up without --replace: %v", statErr)
	}
}

// TestRegisterReplaceRestoresKeysOnFailure covers that --replace moves both keys aside before the
// network work and puts them back when enrollment fails, leaving the rest of the state directory
// untouched.
func TestRegisterReplaceRestoresKeysOnFailure(t *testing.T) {
	stubResolvedEnv(t)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		http.Error(w, "no identity", http.StatusInternalServerError)
	}))
	defer server.Close()

	dir := t.TempDir()
	stateDir := filepath.Join(dir, "state")
	if err := os.MkdirAll(filepath.Join(stateDir, "output"), 0o700); err != nil {
		t.Fatal(err)
	}
	configPath := writeEnrollConfig(t, server.URL, stateDir)
	identityPath := filepath.Join(stateDir, "identity.key")
	serverKeyPath := filepath.Join(stateDir, "server.pub")
	notesPath := filepath.Join(stateDir, "NOTES.md")
	if err := os.WriteFile(identityPath, []byte("old identity\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(serverKeyPath, []byte("old server key\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(notesPath, []byte("my notes\n"), 0o600); err != nil {
		t.Fatal(err)
	}

	err := register(context.Background(), io.Discard, strings.NewReader("crh1.abc.secret\n"), io.Discard, configPath, true)
	if err == nil {
		t.Fatal("register succeeded against a server that returns 500")
	}
	// The refusal is the server's, not the old key's: --replace got past the file check.
	if strings.Contains(err.Error(), "already enrolled") {
		t.Fatalf("register still refused the existing key: %v", err)
	}
	for path, want := range map[string]string{
		identityPath:  "old identity\n",
		serverKeyPath: "old server key\n",
		notesPath:     "my notes\n",
	} {
		data, readErr := os.ReadFile(path)
		if readErr != nil || string(data) != want {
			t.Fatalf("%s changed: %q, %v", path, data, readErr)
		}
		if _, statErr := os.Stat(path + ".old"); !errors.Is(statErr, os.ErrNotExist) {
			t.Fatalf("%s.old left behind: %v", path, statErr)
		}
	}
	if info, statErr := os.Stat(filepath.Join(stateDir, "output")); statErr != nil || !info.IsDir() {
		t.Fatalf("output directory changed: %v, %v", info, statErr)
	}
}
