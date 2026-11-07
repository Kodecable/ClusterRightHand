package cli

import (
	"bytes"
	"encoding/base64"
	"encoding/pem"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"golang.org/x/crypto/ssh"

	"github.com/Kodecable/ClusterRightHand/client/internal/privileged/authz"
	"github.com/Kodecable/ClusterRightHand/client/internal/protocol"
)

// Node UUIDs for --nodes; grants address nodes by UUID only (D110).
const (
	testNodeA = "0192f000-0000-7000-8000-000000000001"
	testNodeB = "0192f000-0000-7000-8000-000000000002"
)

// fakeTerminal is the controlling terminal a test answers the confirmation on.
type fakeTerminal struct {
	io.Reader
	io.Writer
}

func (fakeTerminal) Close() error { return nil }

// answerTerminal replaces the controlling terminal for one test.
func answerTerminal(t *testing.T, answer string) {
	t.Helper()
	var out bytes.Buffer
	old := openTerminal
	openTerminal = func() (io.ReadWriteCloser, error) {
		return fakeTerminal{Reader: strings.NewReader(answer), Writer: &out}, nil
	}
	t.Cleanup(func() { openTerminal = old })
}

// noTerminal makes opening the controlling terminal fail, as in a service without a tty.
func noTerminal(t *testing.T) {
	t.Helper()
	old := openTerminal
	openTerminal = func() (io.ReadWriteCloser, error) { return nil, os.ErrNotExist }
	t.Cleanup(func() { openTerminal = old })
}

// useSSHKeygen replaces the signing program for one test.
func useSSHKeygen(t *testing.T, path string) {
	t.Helper()
	old := sshKeygen
	sshKeygen = path
	t.Cleanup(func() { sshKeygen = old })
}

// runCLI executes crha with args and returns its stdout and stderr.
func runCLI(t *testing.T, args ...string) (stdout, stderr string, err error) {
	t.Helper()
	root := NewRootCmd()
	var out, errOut bytes.Buffer
	root.SetOut(&out)
	root.SetErr(&errOut)
	root.SetArgs(args)
	err = root.Execute()
	return out.String(), errOut.String(), err
}

// TestGrantBuildPayload covers the payload the flags build, and the flag combinations that are
// refused before anything is shown or signed.
func TestGrantBuildPayload(t *testing.T) {
	now := time.Date(2026, 10, 30, 12, 0, 0, 0, time.UTC)
	hash := strings.Repeat("ab", 32)
	opts := &grantOptions{
		nodes:      []string{testNodeA, testNodeB},
		method:     "exec",
		exact:      "systemctl restart nginx",
		specSHA256: hash,
		deadline:   "90m",
		tasks:      []string{"task-1", "task-2"},
		attempt:    3,
		note:       "restart to load the new certificate",
		key:        "/keys/id_ed25519",
	}
	if err := opts.validate(); err != nil {
		t.Fatalf("validate: %v", err)
	}
	payload, err := buildPayload(opts, now)
	if err != nil {
		t.Fatal(err)
	}
	if payload.V != protocol.AuthPayloadVersion || len(payload.Nodes) != 2 || payload.Nodes[0] != testNodeA {
		t.Fatalf("payload = %+v", payload)
	}
	if payload.Command == nil || payload.Command.Method != protocol.MethodExec || payload.Command.Match.Kind != protocol.AuthMatchExact {
		t.Fatalf("command = %+v", payload.Command)
	}
	if payload.Command.Match.Exact.Target != "systemctl restart nginx" ||
		fmt.Sprintf("%x", payload.Command.Match.Exact.SpecSHA256) != hash {
		t.Fatalf("exact = %+v", payload.Command.Match.Exact)
	}
	if payload.IssuedAtMS != protocol.Int(now.UnixMilli()) {
		t.Fatalf("issued_at = %d", payload.IssuedAtMS)
	}
	if payload.DeadlineMS == nil || time.UnixMilli(int64(*payload.DeadlineMS)).Sub(now) != 90*time.Minute {
		t.Fatalf("deadline = %v", payload.DeadlineMS)
	}
	if payload.TaskIDs == nil || len(*payload.TaskIDs) != 2 || *payload.Attempt != 3 {
		t.Fatalf("task_ids = %v attempt = %v", payload.TaskIDs, payload.Attempt)
	}
	if payload.Note != opts.note {
		t.Fatalf("note = %q", payload.Note)
	}

	// A prefix authorization has no spec hash, and no command is only allowed explicitly.
	prefix, err := buildPayload(&grantOptions{
		nodes: []string{"*"}, method: "file.write", prefix: "/etc/nginx/", deadline: "1h", key: "k",
	}, now)
	if err != nil {
		t.Fatal(err)
	}
	if prefix.Command == nil || prefix.Command.Match.Kind != protocol.AuthMatchPrefix || prefix.Command.Match.Prefix.Target != "/etc/nginx/" {
		t.Fatalf("prefix command = %+v", prefix.Command)
	}
	any, err := buildPayload(&grantOptions{nodes: []string{"*"}, anyCommand: true, key: "k"}, now)
	if err != nil {
		t.Fatal(err)
	}
	if any.Command != nil || any.DeadlineMS != nil || any.TaskIDs != nil || any.Attempt != nil {
		t.Fatalf("unrestricted payload = %+v", any)
	}

	bad := []struct {
		name string
		opts grantOptions
		want string
	}{
		{"no key", grantOptions{nodes: []string{testNodeA}, anyCommand: true, deadline: "1h"}, "--key is required"},
		{"no deadline", grantOptions{nodes: []string{testNodeA}, anyCommand: true, key: "k"}, "--deadline is required"},
		{"no nodes", grantOptions{anyCommand: true, deadline: "1h", key: "k"}, "--nodes or --payload"},
		{"name node", grantOptions{nodes: []string{"node-1"}, anyCommand: true, deadline: "1h", key: "k"}, "not a node or node group UUID"},
		{"group node", grantOptions{nodes: []string{"group:web"}, anyCommand: true, deadline: "1h", key: "k"}, "no longer accepts"},
		{"no method", grantOptions{nodes: []string{testNodeA}, deadline: "1h", key: "k"}, "--method is required"},
		{"method without match", grantOptions{nodes: []string{testNodeA}, method: "exec", deadline: "1h", key: "k"}, "needs --exact or --prefix"},
		{"exact without hash", grantOptions{nodes: []string{testNodeA}, method: "exec", exact: "x", deadline: "1h", key: "k"}, "--exact requires --spec-sha256"},
		{"hash without exact", grantOptions{nodes: []string{testNodeA}, method: "exec", prefix: "x", specSHA256: hash, deadline: "1h", key: "k"}, "--spec-sha256 requires --exact"},
		{"bad method", grantOptions{nodes: []string{testNodeA}, method: "run", exact: "x", specSHA256: hash, deadline: "1h", key: "k"}, "is not exec"},
		{"bad hash", grantOptions{nodes: []string{testNodeA}, method: "exec", exact: "x", specSHA256: "zz", deadline: "1h", key: "k"}, "32 bytes of hex"},
		{"task without deadline", grantOptions{nodes: []string{testNodeA}, anyCommand: true, tasks: []string{"t"}, key: "k"}, "--deadline is required"},
		{"task with a group node", grantOptions{nodes: []string{"group:web"}, anyCommand: true, deadline: "1h", tasks: []string{"t"}, key: "k"}, "node UUIDs"},
		{"task with a star node", grantOptions{nodes: []string{"*"}, anyCommand: true, deadline: "1h", tasks: []string{"t"}, key: "k"}, "node UUIDs"},
		{"task with too few nodes", grantOptions{nodes: []string{testNodeA}, anyCommand: true, deadline: "1h", tasks: []string{"t1", "t2"}, key: "k"}, "one --nodes node id per task"},
		{"task with too many nodes", grantOptions{nodes: []string{"n1", "n2"}, anyCommand: true, deadline: "1h", tasks: []string{"t"}, key: "k"}, "one --nodes node id per task"},
		{"attempt without task", grantOptions{nodes: []string{testNodeA}, anyCommand: true, attempt: 2, deadline: "1h", key: "k"}, "--attempt requires --task"},
		{"deadline in the past", grantOptions{nodes: []string{testNodeA}, anyCommand: true,
			deadline: time.Now().Add(-time.Hour).Format(time.RFC3339), key: "k"}, "in the past"},
		{"deadline not a time", grantOptions{nodes: []string{testNodeA}, anyCommand: true, deadline: "soon", key: "k"}, "neither a duration"},
		{"payload with nodes", grantOptions{payload: "x", nodes: []string{testNodeA}, key: "k"}, "cannot be combined"},
		{"payload with note", grantOptions{payload: "x", note: "n", key: "k"}, "cannot be combined"},
	}
	for _, tc := range bad {
		t.Run(tc.name, func(t *testing.T) {
			opts := tc.opts
			if _, _, err := grantPayload(&opts); err == nil {
				t.Fatalf("accepted: %+v", opts)
			} else if !strings.Contains(err.Error(), tc.want) {
				t.Fatalf("error %q does not contain %q", err, tc.want)
			}
		})
	}
}

// TestGrantPayloadMode decodes and shows the payload of a WebUI authorization request.
func TestGrantPayloadMode(t *testing.T) {
	deadline := protocol.Int(1700003600000)
	payload := &protocol.AuthorizationPayload{
		V:          protocol.AuthPayloadVersion,
		Nodes:      []string{testNodeA},
		Command:    nil,
		IssuedAtMS: protocol.Int(1700000000000),
		DeadlineMS: &deadline,
		Note:       "from the WebUI",
	}
	raw, err := protocol.Marshal(payload)
	if err != nil {
		t.Fatal(err)
	}
	got, gotRaw, err := grantPayloadOf(t, base64.StdEncoding.EncodeToString(raw))
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(gotRaw, raw) {
		t.Fatal("the payload bytes changed")
	}
	shown := grantViewFor(got, gotRaw)
	if shown.Nodes[0] != testNodeA || shown.Command != nil || shown.Note != "from the WebUI" {
		t.Fatalf("view = %+v", shown)
	}
	if id := protocol.AuthorizationID(raw); shown.AuthorizationID != fmt.Sprintf("%x", id) {
		t.Fatalf("authorization id = %q", shown.AuthorizationID)
	}
	if want := time.UnixMilli(1700000000000).Format("2006-01-02T15:04:05.000Z07:00"); shown.IssuedAt != want {
		t.Fatalf("issued_at = %q, want %q", shown.IssuedAt, want)
	}
	if _, _, err := grantPayloadOf(t, "not base64!"); err == nil {
		t.Fatal("invalid base64 accepted")
	}
	if _, _, err := grantPayloadOf(t, base64.StdEncoding.EncodeToString([]byte{1, 2, 3})); err == nil {
		t.Fatal("invalid payload accepted")
	}
}

// TestGrantPayloadOneShotNodes covers the per-position node binding of a one-shot payload given
// as base64: a group, "*" or a length mismatch is refused (doc/protocol.md 授权对象).
func TestGrantPayloadOneShotNodes(t *testing.T) {
	attempt := protocol.Uint(1)
	for _, tc := range []struct {
		name  string
		nodes []string
		tasks []string
		want  string
	}{
		{"group", []string{"group:web"}, []string{"t1"}, "node UUIDs"},
		{"star", []string{"*"}, []string{"t1"}, "node UUIDs"},
		{"short", []string{"n1"}, []string{"t1", "t2"}, "one --nodes node id per task"},
		{"long", []string{"n1", "n2"}, []string{"t1"}, "one --nodes node id per task"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			taskIDs := append([]string{}, tc.tasks...)
			deadline := protocol.Int(1700003600000)
			payload := &protocol.AuthorizationPayload{
				V:          protocol.AuthPayloadVersion,
				Nodes:      tc.nodes,
				IssuedAtMS: protocol.Int(1700000000000),
				DeadlineMS: &deadline,
				TaskIDs:    &taskIDs,
				Attempt:    &attempt,
			}
			raw, err := protocol.Marshal(payload)
			if err != nil {
				t.Fatal(err)
			}
			if _, _, err := grantPayloadOf(t, base64.StdEncoding.EncodeToString(raw)); err == nil {
				t.Fatalf("accepted a one-shot payload with %s", tc.name)
			} else if !strings.Contains(err.Error(), tc.want) {
				t.Fatalf("error %q does not contain %q", err, tc.want)
			}
		})
	}
	// The aligned multi-node payload is accepted and keeps its bytes.
	taskIDs := []string{"t1", "t2"}
	deadline := protocol.Int(1700003600000)
	payload := &protocol.AuthorizationPayload{
		V:          protocol.AuthPayloadVersion,
		Nodes:      []string{testNodeA, testNodeB},
		IssuedAtMS: protocol.Int(1700000000000),
		DeadlineMS: &deadline,
		TaskIDs:    &taskIDs,
		Attempt:    &attempt,
	}
	raw, err := protocol.Marshal(payload)
	if err != nil {
		t.Fatal(err)
	}
	got, gotRaw, err := grantPayloadOf(t, base64.StdEncoding.EncodeToString(raw))
	if err != nil {
		t.Fatalf("aligned payload refused: %v", err)
	}
	if !bytes.Equal(gotRaw, raw) || len(*got.TaskIDs) != 2 {
		t.Fatalf("payload = %+v", got)
	}
}

// grantPayloadOf is grantPayload without the flag validation, for a payload given as base64.
func grantPayloadOf(t *testing.T, encoded string) (*protocol.AuthorizationPayload, []byte, error) {
	t.Helper()
	opts := &grantOptions{payload: encoded, key: "k"}
	return grantPayload(opts)
}

// generateSSHKey creates an ed25519 key with ssh-keygen and returns its private path and public
// key. Tests that need the real tool skip when it is not installed.
func generateSSHKey(t *testing.T) (string, ssh.PublicKey) {
	t.Helper()
	real, err := exec.LookPath("ssh-keygen")
	if err != nil {
		t.Skip("ssh-keygen is not installed")
	}
	path := filepath.Join(t.TempDir(), "id_ed25519")
	cmd := exec.Command(real, "-t", "ed25519", "-N", "", "-C", "test", "-f", path)
	if out, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("ssh-keygen: %v: %s", err, out)
	}
	data, err := os.ReadFile(path + ".pub")
	if err != nil {
		t.Fatal(err)
	}
	public, _, _, _, err := ssh.ParseAuthorizedKey(data)
	if err != nil {
		t.Fatal(err)
	}
	return path, public
}

// decodeAuthorization decodes the base64 line `crha grant` printed.
func decodeAuthorization(t *testing.T, stdout string) *protocol.Authorization {
	t.Helper()
	line := strings.TrimSpace(stdout)
	raw, err := base64.StdEncoding.DecodeString(line)
	if err != nil {
		t.Fatalf("stdout %q is not base64: %v", stdout, err)
	}
	var authorization protocol.Authorization
	if err := protocol.Unmarshal(raw, &authorization); err != nil {
		t.Fatalf("decode the authorization: %v", err)
	}
	return &authorization
}

// TestGrantEndToEnd signs a payload built from the flags with the real ssh-keygen.
func TestGrantEndToEnd(t *testing.T) {
	keyPath, public := generateSSHKey(t)
	useSSHKeygen(t, "ssh-keygen")

	hash := strings.Repeat("cd", 32)
	stdout, stderr, err := runCLI(t, "grant",
		"--nodes", testNodeA+","+testNodeB,
		"--method", "exec",
		"--exact", "systemctl restart nginx",
		"--spec-sha256", hash,
		"--deadline", "1h",
		"--note", "signed in a test",
		"--key", keyPath,
		"--yes")
	if err != nil {
		t.Fatalf("grant: %v\nstderr: %s", err, stderr)
	}
	if strings.Count(strings.TrimSpace(stdout), "\n") != 0 {
		t.Fatalf("stdout is not one line: %q", stdout)
	}
	authorization := decodeAuthorization(t, stdout)
	if len(authorization.Signatures) != 1 || authorization.Signatures[0].Kind != protocol.SignatureSSHSig {
		t.Fatalf("signatures = %+v", authorization.Signatures)
	}
	payload, err := protocol.DecodeAuthorizationPayload(authorization.Payload)
	if err != nil {
		t.Fatalf("decode payload: %v", err)
	}
	if payload.Command.Match.Exact.Target != "systemctl restart nginx" ||
		fmt.Sprintf("%x", payload.Command.Match.Exact.SpecSHA256) != hash ||
		payload.Note != "signed in a test" {
		t.Fatalf("payload = %+v", payload)
	}
	result, err := authz.VerifySSHSIG(authorization.Signatures[0].SSHSig.Blob, authorization.Payload)
	if err != nil {
		t.Fatalf("verify: %v", err)
	}
	if !bytes.Equal(result.PublicKey.Marshal(), public.Marshal()) {
		t.Fatalf("signed by %s, want %s", ssh.FingerprintSHA256(result.PublicKey), ssh.FingerprintSHA256(public))
	}
	if !strings.Contains(stderr, "authorization_id") || !strings.Contains(stderr, ssh.FingerprintSHA256(public)) {
		t.Fatalf("stderr does not show the payload and the signer: %s", stderr)
	}

	// The same key signs a WebUI payload unchanged.
	payload = &protocol.AuthorizationPayload{
		V:          protocol.AuthPayloadVersion,
		Nodes:      []string{testNodeA},
		IssuedAtMS: protocol.Int(time.Now().Add(-time.Minute).UnixMilli()),
		TaskIDs:    &[]string{"task-1"},
	}
	ids := []string{"task-1"}
	attempt := protocol.Uint(1)
	deadline := protocol.Int(time.Now().Add(time.Hour).UnixMilli())
	payload.TaskIDs, payload.Attempt, payload.DeadlineMS = &ids, &attempt, &deadline
	raw, err := protocol.Marshal(payload)
	if err != nil {
		t.Fatal(err)
	}
	stdout, stderr, err = runCLI(t, "grant",
		"--payload", base64.StdEncoding.EncodeToString(raw),
		"--key", keyPath,
		"--yes")
	if err != nil {
		t.Fatalf("grant --payload: %v\nstderr: %s", err, stderr)
	}
	signed := decodeAuthorization(t, stdout)
	if !bytes.Equal(signed.Payload, raw) {
		t.Fatal("the signed payload differs from the given one")
	}
	if _, err := authz.VerifySSHSIG(signed.Signatures[0].SSHSig.Blob, signed.Payload); err != nil {
		t.Fatalf("verify: %v", err)
	}
}

// TestGrantRequiresDeadline covers that every authorization the flags sign must carry a
// deadline; without one nothing is shown or signed.
func TestGrantRequiresDeadline(t *testing.T) {
	_, _, err := runCLI(t, "grant", "--nodes", testNodeA, "--any-command", "--key", "k")
	if err == nil || !strings.Contains(err.Error(), "grant: --deadline is required") {
		t.Fatalf("grant without --deadline = %v, want the required --deadline error", err)
	}
}

// TestGrantPayloadRequiresDeadline covers a WebUI payload without a deadline: it is refused
// before the user sees or signs it, because the privileged mode would refuse it anyway.
func TestGrantPayloadRequiresDeadline(t *testing.T) {
	payload := &protocol.AuthorizationPayload{
		V:          protocol.AuthPayloadVersion,
		Nodes:      []string{testNodeA},
		IssuedAtMS: protocol.Int(1700000000000),
	}
	raw, err := protocol.Marshal(payload)
	if err != nil {
		t.Fatal(err)
	}
	_, _, err = grantPayloadOf(t, base64.StdEncoding.EncodeToString(raw))
	if err == nil || !strings.Contains(err.Error(), "has no deadline") {
		t.Fatalf("payload without a deadline = %v, want a missing-deadline error", err)
	}
}

// TestGrantConfirmation covers the prompt: a refusal signs nothing, a missing terminal refuses
// with a pointer to --yes, and "y" signs.
func TestGrantConfirmation(t *testing.T) {
	keyPath, _ := generateSSHKey(t)
	useSSHKeygen(t, "ssh-keygen")
	args := []string{"grant", "--nodes", testNodeA, "--any-command", "--deadline", "1h", "--key", keyPath}

	answerTerminal(t, "n\n")
	stdout, _, err := runCLI(t, args...)
	if err == nil || !strings.Contains(err.Error(), "not signed") {
		t.Fatalf("refusal = %v", err)
	}
	if stdout != "" {
		t.Fatalf("a refused authorization printed %q", stdout)
	}

	noTerminal(t)
	_, _, err = runCLI(t, args...)
	if err == nil || !strings.Contains(err.Error(), "--yes") {
		t.Fatalf("missing terminal = %v", err)
	}

	answerTerminal(t, "y\n")
	stdout, _, err = runCLI(t, args...)
	if err != nil {
		t.Fatalf("grant: %v", err)
	}
	if len(decodeAuthorization(t, stdout).Signatures) != 1 {
		t.Fatalf("stdout = %q", stdout)
	}
}

// TestGrantWrongSigner covers a signature that is valid but made by another key than --key: the
// fake ssh-keygen delegates to the real tool except for signing.
func TestGrantWrongSigner(t *testing.T) {
	real, err := exec.LookPath("ssh-keygen")
	if err != nil {
		t.Skip("ssh-keygen is not installed")
	}
	keyPath, _ := generateSSHKey(t)
	otherPath, _ := generateSSHKey(t)

	// The payload the another key signs, and the armored signature it prints.
	deadline := protocol.Int(time.Now().Add(time.Hour).UnixMilli())
	payload := &protocol.AuthorizationPayload{
		V:          protocol.AuthPayloadVersion,
		Nodes:      []string{testNodeA},
		IssuedAtMS: protocol.Int(time.Now().Add(-time.Minute).UnixMilli()),
		DeadlineMS: &deadline,
	}
	raw, err := protocol.Marshal(payload)
	if err != nil {
		t.Fatal(err)
	}
	dir := t.TempDir()
	signaturePath := filepath.Join(dir, "signature.pem")
	sign := exec.Command(real, "-Y", "sign", "-n", protocol.AuthNamespace, "-f", otherPath)
	sign.Stdin = bytes.NewReader(raw)
	signed, err := sign.Output()
	if err != nil {
		t.Fatalf("sign with the other key: %v", err)
	}
	if err := os.WriteFile(signaturePath, signed, 0o600); err != nil {
		t.Fatal(err)
	}

	fake := filepath.Join(dir, "ssh-keygen")
	script := fmt.Sprintf("#!/bin/sh\nif [ \"$1\" = \"-Y\" ]; then\n  cat %q\n  exit 0\nfi\nexec %q \"$@\"\n", signaturePath, real)
	if err := os.WriteFile(fake, []byte(script), 0o755); err != nil {
		t.Fatal(err)
	}
	useSSHKeygen(t, fake)

	stdout, _, err := runCLI(t, "grant",
		"--payload", base64.StdEncoding.EncodeToString(raw),
		"--key", keyPath,
		"--yes")
	if err == nil || !strings.Contains(err.Error(), "holds key") {
		t.Fatalf("signature by another key = %v", err)
	}
	if stdout != "" {
		t.Fatalf("a refused authorization printed %q", stdout)
	}
}

// TestGrantLongFlags covers the flags that are only reachable from the command line.
func TestGrantLongFlags(t *testing.T) {
	keyPath, _ := generateSSHKey(t)
	useSSHKeygen(t, "ssh-keygen")

	stdout, _, err := runCLI(t, "grant",
		"--nodes", testNodeA, "--nodes", testNodeB,
		"--method", "exec", "--prefix", "systemctl restart ",
		"--task", "task-1", "--task", "task-2", "--attempt", "2",
		"--deadline", "30m",
		"--key", keyPath, "--yes")
	if err != nil {
		t.Fatalf("grant: %v", err)
	}
	payload, err := protocol.DecodeAuthorizationPayload(decodeAuthorization(t, stdout).Payload)
	if err != nil {
		t.Fatal(err)
	}
	if len(payload.Nodes) != 2 || payload.Command.Match.Prefix.Target != "systemctl restart " {
		t.Fatalf("payload = %+v", payload)
	}
	if payload.TaskIDs == nil || len(*payload.TaskIDs) != 2 || *payload.Attempt != 2 {
		t.Fatalf("task_ids = %v attempt = %v", payload.TaskIDs, payload.Attempt)
	}

	if _, err := protocol.DecodeAuthorizationPayload([]byte("x")); err == nil {
		t.Fatal("invalid payload decoded")
	}
}

// TestGrantPrefixWarning covers the word-boundary warning of --prefix: a prefix that does not end
// with a space or "/" also matches longer words, and the warning says so without changing the
// prefix that is signed.
func TestGrantPrefixWarning(t *testing.T) {
	keyPath, _ := generateSSHKey(t)
	useSSHKeygen(t, "ssh-keygen")

	stdout, stderr, err := runCLI(t, "grant",
		"--nodes", testNodeA,
		"--method", "exec", "--prefix", "systemctl restart nginx",
		"--deadline", "1h",
		"--key", keyPath, "--yes")
	if err != nil {
		t.Fatalf("grant: %v\nstderr: %s", err, stderr)
	}
	for _, want := range []string{"warning: --prefix", "also matches longer words", "nginx-evil", "end it with a space"} {
		if !strings.Contains(stderr, want) {
			t.Fatalf("stderr has no %q:\n%s", want, stderr)
		}
	}
	payload, err := protocol.DecodeAuthorizationPayload(decodeAuthorization(t, stdout).Payload)
	if err != nil {
		t.Fatal(err)
	}
	if got := payload.Command.Match.Prefix.Target; got != "systemctl restart nginx" {
		t.Fatalf("prefix = %q, want the given one unchanged", got)
	}

	// A prefix that already ends at a word boundary needs no warning.
	_, stderr, err = runCLI(t, "grant",
		"--nodes", testNodeA,
		"--method", "exec", "--prefix", "systemctl restart nginx ",
		"--deadline", "1h",
		"--key", keyPath, "--yes")
	if err != nil {
		t.Fatalf("grant: %v\nstderr: %s", err, stderr)
	}
	if strings.Contains(stderr, "also matches longer words") {
		t.Fatalf("a word-boundary prefix was warned about:\n%s", stderr)
	}
}

// TestDarmorSignature covers the PEM armor ssh-keygen wraps an SSHSIG blob in.
func TestDarmorSignature(t *testing.T) {
	blob := []byte("SSHSIG and some bytes")
	armored := pem.EncodeToMemory(&pem.Block{Type: "SSH SIGNATURE", Bytes: blob})
	got, err := dearmorSignature(armored)
	if err != nil || !bytes.Equal(got, blob) {
		t.Fatalf("dearmor = %q, %v", got, err)
	}
	for _, bad := range [][]byte{
		nil,
		[]byte("not armored"),
		pem.EncodeToMemory(&pem.Block{Type: "OPENSSH PRIVATE KEY", Bytes: blob}),
		append(pem.EncodeToMemory(&pem.Block{Type: "SSH SIGNATURE", Bytes: blob}), []byte("trailing")...),
	} {
		if _, err := dearmorSignature(bad); err == nil {
			t.Fatalf("accepted %q", bad)
		}
	}
}
