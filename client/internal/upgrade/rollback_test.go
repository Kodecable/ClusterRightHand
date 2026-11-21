package upgrade

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/Kodecable/ClusterRightHand/client/internal/backup"
	"github.com/Kodecable/ClusterRightHand/client/internal/config"
	"github.com/Kodecable/ClusterRightHand/client/internal/units"
)

// upgraded runs one real install from 1.2.0 to 1.3.0 on a fresh forward node.
func upgraded(t *testing.T) *node {
	t.Helper()
	n := newNode(t, config.ModeForward)
	if err := n.install(t); err != nil {
		t.Fatal(err)
	}
	n.sys.calls = nil
	return n
}

func (n *node) rollback(t *testing.T, force bool) error {
	t.Helper()
	return Rollback(context.Background(), RollbackOptions{Force: force, Root: n.root, Dir: n.dir, Sys: n.sys})
}

func (n *node) runningVersion(t *testing.T) string {
	t.Helper()
	return units.Parse(n.read(t, filepath.Join(units.Dir, units.Server))).Meta.Version
}

func TestRollbackUndoesTheUpgradeOfTheRunningVersion(t *testing.T) {
	n := upgraded(t)
	if v := n.runningVersion(t); v != "1.3.0" {
		t.Fatalf("running %s", v)
	}
	if !strings.Contains(Summary(n.root, n.dir), "rollback returns to 1.2.0") {
		t.Fatalf("summary %q", Summary(n.root, n.dir))
	}
	if err := n.rollback(t, false); err != nil {
		t.Fatal(err)
	}
	if n.read(t, target) != "old crha" || n.runningVersion(t) != "1.2.0" {
		t.Fatal("not rolled back")
	}
	calls := strings.Join(n.sys.calls, "\n")
	for _, want := range []string{"systemctl stop crha-privileged.service crha.service", "systemctl daemon-reload", "systemctl start crha.service"} {
		if !strings.Contains(calls, want) {
			t.Fatalf("calls %q", n.sys.calls)
		}
	}
	if e := n.outcome(t); e.Step != OutcomeRolledBack || !strings.Contains(e.Msg, "by hand") {
		t.Fatalf("outcome %+v", e)
	}
	// The running version is now 1.2.0, which no upgrade in the log produced: nothing more to undo.
	if err := n.rollback(t, false); err == nil || !strings.Contains(err.Error(), "produced crha 1.2.0") {
		t.Fatalf("second rollback: %v", err)
	}
}

func TestRollbackNeverUndoesAnUpgradeTheInstallerRolledBack(t *testing.T) {
	n := newNode(t, config.ModeNative)
	n.sys.ready = false
	if err := n.install(t); err == nil {
		t.Fatal("installed without readiness")
	}
	if err := n.rollback(t, false); err == nil {
		t.Fatal("rolled back an upgrade that never took effect")
	}
}

func TestRollbackRefusesChangedFilesUnlessForced(t *testing.T) {
	n := upgraded(t)
	conf := filepath.Join(n.root, "/etc/crha/crha.toml")
	data, _ := os.ReadFile(conf)
	if err := os.WriteFile(conf, append(data, []byte("# edited after the upgrade\n")...), 0o640); err != nil {
		t.Fatal(err)
	}
	err := n.rollback(t, false)
	if err == nil || !strings.Contains(err.Error(), "/etc/crha/crha.toml") || !strings.Contains(err.Error(), "--force") {
		t.Fatalf("err = %v", err)
	}
	if n.runningVersion(t) != "1.3.0" || len(n.sys.calls) != 0 {
		t.Fatal("a refused rollback touched the node")
	}
	if err := n.rollback(t, true); err != nil {
		t.Fatal(err)
	}
	if strings.Contains(n.read(t, "/etc/crha/crha.toml"), "edited after the upgrade") {
		t.Fatal("the forced rollback did not restore the file")
	}
}

func TestRollbackNeedsTheBackup(t *testing.T) {
	n := upgraded(t)
	if err := os.RemoveAll(filepath.Join(n.dir, "backups", "task-task-1")); err != nil {
		t.Fatal(err)
	}
	if err := n.rollback(t, false); err == nil || !strings.Contains(err.Error(), "gone") {
		t.Fatalf("err = %v", err)
	}
}

func TestRollbackWaitsForTheLock(t *testing.T) {
	n := upgraded(t)
	unlock, err := lock(n.dir)
	if err != nil {
		t.Fatal(err)
	}
	defer unlock()
	if err := n.rollback(t, false); err == nil {
		t.Fatal("rolled back while another holds the lock")
	}
}

func TestRollbackStepsBackThroughTwoUpgrades(t *testing.T) {
	n := upgraded(t)
	// A second upgrade, 1.3.0 -> 1.4.0, from the files the first one left.
	if err := os.WriteFile(n.self, []byte("newer crha"), 0o700); err != nil {
		t.Fatal(err)
	}
	n.sys.calls = nil
	if err := Install(context.Background(), InstallOptions{
		From: "1.3.0", To: "1.4.0", TaskID: "task-2", Self: n.self, Root: n.root, Dir: n.dir, Sys: n.sys,
		Host: fakeHost{n.root}, HandOverTimeout: 50e6, ReadyTimeout: 50e6,
	}); err == nil {
		// The fake journal reports readiness only for 1.2.0 and 1.3.0.
		t.Fatal("expected the 1.4.0 readiness to be missing")
	}
	// That upgrade rolled itself back; the node runs 1.3.0 and one rollback goes to 1.2.0.
	if n.runningVersion(t) != "1.3.0" {
		t.Fatalf("running %s", n.runningVersion(t))
	}
	if err := n.rollback(t, false); err != nil {
		t.Fatal(err)
	}
	if n.runningVersion(t) != "1.2.0" || n.read(t, target) != "old crha" {
		t.Fatal("not back at 1.2.0")
	}
}

// Failed upgrades after the one that produced the running version must not prune its backup away.
func TestFailedUpgradesKeepTheBackupARollbackNeeds(t *testing.T) {
	n := upgraded(t)
	n.sys.ready = false
	for _, task := range []string{"task-2", "task-3", "task-4"} {
		if err := n.installTask(t, context.Background(), task, "1.3.0", "1.4.0"); err == nil {
			t.Fatalf("%s: no error without readiness", task)
		}
	}
	if _, err := os.Stat(filepath.Join(n.dir, "backups", backup.UpgradeID("task-1"), backup.ManifestName)); err != nil {
		t.Fatalf("the backup of the running version's upgrade was pruned: %v", err)
	}
	n.sys.ready = true
	if err := n.rollback(t, false); err != nil {
		t.Fatal(err)
	}
	if n.read(t, target) != "old crha" {
		t.Fatal("not rolled back")
	}
}

// An upgrade killed after its backup, before any outcome, can be rolled back by hand; a file it had not
// reached yet does not count as changed.
func TestRollbackUndoesAnInterruptedUpgrade(t *testing.T) {
	n := upgraded(t)
	logPath := filepath.Join(n.dir, LogName)
	data, err := os.ReadFile(logPath)
	if err != nil {
		t.Fatal(err)
	}
	var kept []string
	for _, line := range strings.Split(strings.TrimSpace(string(data)), "\n") {
		kept = append(kept, line)
		if strings.Contains(line, `"backed_up"`) {
			break
		}
	}
	if err := os.WriteFile(logPath, []byte(strings.Join(kept, "\n")+"\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	// Killed after the binary but before the unit: the unit is as it was.
	plan, err := PlanRollback(n.root, n.dir)
	if err != nil {
		t.Fatal(err)
	}
	for _, e := range plan.Manifest.Entries {
		if e.Path == filepath.Join(units.Dir, units.Server) {
			old, err := os.ReadFile(e.Backup)
			if err != nil {
				t.Fatal(err)
			}
			if err := os.WriteFile(filepath.Join(n.root, e.Path), old, 0o644); err != nil {
				t.Fatal(err)
			}
		}
	}
	plan, err = PlanRollback(n.root, n.dir)
	if err != nil || !plan.Interrupted || len(plan.Modified) != 0 {
		t.Fatalf("plan %+v, %v", plan, err)
	}
	if err := n.rollback(t, false); err != nil {
		t.Fatal(err)
	}
	if n.read(t, target) != "old crha" {
		t.Fatal("the binary was not restored")
	}
	if e := n.outcome(t); e.Step != OutcomeRolledBack {
		t.Fatalf("outcome %+v", e)
	}
}

// The installer stopped by systemd (SIGTERM cancels its context) still rolls back to the end.
func TestInstallRollsBackWhenStopped(t *testing.T) {
	n := newNode(t, config.ModeForward)
	n.sys.ready = false
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	n.sys.onRun = func(call string) {
		if call == "systemctl start crha.service" {
			cancel()
		}
	}
	if err := n.installTask(t, ctx, "task-1", "1.2.0", "1.3.0"); err == nil {
		t.Fatal("no error")
	}
	if n.read(t, target) != "old crha" {
		t.Fatal("not rolled back")
	}
	// The context was cancelled at the new version's start; the rollback still starts the old one.
	if last := n.sys.calls[len(n.sys.calls)-1]; last != "systemctl start crha.service" {
		t.Fatalf("the old version was not started again: %q", n.sys.calls)
	}
	if e := n.outcome(t); e.Step != OutcomeRolledBack {
		t.Fatalf("outcome %+v", e)
	}
}
