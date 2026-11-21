package upgrade

import (
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/Kodecable/ClusterRightHand/client/internal/backup"
	"github.com/Kodecable/ClusterRightHand/client/internal/units"
)

// RollbackPlan is the upgrade a rollback undoes.
type RollbackPlan struct {
	UpgradeID    string
	From, To     string
	Manifest     *backup.Manifest
	ManifestPath string
	// Interrupted means the upgrade stopped after its backup and never recorded an outcome.
	Interrupted bool
	// Modified lists the files of the set that changed since the upgrade wrote them.
	Modified []string
}

// interruptedUpgrade is the latest upgrade that backed the fixed set up, if it never recorded an outcome:
// the installer was killed or the host lost power while it replaced the files, or its rollback failed.
// Its files may be half written, whatever version the units name, and only a rollback by hand ends it.
// Upgrades after it that stopped before their own backup changed nothing and do not hide it.
func interruptedUpgrade(entries []Entry) (Entry, bool) {
	var latest Entry
	for _, e := range entries {
		if e.Manifest != "" {
			latest = e
		}
	}
	if latest.Manifest == "" {
		return Entry{}, false
	}
	for _, e := range entries {
		if e.UpgradeID == latest.UpgradeID && isOutcome(e.Step) {
			return Entry{}, false
		}
	}
	return latest, true
}

func isOutcome(step string) bool {
	return step == OutcomeActivated || step == OutcomeRolledBack || step == OutcomeFailed
}

// PlanRollback finds the upgrade to undo (doc/design/distribution.md "Upgrade log"). An interrupted
// upgrade (interruptedUpgrade) comes first. Otherwise it is the latest activated upgrade whose target is
// the version the units run now, from a lower release. Matching the running version means an upgrade
// that was already rolled back, by the installer or by hand, is never undone twice, and repeating the
// rollback steps back through older upgrades while their backups last. The caller holds the install
// lock, so an upgrade without an outcome is not one still running.
func PlanRollback(root, dir string) (*RollbackPlan, error) {
	server, err := readManagedUnit(root, units.Server)
	if err != nil {
		return nil, err
	}
	current := server.Meta.Version
	entries, err := ReadLog(dir)
	if errors.Is(err, os.ErrNotExist) {
		return nil, errors.New("no upgrade has run on this node")
	}
	if err != nil {
		return nil, fmt.Errorf("read the upgrade log: %w", err)
	}
	activated := map[string]bool{}
	manifests := map[string]string{}
	for _, e := range entries {
		if e.Step == OutcomeActivated {
			activated[e.UpgradeID] = true
		}
		if e.Manifest != "" {
			manifests[e.UpgradeID] = e.Manifest
		}
	}
	var plan *RollbackPlan
	if e, ok := interruptedUpgrade(entries); ok {
		plan = &RollbackPlan{UpgradeID: e.UpgradeID, From: e.From, To: e.To, Interrupted: true}
	}
	for i := len(entries) - 1; i >= 0 && plan == nil; i-- {
		e := entries[i]
		if e.To == current && activated[e.UpgradeID] {
			plan = &RollbackPlan{UpgradeID: e.UpgradeID, From: e.From, To: e.To}
		}
	}
	if plan == nil {
		return nil, fmt.Errorf("no upgrade in the log produced crha %s, which runs now", current)
	}
	plan.ManifestPath = manifests[plan.UpgradeID]
	if checkUpgrade(plan.From, plan.To) != nil {
		return nil, fmt.Errorf("a rollback goes to a lower release, not from %s to %s", plan.To, plan.From)
	}
	if plan.ManifestPath == "" {
		return nil, fmt.Errorf("the upgrade to %s recorded no backup", plan.To)
	}
	if plan.Manifest, err = backup.Read(plan.ManifestPath); err != nil {
		return nil, fmt.Errorf("the backup of the upgrade to %s is gone: %w", plan.To, err)
	}
	for _, e := range plan.Manifest.Entries {
		if e.Existed {
			if _, err := os.Stat(e.Backup); err != nil {
				return nil, fmt.Errorf("the backup of %s is gone: %w", e.Path, err)
			}
		}
	}
	if plan.Modified, err = backup.Modified(root, plan.Manifest); err != nil {
		return nil, err
	}
	if plan.Interrupted {
		// An interrupted upgrade may not have reached a file yet: one still as it was before is not
		// a change made since.
		var modified []string
		for _, path := range plan.Modified {
			if same, err := backup.Unchanged(root, plan.Manifest, path); err != nil {
				return nil, err
			} else if !same {
				modified = append(modified, path)
			}
		}
		plan.Modified = modified
	}
	return plan, nil
}

// RollbackOptions are a rollback's inputs.
type RollbackOptions struct {
	// Force restores the backup over files that changed since the upgrade.
	Force bool
	// Root, Dir and Sys replace the real ones (tests).
	Root string
	Dir  string
	Sys  System
	Now  func() time.Time
	Out  io.Writer
}

// Rollback undoes the upgrade that produced the running version: it restores the files it replaced,
// reloads systemd and starts the units the old version ran. It takes the install lock and records the
// rollback in the upgrade log.
func Rollback(ctx context.Context, opts RollbackOptions) error {
	if opts.Sys == nil {
		opts.Sys = ExecSystem{}
	}
	if opts.Out == nil {
		opts.Out = io.Discard
	}
	dir := opts.Dir
	if dir == "" {
		dir = Dir
	}
	unlock, err := backup.Lock(dir)
	if err != nil {
		return err
	}
	defer unlock()
	plan, err := PlanRollback(opts.Root, dir)
	if err != nil {
		return err
	}
	if len(plan.Modified) > 0 && !opts.Force {
		return fmt.Errorf("these files changed since the upgrade to %s, and a rollback would overwrite them: %s (use --force to restore anyway)",
			plan.To, strings.Join(plan.Modified, ", "))
	}
	m := plan.Manifest
	log := &Log{Path: filepath.Join(dir, LogName), UpgradeID: plan.UpgradeID, From: plan.From, To: plan.To, Now: opts.Now}
	ctx = context.WithoutCancel(ctx)
	if err := units.Stop(ctx, opts.Sys.Run, m.Units); err != nil {
		// Nothing was restored: the units run on as they were.
		err = errors.Join(err, units.Start(ctx, opts.Sys.Run, m.Units))
		_ = log.Write("error", "rollback", "rollback by hand: "+err.Error())
		return err
	}
	// A file that cannot be put back does not keep the others stopped: the units start either way.
	restoreErr := backup.Restore(opts.Root, m)
	reloadErr := units.Systemctl(ctx, opts.Sys.Run, "daemon-reload")
	startErr := units.Start(ctx, opts.Sys.Run, m.Units)
	if err := errors.Join(restoreErr, reloadErr, startErr); err != nil {
		// Not an outcome: the upgrade stays the one to undo, and the rollback can be repeated.
		_ = log.Write("error", "rollback", "rollback by hand: "+err.Error())
		return err
	}
	_ = log.Write("info", OutcomeRolledBack, fmt.Sprintf("rolled back to crha %s by hand", plan.From))
	fmt.Fprintf(opts.Out, "rolled back crha %s to %s and started %v\n", plan.To, plan.From, m.Units)
	return nil
}

// Summary is the first line of `crha upgrade status`: the last upgrade's outcome, and what a rollback
// would do now.
func Summary(root, dir string) string {
	entries, err := ReadLog(dir)
	if err != nil || len(entries) == 0 {
		return "no upgrade has run on this node"
	}
	var last Entry
	for i := len(entries) - 1; i >= 0; i-- {
		if isOutcome(entries[i].Step) {
			last = entries[i]
		}
		if last.Step != "" {
			break
		}
	}
	line := "last upgrade: in progress or interrupted"
	if last.Step != "" {
		line = fmt.Sprintf("last upgrade: %s → %s, %s", last.From, last.To, last.Step)
	}
	if plan, err := PlanRollback(root, dir); err == nil {
		line += fmt.Sprintf("; crha upgrade rollback returns to %s", plan.From)
		if len(plan.Modified) > 0 {
			line += fmt.Sprintf(" (needs --force: %s changed)", strings.Join(plan.Modified, ", "))
		}
	} else {
		line += "; no rollback: " + err.Error()
	}
	return line
}
