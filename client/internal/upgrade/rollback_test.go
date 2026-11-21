package upgrade

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"

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
