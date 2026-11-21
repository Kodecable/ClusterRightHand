package upgrade

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/Kodecable/ClusterRightHand/client/internal/backup"
	"github.com/Kodecable/ClusterRightHand/client/internal/config"
	"github.com/Kodecable/ClusterRightHand/client/internal/setup"
	"github.com/Kodecable/ClusterRightHand/client/internal/tomledit"
	"github.com/Kodecable/ClusterRightHand/client/internal/units"
	"github.com/Kodecable/ClusterRightHand/client/internal/upgrade/marker"
	"github.com/pelletier/go-toml/v2/unstable/edit"
)

// fakeSystem records systemctl calls and answers journal follows from scripted lines.
type fakeSystem struct {
	calls []string
	// handOver and ready say whether the journal carries those lines.
	handOver, ready bool
	// failStart fails `systemctl start` of a unit.
	failStart string
	follows   [][]string
	// task is the task whose hand-over the journal carries, task-1 when empty.
	task string
	// onRun sees every call before it runs.
	onRun func(call string)
}

func (f *fakeSystem) Run(ctx context.Context, name string, args ...string) ([]byte, error) {
	call := name + " " + strings.Join(args, " ")
	if f.onRun != nil {
		f.onRun(call)
	}
	// As exec.CommandContext: a cancelled context runs nothing.
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	f.calls = append(f.calls, call)
	if f.failStart != "" && call == "systemctl start "+f.failStart {
		return []byte("failed"), errors.New("exit status 1")
	}
	return nil, nil
}

func (f *fakeSystem) Follow(ctx context.Context, args []string, match func([]byte) bool) error {
	f.follows = append(f.follows, args)
	line := func(msg string) []byte {
		data, _ := json.Marshal(map[string]string{"MESSAGE": msg, "_SYSTEMD_UNIT": units.Server})
		return data
	}
	lines := [][]byte{line("unrelated"), line(`msg="` + marker.HandOver("other-task") + `"`)}
	if f.handOver {
		task := f.task
		if task == "" {
			task = "task-1"
		}
		lines = append(lines, line(`level=INFO msg="`+marker.HandOver(task)+`"`))
	}
	if f.ready {
		lines = append(lines, line(`msg="`+marker.Ready("1.2.0")+`"`), line(`msg="`+marker.Ready("1.3.0")+`"`))
	}
	for _, l := range lines {
		if match(l) {
			return nil
		}
	}
	<-ctx.Done()
	return ctx.Err()
}

// fakeHost is setup.Host over a temporary root: every account exists and has the test's ids.
type fakeHost struct{ root string }

func (h fakeHost) Root() string { return h.root }
func (fakeHost) IsRoot() bool   { return true }
func (fakeHost) Exec(context.Context, string, ...string) (setup.CommandResult, error) {
	return setup.CommandResult{}, nil
}
func (fakeHost) Chown(string, string, string) error { return nil }
func (fakeHost) UID(string) (uint32, error)         { return uint32(os.Getuid()), nil }
func (fakeHost) GID(string) (uint32, error)         { return uint32(os.Getgid()), nil }
func (fakeHost) Executable() (string, error)        { return target, nil }

type node struct {
	root, dir, self string
	sys             *fakeSystem
	migrations      []Migration
}

const target = "/usr/local/bin/crha"

func newNode(t *testing.T, mode string) *node {
	t.Helper()
	root := t.TempDir()
	write := func(path, content string, perm os.FileMode) {
		full := filepath.Join(root, path)
		if err := os.MkdirAll(filepath.Dir(full), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(full, []byte(content), perm); err != nil {
			t.Fatal(err)
		}
	}
	write(target, "old crha", 0o755)
	write("/etc/crha/crha.toml", fmt.Sprintf("server = \"https://crh.example.com\"\nstate_dir = %q\n", t.TempDir()), 0o640)
	write(filepath.Join(units.Dir, units.Server), units.RenderServer(target, "/etc/crha/crha.toml", mode, "crha", "1.2.0"), 0o644)
	if mode == config.ModeForward {
		state := t.TempDir()
		write("/etc/crha/privileged.toml", fmt.Sprintf(`node_id          = "0192f000-0000-7000-8000-000000000001"
unprivileged_uid = 998
socket           = %q
state_dir        = %q
log              = %q

[[trust]]
name = "local-admins"
role = "local"
uids = [0]
`, filepath.Join(state, "priv.sock"), filepath.Join(state, "state"), filepath.Join(state, "log.jsonl")), 0o600)
		write(filepath.Join(units.Dir, units.Privileged), units.RenderPrivileged(target, "/etc/crha/privileged.toml", "1.2.0"), 0o644)
	}
	dir := filepath.Join(t.TempDir(), "crha-upgrade")
	self := filepath.Join(t.TempDir(), "crha-new")
	if err := os.WriteFile(self, []byte("new crha"), 0o700); err != nil {
		t.Fatal(err)
	}
	return &node{root: root, dir: dir, self: self, sys: &fakeSystem{handOver: true, ready: true}}
}

func (n *node) install(t *testing.T) error {
	t.Helper()
	return n.installFrom(t, "1.2.0", "1.3.0")
}

func (n *node) installFrom(t *testing.T, from, to string) error {
	t.Helper()
	return n.installTask(t, context.Background(), "task-1", from, to)
}

func (n *node) installTask(t *testing.T, ctx context.Context, task, from, to string) error {
	t.Helper()
	n.sys.task = task
	return Install(ctx, InstallOptions{
		From: from, To: to, TaskID: task,
		Self: n.self, Root: n.root, Dir: n.dir, Sys: n.sys, Host: fakeHost{n.root},
		HandOverTimeout: 50 * time.Millisecond, ReadyTimeout: 50 * time.Millisecond,
		Migrations: n.migrations, Stderr: io.Discard,
	})
}

func (n *node) read(t *testing.T, path string) string {
	t.Helper()
	data, err := os.ReadFile(filepath.Join(n.root, path))
	if err != nil {
		t.Fatal(err)
	}
	return string(data)
}

func (n *node) outcome(t *testing.T) Entry {
	t.Helper()
	entries, err := ReadLog(n.dir)
	if err != nil || len(entries) == 0 {
		t.Fatalf("log: %v, %d entries", err, len(entries))
	}
	return entries[len(entries)-1]
}

func TestInstallUpgradesForward(t *testing.T) {
	n := newNode(t, config.ModeForward)
	if err := n.install(t); err != nil {
		t.Fatal(err)
	}
	if got := n.read(t, target); got != "new crha" {
		t.Fatalf("binary = %q", got)
	}
	server := units.Parse(n.read(t, filepath.Join(units.Dir, units.Server)))
	privileged := units.Parse(n.read(t, filepath.Join(units.Dir, units.Privileged)))
	if server.Meta.Version != "1.3.0" || privileged.Meta.Version != "1.3.0" || server.Executable != target {
		t.Fatalf("units not regenerated: %+v %+v", server.Meta, privileged.Meta)
	}
	want := []string{
		"systemctl stop crha-privileged.service crha.service",
		"systemctl daemon-reload",
		"systemctl enable crha-privileged.service crha.service",
		"systemctl start crha-privileged.service",
		"systemctl start crha.service",
	}
	if !slices.Equal(n.sys.calls, want) {
		t.Fatalf("calls = %q\nwant %q", n.sys.calls, want)
	}
	if e := n.outcome(t); e.Step != OutcomeActivated || e.UpgradeID != "task-1" || e.From != "1.2.0" || e.To != "1.3.0" {
		t.Fatalf("outcome = %+v", e)
	}
	// The readiness wait looks only at lines after the start, from crha.service.
	ready := strings.Join(n.sys.follows[1], " ")
	if !strings.Contains(ready, "--since @") || !strings.Contains(ready, "_SYSTEMD_UNIT=crha.service") {
		t.Fatalf("readiness follow %q", ready)
	}
}

func TestInstallGivesUpWithoutTheHandOver(t *testing.T) {
	n := newNode(t, config.ModeNative)
	n.sys.handOver = false
	if err := n.install(t); err == nil {
		t.Fatal("installed without the hand-over")
	}
	if len(n.sys.calls) != 0 {
		t.Fatalf("changed the node: %q", n.sys.calls)
	}
	if got := n.read(t, target); got != "old crha" {
		t.Fatalf("binary = %q", got)
	}
	if e := n.outcome(t); e.Step != OutcomeFailed || !strings.Contains(e.Msg, "nothing was changed") {
		t.Fatalf("outcome = %+v", e)
	}
}

func TestInstallRollsBackWithoutReadiness(t *testing.T) {
	n := newNode(t, config.ModeForward)
	before := n.read(t, filepath.Join(units.Dir, units.Server))
	n.sys.ready = false
	if err := n.install(t); err == nil {
		t.Fatal("no error without readiness")
	}
	if got := n.read(t, target); got != "old crha" {
		t.Fatalf("binary after rollback = %q", got)
	}
	if got := n.read(t, filepath.Join(units.Dir, units.Server)); got != before {
		t.Fatal("unit not restored")
	}
	if e := n.outcome(t); e.Step != OutcomeRolledBack {
		t.Fatalf("outcome = %+v", e)
	}
	calls := strings.Join(n.sys.calls, "\n")
	if strings.Count(calls, "systemctl start crha.service") != 2 || strings.Count(calls, "daemon-reload") != 2 {
		t.Fatalf("calls = %q", n.sys.calls)
	}
}

func TestInstallStopsNothingWhenTheSelfTestFails(t *testing.T) {
	n := newNode(t, config.ModeNative)
	if err := os.WriteFile(filepath.Join(n.root, "/etc/crha/crha.toml"), []byte("unknown_key = 1\n"), 0o640); err != nil {
		t.Fatal(err)
	}
	if err := n.install(t); err == nil || !strings.Contains(err.Error(), "self-test") {
		t.Fatalf("err = %v", err)
	}
	// Planning comes before the hand-over and the stop: the node was not touched.
	if len(n.sys.calls) != 0 || len(n.sys.follows) != 0 {
		t.Fatalf("calls %q, follows %d", n.sys.calls, len(n.sys.follows))
	}
	if got := n.read(t, target); got != "old crha" {
		t.Fatalf("binary = %q", got)
	}
	if e := n.outcome(t); e.Step != OutcomeFailed || !strings.Contains(e.Msg, "nothing was changed") {
		t.Fatalf("outcome = %+v", e)
	}
}

func TestInstallRefusesADowngrade(t *testing.T) {
	for _, c := range [][2]string{{"1.3.0", "1.2.0"}, {"1.3.0", "1.3.0"}, {"1.3.0", "1.3.0-rc.1"}, {"dev", "1.3.0"}} {
		n := newNode(t, config.ModeNative)
		if err := n.installFrom(t, c[0], c[1]); err == nil {
			t.Fatalf("%s -> %s was installed", c[0], c[1])
		}
		if len(n.sys.calls) != 0 || n.read(t, target) != "old crha" {
			t.Fatalf("%s -> %s touched the node", c[0], c[1])
		}
	}
}

func TestASecondInstallDoesNotWriteTheLog(t *testing.T) {
	n := newNode(t, config.ModeNative)
	unlock, err := backup.Lock(n.dir)
	if err != nil {
		t.Fatal(err)
	}
	defer unlock()
	if err := n.install(t); err == nil {
		t.Fatal("installed without the lock")
	}
	if _, err := ReadLog(n.dir); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("the log was written without the lock: %v", err)
	}
}

func TestInstallKeepsUntouchedConfigurationByteForByte(t *testing.T) {
	n := newNode(t, config.ModeForward)
	before := n.read(t, "/etc/crha/privileged.toml") + n.read(t, "/etc/crha/crha.toml")
	if err := n.install(t); err != nil {
		t.Fatal(err)
	}
	if after := n.read(t, "/etc/crha/privileged.toml") + n.read(t, "/etc/crha/crha.toml"); after != before {
		t.Fatal("a configuration file without migrations changed")
	}
}

func TestInstallMigratesAndLogsIt(t *testing.T) {
	n := newNode(t, config.ModeNative)
	path := filepath.Join(n.root, "/etc/crha/crha.toml")
	old := n.read(t, "/etc/crha/crha.toml")
	if err := os.WriteFile(path, []byte("# kept\n"+old+"clock_warn = \"2m\"  # mine\n"), 0o640); err != nil {
		t.Fatal(err)
	}
	n.migrations = []Migration{
		{Version: "1.3.0", File: FileCrha, Edits: func(*edit.Document) []tomledit.Edit {
			return []tomledit.Edit{{Op: tomledit.Set, Path: []string{"clock_warn"}, Value: "0s"}}
		}},
		// Applies only from 1.4.0 on: not to this upgrade.
		{Version: "1.4.0", File: FileCrha, Edits: func(*edit.Document) []tomledit.Edit {
			return []tomledit.Edit{{Op: tomledit.Delete, Path: []string{"server"}}}
		}},
	}
	if err := n.install(t); err != nil {
		t.Fatal(err)
	}
	got := n.read(t, "/etc/crha/crha.toml")
	if !strings.Contains(got, "# kept\n") || !strings.Contains(got, "# mine") || !strings.Contains(got, "server =") {
		t.Fatalf("migrated file:\n%s", got)
	}
	cfg, err := config.Parse([]byte(got))
	if err != nil || cfg.ClockWarn != 0 {
		t.Fatalf("clock_warn = %v, %v", cfg.ClockWarn, err)
	}
	entries, _ := ReadLog(n.dir)
	var migrated []string
	for _, e := range entries {
		if e.Step == "migrate" {
			migrated = append(migrated, e.Msg)
		}
	}
	if len(migrated) != 1 || !strings.Contains(migrated[0], "set clock_warn") {
		t.Fatalf("migration log %q", migrated)
	}
}

func TestInstallStopsWhenAMigrationLeavesAnUnreadableFile(t *testing.T) {
	n := newNode(t, config.ModeNative)
	n.migrations = []Migration{{Version: "1.3.0", File: FileCrha, Edits: func(*edit.Document) []tomledit.Edit {
		return []tomledit.Edit{{Op: tomledit.Set, Path: []string{"no_such_key"}, Value: 1}}
	}}}
	if err := n.install(t); err == nil || !strings.Contains(err.Error(), "self-test") {
		t.Fatalf("err = %v", err)
	}
	if len(n.sys.calls) != 0 {
		t.Fatalf("calls %q", n.sys.calls)
	}
}

func TestInstallRefusesAnUnmanagedUnit(t *testing.T) {
	n := newNode(t, config.ModeNative)
	if err := os.WriteFile(filepath.Join(n.root, units.Dir, units.Server), []byte("[Service]\nExecStart=/x\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := n.install(t); err == nil {
		t.Fatal("installed over a hand-written unit")
	}
	if len(n.sys.calls) != 0 || len(n.sys.follows) != 0 {
		t.Fatalf("touched the node: %q", n.sys.calls)
	}
}

func TestLogKeepsTheLastLines(t *testing.T) {
	dir := t.TempDir()
	log := &Log{Path: filepath.Join(dir, LogName), UpgradeID: "u"}
	for i := 0; i < MaxLogLines+10; i++ {
		if err := log.Write("info", "step", fmt.Sprint(i)); err != nil {
			t.Fatal(err)
		}
	}
	entries, err := ReadLog(dir)
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != MaxLogLines || entries[0].Msg != "10" || entries[len(entries)-1].Msg != fmt.Sprint(MaxLogLines+9) {
		t.Fatalf("%d entries, first %q", len(entries), entries[0].Msg)
	}
	info, _ := os.Stat(filepath.Join(dir, LogName))
	if info.Mode().Perm() != 0o644 {
		t.Fatalf("log mode %v", info.Mode().Perm())
	}
	data, _ := os.ReadFile(filepath.Join(dir, LogName))
	if bytes.Count(data, []byte("\n")) != MaxLogLines {
		t.Fatal("not one entry per line")
	}
}

func TestOnlyOneInstallRuns(t *testing.T) {
	dir := t.TempDir()
	unlock, err := backup.Lock(dir)
	if err != nil {
		t.Fatal(err)
	}
	defer unlock()
	if _, err := backup.Lock(dir); err == nil {
		t.Fatal("a second lock was granted")
	}
}

// Failed attempts fill the log, but the lines of an upgrade whose backup still exists stay; those of one
// whose backup was pruned go.
func TestLogKeepsTheLinesOfKeptBackupsThroughFailures(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, LogName)
	manifest := filepath.Join(dir, "manifest.json")
	if err := os.WriteFile(manifest, []byte("{}"), 0o600); err != nil {
		t.Fatal(err)
	}
	pruned := &Log{Path: path, UpgradeID: "pruned", From: "1.1.0", To: "1.2.0"}
	_ = pruned.WriteManifest(filepath.Join(dir, "gone.json"))
	_ = pruned.Write("info", OutcomeActivated, "up")
	good := &Log{Path: path, UpgradeID: "good", From: "1.2.0", To: "1.3.0"}
	_ = good.WriteManifest(manifest)
	_ = good.Write("info", OutcomeActivated, "up")
	for i := 0; i < MaxLogLines; i++ {
		failed := &Log{Path: path, UpgradeID: fmt.Sprint("failed-", i), From: "1.3.0", To: "1.4.0"}
		_ = failed.Write("error", OutcomeRolledBack, "no")
	}
	entries, err := ReadLog(dir)
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != MaxLogLines || entries[0].UpgradeID != "good" || entries[1].Step != OutcomeActivated {
		t.Fatalf("%d entries, first %+v", len(entries), entries[0])
	}
}

// A log that cannot be read is left as it is: the line is lost, not the lines before it.
func TestLogIsNotReplacedWhenUnreadable(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, LogName)
	data := append(bytes.Repeat([]byte("x"), 2<<20), '\n')
	if err := os.WriteFile(path, data, 0o644); err != nil {
		t.Fatal(err)
	}
	log := &Log{Path: path, UpgradeID: "u"}
	if err := log.Write("info", "step", "m"); err == nil {
		t.Fatal("no error")
	}
	if got, _ := os.ReadFile(path); !bytes.Equal(got, data) {
		t.Fatal("the log was replaced")
	}
}

// A rollback that cannot restore the backup leaves the upgrade interrupted: no outcome, and the next
// upgrade refuses to build on its files.
func TestAFailedRollbackLeavesTheUpgradeInterrupted(t *testing.T) {
	n := newNode(t, config.ModeForward)
	n.sys.ready = false
	n.sys.onRun = func(call string) {
		if call != "systemctl start crha.service" {
			return
		}
		m, err := backup.Read(filepath.Join(n.dir, "backups", backup.UpgradeID("task-1"), backup.ManifestName))
		if err != nil {
			return
		}
		for _, e := range m.Entries {
			if e.Path == target {
				_ = os.Remove(e.Backup)
			}
		}
	}
	if err := n.installTask(t, context.Background(), "task-1", "1.2.0", "1.3.0"); err == nil {
		t.Fatal("no error")
	}
	entries, err := ReadLog(n.dir)
	if err != nil {
		t.Fatal(err)
	}
	if e, ok := interruptedUpgrade(entries); !ok || e.UpgradeID != "task-1" {
		t.Fatalf("not interrupted: %+v", entries[len(entries)-1])
	}
	n.sys.onRun = nil
	n.sys.calls = nil
	n.sys.ready = true
	err = n.installTask(t, context.Background(), "task-2", "1.2.0", "1.3.0")
	if err == nil || !strings.Contains(err.Error(), "interrupted") {
		t.Fatalf("err %v", err)
	}
	if len(n.sys.calls) != 0 {
		t.Fatalf("touched the node: %q", n.sys.calls)
	}
	if e, ok := interruptedUpgrade(mustReadLog(t, n.dir)); !ok || e.UpgradeID != "task-1" {
		t.Fatal("the refused upgrade hid the interrupted one")
	}
}

func mustReadLog(t *testing.T, dir string) []Entry {
	t.Helper()
	entries, err := ReadLog(dir)
	if err != nil {
		t.Fatal(err)
	}
	return entries
}

// The lines of a kept backup stay even when they alone pass MaxLogLines.
func TestLogNeverDropsTheLinesOfAKeptBackup(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, LogName)
	manifest := filepath.Join(dir, "manifest.json")
	if err := os.WriteFile(manifest, []byte("{}"), 0o600); err != nil {
		t.Fatal(err)
	}
	kept := &Log{Path: path, UpgradeID: "kept", From: "1.2.0", To: "1.3.0"}
	_ = kept.WriteManifest(manifest)
	for i := 0; i < MaxLogLines+10; i++ {
		_ = kept.Write("info", "migrate", fmt.Sprint(i))
	}
	next := &Log{Path: path, UpgradeID: "next", From: "1.3.0", To: "1.4.0"}
	_ = next.Write("info", "start", "s")
	entries := mustReadLog(t, dir)
	// Only the kept backup's lines and the one just written remain.
	if len(entries) != MaxLogLines+12 || entries[0].Manifest != manifest || entries[len(entries)-1].UpgradeID != "next" {
		t.Fatalf("%d entries, first %+v", len(entries), entries[0])
	}
}
