package setup

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/Kodecable/ClusterRightHand/client/internal/backup"
	"github.com/Kodecable/ClusterRightHand/client/internal/config"
	"github.com/Kodecable/ClusterRightHand/client/internal/enroll"
	"github.com/Kodecable/ClusterRightHand/client/internal/units"
)

func keepWith(extra map[string]any) map[string]any {
	answers := map[string]any{"version": 1, "replace": false, "service": map[string]any{"start": true}}
	for key, value := range extra {
		answers[key] = value
	}
	return answers
}

func backups(t *testing.T, host *fakeHost) []string {
	t.Helper()
	entries, err := os.ReadDir(at(host, backup.Dir))
	if err != nil {
		return nil
	}
	var names []string
	for _, e := range entries {
		names = append(names, e.Name())
	}
	return names
}

func TestSwitchTLSOnTheKeepPathEditsInPlace(t *testing.T) {
	host := newFakeHost(t)
	register, calls := fakeRegister(host)
	if err := runEnroll(t, host, ignoreAnswers(), register, &strings.Builder{}); err != nil {
		t.Fatal(err)
	}
	path := at(host, DefaultConfigPath)
	original := "# managed by ops\n" + readFile(t, path)
	if err := os.WriteFile(path, []byte(original), 0o640); err != nil {
		t.Fatal(err)
	}
	host.commands = nil
	var out strings.Builder
	if err := runEnroll(t, host, keepWith(map[string]any{"tls_verify": "none"}), register, &out); err != nil {
		t.Fatal(err)
	}
	if *calls != 1 {
		t.Fatalf("the keep path registered again: %d calls", *calls)
	}
	got := readFile(t, path)
	cfg, err := config.Parse([]byte(got))
	if err != nil || cfg.TLSVerify != "none" || cfg.Server != "https://crh.example.com" {
		t.Fatalf("crha.toml after the switch: %v\n%s", err, got)
	}
	if !strings.HasPrefix(got, "# managed by ops\n") {
		t.Fatalf("the comment was lost:\n%s", got)
	}
	if !strings.Contains(out.String(), "changed: "+DefaultConfigPath+": tls_verify: system -> none") {
		t.Fatalf("output:\n%s", out.String())
	}
	saved := backups(t, host)
	if len(saved) != 1 || !strings.HasPrefix(saved[0], "enroll-") {
		t.Fatalf("backups %q", saved)
	}
	m, err := backup.Read(filepath.Join(at(host, backup.Dir), saved[0], backup.ManifestName))
	if err != nil {
		t.Fatal(err)
	}
	if err := backup.Restore(host.root, m); err != nil {
		t.Fatal(err)
	}
	if readFile(t, path) != original {
		t.Fatal("the backup does not hold the previous crha.toml")
	}
	wantCommandsInOrder(t, host, "systemctl stop crha.service", "systemctl start crha.service")
}

func TestSwitchFromForwardToIgnoreRemovesThePrivilegedUnit(t *testing.T) {
	host := newFakeHost(t)
	register, _ := fakeRegister(host)
	if err := runEnroll(t, host, forwardAnswers(t), register, &strings.Builder{}); err != nil {
		t.Fatal(err)
	}
	host.commands = nil
	var out strings.Builder
	answers := keepWith(map[string]any{"privileged": map[string]any{"mode": "ignore"}})
	if err := runEnroll(t, host, answers, register, &out); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(at(host, filepath.Join(UnitDir, units.Privileged))); !os.IsNotExist(err) {
		t.Fatal("crha-privileged.service is still there")
	}
	if !host.hasCommand("systemctl disable --now crha-privileged") {
		t.Fatalf("the privileged mode was not stopped: %q", host.commands)
	}
	if _, err := os.Stat(at(host, PrivilegedConfigPath)); err != nil {
		t.Fatal("privileged.toml was removed; it stays for a way back")
	}
	cfg, err := config.Parse([]byte(readFile(t, at(host, DefaultConfigPath))))
	if err != nil || cfg.Privilege.Mode != config.ModeIgnore {
		t.Fatalf("mode %v, %v", cfg, err)
	}
}

func TestSwitchFromIgnoreToForwardOnReenrollment(t *testing.T) {
	host := newFakeHost(t)
	register, _ := fakeRegister(host)
	if err := runEnroll(t, host, ignoreAnswers(), register, &strings.Builder{}); err != nil {
		t.Fatal(err)
	}
	answers := map[string]any{
		"version":    1,
		"replace":    true,
		"token":      "crh1.fp.secret",
		"privileged": map[string]any{"mode": "forward", "local_root": true, "trust": trustEntry(t)},
		"service":    map[string]any{"start": true},
	}
	if err := runEnroll(t, host, answers, register, &strings.Builder{}); err != nil {
		t.Fatal(err)
	}
	cfg, err := config.Parse([]byte(readFile(t, at(host, DefaultConfigPath))))
	if err != nil || cfg.Privilege.Mode != config.ModeForward || cfg.Privilege.Socket != PrivilegedSocket {
		t.Fatalf("crha.toml %+v, %v", cfg, err)
	}
	if !strings.Contains(readFile(t, at(host, PrivilegedConfigPath)), "0192f000-0000-7000-8000-000000000001") {
		t.Fatal("privileged.toml was not written with the node id")
	}
	if !strings.Contains(readFile(t, at(host, filepath.Join(UnitDir, units.Privileged))), "privileged run") {
		t.Fatal("crha-privileged.service was not written")
	}
}

func TestReplaceTrustKeepsTheRestOfPrivilegedConfig(t *testing.T) {
	host := newFakeHost(t)
	register, _ := fakeRegister(host)
	if err := runEnroll(t, host, forwardAnswers(t), register, &strings.Builder{}); err != nil {
		t.Fatal(err)
	}
	path := at(host, PrivilegedConfigPath)
	if err := os.WriteFile(path, []byte("# the node's trust, see the runbook\n"+readFile(t, path)), 0o600); err != nil {
		t.Fatal(err)
	}
	newEntry := strings.Replace(trustEntry(t), `name = "crhs"`, `name = "crhs-2026"`, 1)
	answers := keepWith(map[string]any{"privileged": map[string]any{"local_root": false, "trust": newEntry}})
	var out strings.Builder
	if err := runEnroll(t, host, answers, register, &out); err != nil {
		t.Fatal(err)
	}
	got := readFile(t, path)
	for _, want := range []string{"# the node's trust, see the runbook", "0192f000-0000-7000-8000-000000000001", `name = "crhs-2026"`} {
		if !strings.Contains(got, want) {
			t.Fatalf("privileged.toml lacks %q:\n%s", want, got)
		}
	}
	if strings.Contains(got, "local-root") || strings.Count(got, "[[trust]]") != 1 {
		t.Fatalf("the old entries were not replaced:\n%s", got)
	}
	if names := trustNamesOf([]byte(got)); len(names) != 1 || names[0] != "crhs-2026" {
		t.Fatalf("trust names %q", names)
	}
	if !strings.Contains(out.String(), "changed: the trust entries of "+PrivilegedConfigPath) {
		t.Fatalf("output:\n%s", out.String())
	}
}

func TestRerunWithoutChangesBacksUpAndRestartsNothing(t *testing.T) {
	host := newFakeHost(t)
	register, _ := fakeRegister(host)
	answers := forwardAnswers(t)
	if err := runEnroll(t, host, answers, register, &strings.Builder{}); err != nil {
		t.Fatal(err)
	}
	host.commands = nil
	if err := runEnroll(t, host, keepWith(nil), register, &strings.Builder{}); err != nil {
		t.Fatal(err)
	}
	if saved := backups(t, host); len(saved) != 0 {
		t.Fatalf("an unchanged node was backed up: %q", saved)
	}
	for _, command := range host.commands {
		if strings.HasPrefix(command, "systemctl stop") {
			t.Fatalf("an unchanged node was stopped: %q", host.commands)
		}
	}
}

func reenrollWith(extra map[string]any) map[string]any {
	answers := map[string]any{"version": 1, "replace": true, "token": "crh1.fp.secret", "service": map[string]any{"start": true}}
	for key, value := range extra {
		answers[key] = value
	}
	return answers
}

func TestReenrollKeepingTheNodeSaysSo(t *testing.T) {
	host := newFakeHost(t)
	register, _ := fakeRegister(host)
	if err := runEnroll(t, host, forwardAnswers(t), register, &strings.Builder{}); err != nil {
		t.Fatal(err)
	}
	host.commands = nil
	var out strings.Builder
	answers := reenrollWith(map[string]any{"privileged": map[string]any{"local_root": true, "trust": trustEntry(t)}})
	if err := runEnroll(t, host, answers, register, &out); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(out.String(), "enrolled node "+testNodeID+" again with a new key") {
		t.Fatalf("output:\n%s", out.String())
	}
	if strings.Contains(out.String(), "previous node") || strings.Contains(out.String(), "node_id:") {
		t.Fatalf("a new key for the same node was reported as a new node:\n%s", out.String())
	}
	// No file changes, but the running crha must not keep the old key: the units stop before
	// registering and start after.
	wantCommandsInOrder(t, host,
		"systemctl stop crha-privileged.service crha.service",
		"systemctl start crha-privileged.service",
		"systemctl start crha.service")
}

// A New node token on a forward node registers another node: privileged.toml must follow it, or the
// privileged mode refuses every task of the new node.
func TestReenrollAsANewNodeMovesPrivilegedConfigToTheNewID(t *testing.T) {
	host := newFakeHost(t)
	register, _ := fakeRegister(host)
	answers := forwardAnswers(t)
	if err := runEnroll(t, host, answers, register, &strings.Builder{}); err != nil {
		t.Fatal(err)
	}
	path := at(host, PrivilegedConfigPath)
	original := "# kept by ops\n" + readFile(t, path)
	if err := os.WriteFile(path, []byte(original), 0o600); err != nil {
		t.Fatal(err)
	}
	const newID = "0192f000-0000-7000-8000-000000000002"
	registerNew, _ := fakeRegisterAs(host, newID)
	var out strings.Builder
	again := reenrollWith(map[string]any{"privileged": map[string]any{"local_root": true, "trust": trustEntry(t)}})
	if err := runEnroll(t, host, again, registerNew, &out); err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{
		"enrolled as a new node " + newID,
		"the previous node " + testNodeID + " stays on crhs",
		"changed: " + PrivilegedConfigPath + ": node_id: " + testNodeID + " -> " + newID,
	} {
		if !strings.Contains(out.String(), want) {
			t.Fatalf("output lacks %q:\n%s", want, out.String())
		}
	}
	got := readFile(t, path)
	if !strings.HasPrefix(got, "# kept by ops\n") || !strings.Contains(got, newID) || strings.Contains(got, testNodeID) {
		t.Fatalf("privileged.toml:\n%s", got)
	}
	saved := backups(t, host)
	if len(saved) != 1 {
		t.Fatalf("backups %q", saved)
	}
	m, err := backup.Read(filepath.Join(at(host, backup.Dir), saved[0], backup.ManifestName))
	if err != nil {
		t.Fatal(err)
	}
	if modified, err := backup.Modified(host.root, m); err != nil || len(modified) != 0 {
		t.Fatalf("the backup does not record what enroll left: %q, %v", modified, err)
	}
	if err := backup.Restore(host.root, m); err != nil {
		t.Fatal(err)
	}
	if readFile(t, path) != original {
		t.Fatal("the backup does not hold the previous privileged.toml")
	}
	wantCommandsInOrder(t, host,
		"systemctl stop crha-privileged.service crha.service",
		"systemctl start crha-privileged.service",
		"systemctl start crha.service")
}

// A node enrolled before crha recorded its id falls back to the one privileged.toml names.
func TestPreviousNodeIDFallsBackToPrivilegedConfig(t *testing.T) {
	host := newFakeHost(t)
	register, _ := fakeRegister(host)
	if err := runEnroll(t, host, forwardAnswers(t), register, &strings.Builder{}); err != nil {
		t.Fatal(err)
	}
	if err := os.Remove(at(host, filepath.Join(StateDir, "node_id"))); err != nil {
		t.Fatal(err)
	}
	if got := previousNodeID(host, StateDir); got != testNodeID {
		t.Fatalf("previous node id %q", got)
	}
}

// A refused token changes no file: registration runs before anything is written.
func TestFailedRegistrationLeavesTheSwitchUnwritten(t *testing.T) {
	host := newFakeHost(t)
	register, _ := fakeRegister(host)
	if err := runEnroll(t, host, ignoreAnswers(), register, &strings.Builder{}); err != nil {
		t.Fatal(err)
	}
	before := readFile(t, at(host, DefaultConfigPath))
	refuse := func(context.Context, *config.Config, string, bool) (enroll.Result, error) {
		return enroll.Result{}, errors.New("token refused")
	}
	err := runEnroll(t, host, reenrollWith(map[string]any{"tls_verify": "none"}), refuse, &strings.Builder{})
	if err == nil || !strings.Contains(err.Error(), "token refused") {
		t.Fatalf("err %v", err)
	}
	if readFile(t, at(host, DefaultConfigPath)) != before {
		t.Fatal("crha.toml changed although registration failed")
	}
	if saved := backups(t, host); len(saved) != 0 {
		t.Fatalf("backups %q", saved)
	}
	wantCommandsInOrder(t, host, "systemctl stop crha.service", "systemctl start crha.service")
}

// wantCommandsInOrder checks that the commands ran in this order, others in between.
func wantCommandsInOrder(t *testing.T, host *fakeHost, want ...string) {
	t.Helper()
	i := 0
	for _, command := range host.commands {
		if i < len(want) && command == want[i] {
			i++
		}
	}
	if i < len(want) {
		t.Fatalf("commands %q do not run %q in order", host.commands, want)
	}
}

// privileged.toml kept outside forward mode follows a new node too, so the way back still works.
func TestNewNodeInIgnoreModeUpdatesTheKeptPrivilegedConfig(t *testing.T) {
	host := newFakeHost(t)
	register, _ := fakeRegister(host)
	if err := runEnroll(t, host, forwardAnswers(t), register, &strings.Builder{}); err != nil {
		t.Fatal(err)
	}
	if err := runEnroll(t, host, keepWith(map[string]any{"privileged": map[string]any{"mode": "ignore"}}), register, &strings.Builder{}); err != nil {
		t.Fatal(err)
	}
	const newID = "0192f000-0000-7000-8000-000000000003"
	registerNew, _ := fakeRegisterAs(host, newID)
	if err := runEnroll(t, host, reenrollWith(map[string]any{"privileged": map[string]any{"mode": "ignore"}}), registerNew, &strings.Builder{}); err != nil {
		t.Fatal(err)
	}
	if got := readFile(t, at(host, PrivilegedConfigPath)); !strings.Contains(got, newID) {
		t.Fatalf("privileged.toml:\n%s", got)
	}
	if _, err := os.Stat(at(host, filepath.Join(UnitDir, units.Privileged))); !os.IsNotExist(err) {
		t.Fatal("crha-privileged.service came back in ignore mode")
	}
}
