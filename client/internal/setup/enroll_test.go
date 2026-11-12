package setup

import (
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"golang.org/x/crypto/ssh"

	"github.com/Kodecable/ClusterRightHand/client/internal/config"
	"github.com/Kodecable/ClusterRightHand/client/internal/enroll"
	privconfig "github.com/Kodecable/ClusterRightHand/client/internal/privileged/config"
)

type fakeHost struct {
	root        string
	rootUser    bool
	uid         uint32
	executable  string
	groupExists bool
	userExists  bool
	commands    []string
	chowns      []string
}

func newFakeHost(t *testing.T) *fakeHost {
	t.Helper()
	return &fakeHost{root: t.TempDir(), rootUser: true, uid: 998, executable: "/usr/local/bin/crha"}
}

func (h *fakeHost) Root() string                { return h.root }
func (h *fakeHost) IsRoot() bool                { return h.rootUser }
func (h *fakeHost) UID(string) (uint32, error)  { return h.uid, nil }
func (h *fakeHost) Executable() (string, error) { return h.executable, nil }

func (h *fakeHost) Exec(_ context.Context, name string, args ...string) (CommandResult, error) {
	line := strings.Join(append([]string{name}, args...), " ")
	h.commands = append(h.commands, line)
	switch line {
	case "getent group crha":
		if h.groupExists {
			return CommandResult{Stdout: "crha:x:999:\n"}, nil
		}
		return CommandResult{Code: 2}, nil
	case "groupadd --system crha":
		h.groupExists = true
	case "id -u crha":
		if h.userExists {
			return CommandResult{Stdout: "998\n"}, nil
		}
		return CommandResult{Code: 1}, nil
	case "useradd --system --gid crha --home-dir /var/lib/crha --shell /usr/sbin/nologin crha":
		h.userExists = true
	}
	return CommandResult{}, nil
}

func (h *fakeHost) Chown(path, owner, group string) error {
	h.chowns = append(h.chowns, path+" "+owner+":"+group)
	return nil
}

func (h *fakeHost) hasCommand(want string) bool {
	for _, command := range h.commands {
		if command == want {
			return true
		}
	}
	return false
}

func (h *fakeHost) chowned(path, owner, group string) bool {
	want := at(h, path) + " " + owner + ":" + group
	for _, chown := range h.chowns {
		if chown == want {
			return true
		}
	}
	return false
}

func writeAnswers(t *testing.T, answers map[string]any) string {
	t.Helper()
	data, err := json.Marshal(answers)
	if err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(t.TempDir(), "answers.json")
	if err := os.WriteFile(path, data, 0o600); err != nil {
		t.Fatal(err)
	}
	return path
}

func trustEntry(t *testing.T) string {
	t.Helper()
	public, _, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	key, err := ssh.NewPublicKey(public)
	if err != nil {
		t.Fatal(err)
	}
	line := strings.TrimSpace(string(ssh.MarshalAuthorizedKey(key)))
	return fmt.Sprintf("[[trust]]\nname = \"crhs\"\nrole = \"crhs\"\nformat = \"sshsig\"\nkey = %q\nkinds = [\"execute\"]\n", line)
}

func forwardAnswers(t *testing.T) map[string]any {
	return map[string]any{
		"version":    1,
		"server":     "https://crh.example.com",
		"token":      "crh1.fp.secret",
		"tls_verify": "system",
		"privileged": map[string]any{"mode": "forward", "local_root": true, "trust": trustEntry(t)},
		"service":    map[string]any{"start": true},
	}
}

func ignoreAnswers() map[string]any {
	return map[string]any{
		"version":    1,
		"server":     "https://crh.example.com",
		"token":      "crh1.fp.secret",
		"tls_verify": "system",
		"privileged": map[string]any{"mode": "ignore"},
		"service":    map[string]any{"start": false},
	}
}

func runEnroll(t *testing.T, host *fakeHost, answers map[string]any, register RegisterFunc, out io.Writer) error {
	t.Helper()
	interactive := false
	return Run(context.Background(), Options{
		ConfigPath:   DefaultConfigPath,
		AnswersPath:  writeAnswers(t, answers),
		Input:        strings.NewReader(""),
		Output:       out,
		PromptOutput: io.Discard,
		Interactive:  &interactive,
		Host:         host,
		Register:     register,
		Version:      "9.9.9",
	})
}

func fakeRegister(host *fakeHost) (RegisterFunc, *int) {
	calls := 0
	return func(_ context.Context, cfg *config.Config, _ string, _ bool) (enroll.Result, error) {
		calls++
		stateDir := at(host, cfg.StateDir)
		if err := os.MkdirAll(stateDir, 0o700); err != nil {
			return enroll.Result{}, err
		}
		for _, name := range []string{"identity.key", "server.pub"} {
			if err := os.WriteFile(filepath.Join(stateDir, name), []byte("key\n"), 0o600); err != nil {
				return enroll.Result{}, err
			}
		}
		return enroll.Result{NodeID: "0192f000-0000-7000-8000-000000000001", Fingerprint: "fp-test"}, nil
	}, &calls
}

func TestParseAnswersStrictness(t *testing.T) {
	if _, err := parseAnswers([]byte(`{"version":1}`)); err != nil {
		t.Fatalf("minimal answers refused: %v", err)
	}
	for name, data := range map[string]string{
		"unknown top-level": `{"version":1,"nope":true}`,
		"unknown nested":    `{"version":1,"privileged":{"mode":"ignore","nope":true}}`,
		"wrong type":        `{"version":1,"service":{"start":"yes"}}`,
		"wrong version":     `{"version":2}`,
		"trailing data":     `{"version":1} {}`,
		"invalid tls":       `{"version":1,"tls_verify":"maybe"}`,
		"invalid mode":      `{"version":1,"privileged":{"mode":"native"}}`,
	} {
		t.Run(name, func(t *testing.T) {
			if _, err := parseAnswers([]byte(data)); err == nil {
				t.Fatalf("%s was accepted", data)
			}
		})
	}
}

func TestAnswersFileSecretPermissions(t *testing.T) {
	secret := filepath.Join(t.TempDir(), "secret.json")
	if err := os.WriteFile(secret, []byte(`{"version":1,"token":"crh1.fp.secret"}`), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := loadAnswersFile(secret); err != nil {
		t.Fatalf("0600 answers refused: %v", err)
	}
	if err := os.Chmod(secret, 0o640); err != nil {
		t.Fatal(err)
	}
	if _, err := loadAnswersFile(secret); err == nil || !strings.Contains(err.Error(), "must not be accessible") {
		t.Fatalf("group-readable secret answers = %v, want a refusal", err)
	}
	open := filepath.Join(t.TempDir(), "open.json")
	if err := os.WriteFile(open, []byte(`{"version":1,"server":"https://crh.example.com"}`), 0o644); err != nil {
		t.Fatal(err)
	}
	if _, err := loadAnswersFile(open); err != nil {
		t.Fatalf("answers without a secret refused: %v", err)
	}
}

func TestMissingAnswersListsEveryField(t *testing.T) {
	empty := &fileAnswers{Version: 1}
	_, err := collectAnswers(empty, nil, false, false, strings.NewReader(""), io.Discard, func(string) {})
	if err == nil {
		t.Fatal("empty answers were accepted without a terminal")
	}
	for _, field := range []string{"server", "token", "tls_verify", "privileged.mode", "service.start"} {
		if !strings.Contains(err.Error(), field) {
			t.Fatalf("error %q does not name %s", err, field)
		}
	}
	forward := &fileAnswers{Version: 1, Privileged: &filePrivileged{Mode: ptr("forward")}}
	_, err = collectAnswers(forward, nil, false, false, strings.NewReader(""), io.Discard, func(string) {})
	for _, field := range []string{"privileged.local_root", "privileged.trust"} {
		if !strings.Contains(err.Error(), field) {
			t.Fatalf("forward error %q does not name %s", err, field)
		}
	}
	enrolled := &fileAnswers{Version: 1}
	_, err = collectAnswers(enrolled, nil, true, false, strings.NewReader(""), io.Discard, func(string) {})
	if !strings.Contains(err.Error(), "replace") {
		t.Fatalf("enrolled error %q does not name replace", err)
	}

	// The keep path is answered by the existing crha.toml: no server, token, TLS or privileged field
	// is required and service.start still is.
	existing := &config.Config{
		Server: "https://crh.example.com", TLSVerify: "system", StateDir: StateDir,
		Privilege: config.Privileged{Mode: config.ModeIgnore},
	}
	keep := &fileAnswers{Version: 1, Replace: ptr(false), Service: &fileService{Start: ptr(true)}}
	answers, err := collectAnswers(keep, existing, true, false, strings.NewReader(""), io.Discard, func(string) {})
	if err != nil {
		t.Fatalf("keep answers refused: %v", err)
	}
	if !answers.Keep || answers.Replace || answers.Server != existing.Server ||
		answers.TLSVerify != "system" || answers.Mode != config.ModeIgnore || !answers.Start {
		t.Fatalf("keep answers = %+v", answers)
	}
	keepNoStart := &fileAnswers{Version: 1, Replace: ptr(false)}
	_, err = collectAnswers(keepNoStart, existing, true, false, strings.NewReader(""), io.Discard, func(string) {})
	if err == nil || !strings.Contains(err.Error(), "service.start") ||
		strings.Contains(err.Error(), "server") || strings.Contains(err.Error(), "token") {
		t.Fatalf("keep answers without service.start = %v", err)
	}
	// Keeping needs the file whose mode and server it inherits.
	_, err = collectAnswers(keep, nil, true, false, strings.NewReader(""), io.Discard, func(string) {})
	if err == nil || !strings.Contains(err.Error(), "crha.toml is missing") {
		t.Fatalf("keep answers without crha.toml = %v", err)
	}
}

func ptr[T any](value T) *T { return &value }

func TestSaveAnswersWithoutToken(t *testing.T) {
	path := filepath.Join(t.TempDir(), "saved.json")
	answers := resolved{
		Server: "https://crh.example.com", Token: "crh1.fp.secret", TLSVerify: "none", Replace: true,
		Mode: "forward", LocalRoot: true, Trust: "[[trust]]\n", Start: true,
	}
	if err := saveAnswers(path, answers); err != nil {
		t.Fatal(err)
	}
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(data), "secret") || strings.Contains(string(data), "token") {
		t.Fatalf("saved answers contain the token: %s", data)
	}
	if info, err := os.Stat(path); err != nil || info.Mode().Perm() != 0o600 {
		t.Fatalf("saved answers mode = %v, %v; want 0600", info.Mode().Perm(), err)
	}
	if _, err := parseAnswers(data); err != nil {
		t.Fatalf("saved answers are not a valid answers file: %v", err)
	}
}

func TestInvalidTrustRejectedBeforeWriting(t *testing.T) {
	host := newFakeHost(t)
	answers := forwardAnswers(t)
	answers["privileged"] = map[string]any{"mode": "forward", "local_root": true, "trust": "[[trust]]\nname = \"broken\"\n"}
	var out strings.Builder
	err := runEnroll(t, host, answers, nil, &out)
	if err == nil || !strings.Contains(err.Error(), "privileged.trust") {
		t.Fatalf("invalid trust error = %v", err)
	}
	if len(host.commands) != 0 || len(host.chowns) != 0 {
		t.Fatalf("commands ran before validation: %v %v", host.commands, host.chowns)
	}
	if _, statErr := os.Stat(filepath.Join(host.root, "etc")); !os.IsNotExist(statErr) {
		t.Fatalf("files were written before validation: %v", statErr)
	}
}

func TestRunNotRoot(t *testing.T) {
	host := newFakeHost(t)
	host.rootUser = false
	err := runEnroll(t, host, ignoreAnswers(), nil, io.Discard)
	if err == nil || !strings.Contains(err.Error(), "root") {
		t.Fatalf("non-root enroll = %v, want a root error", err)
	}
	if len(host.commands) != 0 {
		t.Fatalf("commands ran as non-root: %v", host.commands)
	}
}

func TestRunFullForward(t *testing.T) {
	host := newFakeHost(t)
	register, calls := fakeRegister(host)
	var out strings.Builder
	if err := runEnroll(t, host, forwardAnswers(t), register, &out); err != nil {
		t.Fatal(err)
	}
	if *calls != 1 {
		t.Fatalf("register calls = %d, want 1", *calls)
	}
	for _, want := range []string{
		"created: system group crha",
		"created: system user crha",
		"created: /etc/crha",
		"created: /var/lib/crha",
		"wrote: /etc/crha/crha.toml",
		"enrolled as node 0192f000-0000-7000-8000-000000000001, waiting for approval",
		"node key fingerprint: fp-test",
		"wrote: /etc/crha/privileged.toml",
		"wrote: /etc/systemd/system/crha-privileged.service",
		"approve the node in the WebUI",
	} {
		if !strings.Contains(out.String(), want) {
			t.Fatalf("output has no %q:\n%s", want, out.String())
		}
	}
	if !host.hasCommand("groupadd --system crha") || !host.hasCommand("useradd --system --gid crha --home-dir /var/lib/crha --shell /usr/sbin/nologin crha") {
		t.Fatalf("user commands = %v", host.commands)
	}
	for _, want := range []string{
		"systemctl daemon-reload",
		"systemctl enable --now crha crha-privileged",
	} {
		if !host.hasCommand(want) {
			t.Fatalf("commands %v have no %q", host.commands, want)
		}
	}
	for path, want := range map[string]os.FileMode{
		"/etc/crha":                                   0o750,
		"/var/lib/crha":                               0o700,
		"/etc/crha/crha.toml":                         0o640,
		"/etc/crha/privileged.toml":                   0o600,
		"/var/lib/crha/privileged":                    0o700,
		"/var/log/crha":                               0o750,
		"/etc/systemd/system/crha.service":            0o644,
		"/etc/systemd/system/crha-privileged.service": 0o644,
	} {
		info, err := os.Stat(at(host, path))
		if err != nil {
			t.Fatalf("stat %s: %v", path, err)
		}
		if info.Mode().Perm() != want {
			t.Fatalf("%s mode = %04o, want %04o", path, info.Mode().Perm(), want)
		}
	}
	configFile, err := config.Load(at(host, DefaultConfigPath))
	if err != nil {
		t.Fatalf("generated crha.toml does not validate: %v", err)
	}
	if configFile.Server != "https://crh.example.com" || configFile.TLSVerify != "system" ||
		configFile.StateDir != StateDir || configFile.Privilege.Mode != "forward" ||
		configFile.Privilege.Socket != PrivilegedSocket {
		t.Fatalf("generated crha.toml = %+v", configFile)
	}
	if !host.chowned("/etc/crha", "root", "crha") || !host.chowned("/var/lib/crha", "crha", "crha") ||
		!host.chowned("/etc/crha/crha.toml", "root", "crha") ||
		!host.chowned("/var/lib/crha/identity.key", "crha", "crha") ||
		!host.chowned("/var/lib/crha/server.pub", "crha", "crha") {
		t.Fatalf("chowns = %v", host.chowns)
	}

	privileged, err := privconfig.Load(at(host, PrivilegedConfigPath))
	if err != nil {
		t.Fatalf("generated privileged.toml does not validate: %v", err)
	}
	if privileged.NodeID != "0192f000-0000-7000-8000-000000000001" || privileged.UnprivilegedUID != 998 ||
		privileged.Socket != PrivilegedSocket || privileged.SocketGroup != "crha" ||
		privileged.StateDir != PrivilegedStateDir || privileged.LogPath != PrivilegedLogPath {
		t.Fatalf("privileged config = %+v", privileged)
	}
	if privileged.LocalEntry(0) == nil {
		t.Fatal("privileged.toml has no local-root entry")
	}
	if len(privileged.Trust) != 2 {
		t.Fatalf("trust entries = %d, want local-root and the pasted one", len(privileged.Trust))
	}

	serverUnit := readFile(t, at(host, filepath.Join(UnitDir, "crha.service")))
	for _, want := range []string{
		"# This file is managed by crha. DO NOT EDIT; customize with systemctl edit.",
		"X-CRH-Managed=1",
		`X-CRH-Meta={"v":1,"version":"9.9.9","mode":"forward","config":"/etc/crha/crha.toml"}`,
		"After=network-online.target crha-privileged.service",
		"Wants=network-online.target crha-privileged.service",
		"User=crha",
		"Group=crha",
		"ExecStart=/usr/local/bin/crha run --config /etc/crha/crha.toml",
	} {
		if !strings.Contains(serverUnit, want) {
			t.Fatalf("crha.service has no %q:\n%s", want, serverUnit)
		}
	}
	privilegedUnit := readFile(t, at(host, filepath.Join(UnitDir, "crha-privileged.service")))
	for _, want := range []string{
		"X-CRH-Managed=1",
		`X-CRH-Meta={"v":1,"version":"9.9.9","mode":"forward","config":"/etc/crha/privileged.toml"}`,
		"Before=crha.service",
		"User=root",
		"RuntimeDirectory=crha",
		"RuntimeDirectoryMode=0755",
		"ExecStart=/usr/local/bin/crha privileged run --config /etc/crha/privileged.toml",
	} {
		if !strings.Contains(privilegedUnit, want) {
			t.Fatalf("crha-privileged.service has no %q:\n%s", want, privilegedUnit)
		}
	}
}

func TestRunIgnoreMode(t *testing.T) {
	host := newFakeHost(t)
	register, _ := fakeRegister(host)
	var out strings.Builder
	if err := runEnroll(t, host, ignoreAnswers(), register, &out); err != nil {
		t.Fatal(err)
	}
	for _, path := range []string{PrivilegedConfigPath, filepath.Join(UnitDir, "crha-privileged.service"), PrivilegedStateDir} {
		if _, err := os.Stat(at(host, path)); !os.IsNotExist(err) {
			t.Fatalf("ignore mode created %s: %v", path, err)
		}
	}
	if !host.hasCommand("systemctl enable crha") {
		t.Fatalf("commands = %v, want a plain enable", host.commands)
	}
	unit := readFile(t, at(host, filepath.Join(UnitDir, "crha.service")))
	if !strings.Contains(unit, `"mode":"ignore"`) || strings.Contains(unit, "crha-privileged.service") {
		t.Fatalf("ignore unit has no ignore meta or names the privileged unit:\n%s", unit)
	}
}

func TestRunRerunSkipsAndRewritesUnits(t *testing.T) {
	host := newFakeHost(t)
	register, calls := fakeRegister(host)
	var first strings.Builder
	if err := runEnroll(t, host, forwardAnswers(t), register, &first); err != nil {
		t.Fatal(err)
	}
	second := forwardAnswers(t)
	second["replace"] = true
	var out strings.Builder
	if err := runEnroll(t, host, second, register, &out); err != nil {
		t.Fatal(err)
	}
	if *calls != 2 {
		t.Fatalf("register calls = %d, want 2", *calls)
	}
	for _, want := range []string{
		"skipped: system group crha",
		"skipped: system user crha",
		"skipped: /etc/crha",
		"skipped: /var/lib/crha",
		"skipped: /etc/crha/crha.toml",
		"skipped: /etc/crha/privileged.toml",
		"wrote: /etc/systemd/system/crha.service",
	} {
		if !strings.Contains(out.String(), want) {
			t.Fatalf("rerun output has no %q:\n%s", want, out.String())
		}
	}
}

// keepAnswers is the file of a keep run: replace=no and only the service question, which is the only
// one the keep path still asks. It carries no token and no server.
func keepAnswers() map[string]any {
	return map[string]any{
		"version": 1,
		"replace": false,
		"service": map[string]any{"start": true},
	}
}

func TestRunKeepSkipsEnrollment(t *testing.T) {
	host := newFakeHost(t)
	register, calls := fakeRegister(host)
	if err := runEnroll(t, host, forwardAnswers(t), register, io.Discard); err != nil {
		t.Fatal(err)
	}
	var out strings.Builder
	if err := runEnroll(t, host, keepAnswers(), register, &out); err != nil {
		t.Fatal(err)
	}
	if *calls != 1 {
		t.Fatalf("keep path registered the node again: register calls = %d, want 1", *calls)
	}
	for _, want := range []string{
		"skipped: system group crha",
		"skipped: system user crha",
		"skipped: /var/lib/crha",
		"skipped: /etc/crha/crha.toml",
		"skipped: enrollment (already enrolled)",
		"skipped: /etc/crha/privileged.toml",
		"wrote: /etc/systemd/system/crha.service",
		"wrote: /etc/systemd/system/crha-privileged.service",
	} {
		if !strings.Contains(out.String(), want) {
			t.Fatalf("keep output has no %q:\n%s", want, out.String())
		}
	}
	for _, want := range []string{
		"systemctl daemon-reload",
		"systemctl enable --now crha crha-privileged",
	} {
		if !host.hasCommand(want) {
			t.Fatalf("commands %v have no %q", host.commands, want)
		}
	}
	if _, err := os.Stat(at(host, PrivilegedConfigPath)); err != nil {
		t.Fatalf("keep path removed privileged.toml: %v", err)
	}
}

func TestRunKeepForwardWithoutPrivilegedConfigFailsEarly(t *testing.T) {
	host := newFakeHost(t)
	register, calls := fakeRegister(host)
	if err := runEnroll(t, host, forwardAnswers(t), register, io.Discard); err != nil {
		t.Fatal(err)
	}
	units := []string{
		PrivilegedConfigPath,
		filepath.Join(UnitDir, "crha.service"),
		filepath.Join(UnitDir, "crha-privileged.service"),
	}
	for _, path := range units {
		if err := os.Remove(at(host, path)); err != nil {
			t.Fatal(err)
		}
	}
	configBefore := readFile(t, at(host, DefaultConfigPath))
	host.commands = nil
	host.chowns = nil
	err := runEnroll(t, host, keepAnswers(), register, io.Discard)
	if err == nil || !strings.Contains(err.Error(), "privileged.toml is missing and the node id is only returned by enrollment") {
		t.Fatalf("keep without privileged.toml = %v", err)
	}
	if *calls != 1 {
		t.Fatalf("register calls = %d, want 1", *calls)
	}
	if len(host.commands) != 0 || len(host.chowns) != 0 {
		t.Fatalf("keep without privileged.toml changed the host: %v %v", host.commands, host.chowns)
	}
	for _, path := range units {
		if _, err := os.Stat(at(host, path)); !os.IsNotExist(err) {
			t.Fatalf("%s was written before the failure: %v", path, err)
		}
	}
	if readFile(t, at(host, DefaultConfigPath)) != configBefore {
		t.Fatal("crha.toml changed before the failure")
	}
}

func TestRunKeepWithoutConfigFails(t *testing.T) {
	host := newFakeHost(t)
	register, calls := fakeRegister(host)
	stateDir := at(host, StateDir)
	if err := os.MkdirAll(stateDir, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(stateDir, "identity.key"), []byte("key\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	err := runEnroll(t, host, keepAnswers(), register, io.Discard)
	if err == nil || !strings.Contains(err.Error(), "crha.toml is missing; re-enroll (replace) or restore it") {
		t.Fatalf("keep without crha.toml = %v", err)
	}
	if *calls != 0 || len(host.commands) != 0 || len(host.chowns) != 0 {
		t.Fatalf("keep without crha.toml changed the host: calls=%d %v %v", *calls, host.commands, host.chowns)
	}
}

// TestInteractiveReplaceIsAskedFirst covers that on an enrolled node the re-enroll question comes
// before the server and the token, and that the summary names the choice.
func TestInteractiveReplaceIsAskedFirst(t *testing.T) {
	existing := &config.Config{
		Server: "https://old.example.com", TLSVerify: "system", StateDir: StateDir,
		Privilege: config.Privileged{Mode: config.ModeIgnore},
	}
	file := &fileAnswers{
		Version:    1,
		Server:     ptr("https://crh.example.com"),
		Token:      ptr("crh1.fp.secret"),
		TLSVerify:  ptr("system"),
		Privileged: &filePrivileged{Mode: ptr("ignore")},
		Service:    &fileService{Start: ptr(true)},
	}
	var prompts, out strings.Builder
	answers, err := collectAnswers(file, existing, true, true, strings.NewReader("y\ny\n"), &prompts,
		func(line string) { out.WriteString(line + "\n") })
	if err != nil {
		t.Fatal(err)
	}
	if !answers.Replace || answers.Keep {
		t.Fatalf("answers = %+v, want a re-enrollment", answers)
	}
	if !strings.HasPrefix(prompts.String(), "Re-enroll, keeping") {
		t.Fatalf("first prompt is not the re-enroll question: %q", prompts.String())
	}
	for _, unwanted := range []string{"crhs address", "Enrollment token"} {
		if strings.Contains(prompts.String(), unwanted) {
			t.Fatalf("file-answered %q was asked: %q", unwanted, prompts.String())
		}
	}
	if !strings.Contains(out.String(), "enrollment: re-enroll") {
		t.Fatalf("summary has no enrollment choice:\n%s", out.String())
	}
}

// TestInteractiveKeepAsksOnlyTheService covers that answering no keeps the existing enrollment: the
// server, token, TLS and privileged mode are not asked, only the service question and the confirmation.
func TestInteractiveKeepAsksOnlyTheService(t *testing.T) {
	existing := &config.Config{
		Server: "https://old.example.com", TLSVerify: "none", StateDir: StateDir,
		Privilege: config.Privileged{Mode: config.ModeIgnore},
	}
	file := &fileAnswers{Version: 1, Replace: ptr(false)}
	var prompts, out strings.Builder
	answers, err := collectAnswers(file, existing, true, true, strings.NewReader("\ny\n"), &prompts,
		func(line string) { out.WriteString(line + "\n") })
	if err != nil {
		t.Fatal(err)
	}
	if !answers.Keep || answers.Replace {
		t.Fatalf("answers = %+v, want keep", answers)
	}
	if answers.Server != existing.Server || answers.TLSVerify != "none" ||
		answers.Mode != config.ModeIgnore || !answers.Start {
		t.Fatalf("keep answers = %+v", answers)
	}
	for _, unwanted := range []string{"crhs address", "Enrollment token", "Privileged mode", "TLS certificate"} {
		if strings.Contains(prompts.String(), unwanted) {
			t.Fatalf("keep path asked %q: %q", unwanted, prompts.String())
		}
	}
	if !strings.Contains(prompts.String(), "Start the services") {
		t.Fatalf("keep path did not ask the service question: %q", prompts.String())
	}
	if !strings.Contains(out.String(), "enrollment: keep existing") {
		t.Fatalf("summary has no keep choice:\n%s", out.String())
	}
}

func TestRunSaveAnswers(t *testing.T) {
	host := newFakeHost(t)
	register, _ := fakeRegister(host)
	saved := filepath.Join(t.TempDir(), "saved.json")
	interactive := false
	err := Run(context.Background(), Options{
		ConfigPath:      DefaultConfigPath,
		AnswersPath:     writeAnswers(t, forwardAnswers(t)),
		SaveAnswersPath: saved,
		Input:           strings.NewReader(""),
		Output:          io.Discard,
		PromptOutput:    io.Discard,
		Interactive:     &interactive,
		Host:            host,
		Register:        register,
	})
	if err != nil {
		t.Fatal(err)
	}
	data, err := os.ReadFile(saved)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(data), "crh1.fp.secret") {
		t.Fatalf("saved answers contain the token: %s", data)
	}
	if info, err := os.Stat(saved); err != nil || info.Mode().Perm() != 0o600 {
		t.Fatalf("saved answers mode = %v, %v", info.Mode().Perm(), err)
	}
}

func readFile(t *testing.T, path string) string {
	t.Helper()
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	return string(data)
}

// TestInteractiveFileAnsweredDoesNotConfirm covers that a run answered entirely by the file neither
// asks a question nor asks to proceed, even when stdin is a terminal.
func TestInteractiveFileAnsweredDoesNotConfirm(t *testing.T) {
	file := &fileAnswers{
		Version:   1,
		Server:    ptr("https://crh.example.com"),
		Token:     ptr("crh1.fp.secret"),
		TLSVerify: ptr("system"),
		Privileged: &filePrivileged{
			Mode:      ptr("ignore"),
			LocalRoot: ptr(true),
			Trust:     ptr(""),
		},
		Service: &fileService{Start: ptr(true)},
	}
	var prompts strings.Builder
	answers, err := collectAnswers(file, nil, false, true, strings.NewReader("n\n"), &prompts, func(string) {})
	if err != nil {
		t.Fatal(err)
	}
	if prompts.Len() != 0 {
		t.Fatalf("a fully answered file prompted: %q", prompts.String())
	}
	if answers.Server != "https://crh.example.com" || answers.Mode != "ignore" || !answers.Start {
		t.Fatalf("answers = %+v", answers)
	}
}
