package upgrade

import (
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strconv"
	"syscall"
	"time"

	"github.com/Kodecable/ClusterRightHand/client/internal/backup"
	"github.com/Kodecable/ClusterRightHand/client/internal/setup"
	"github.com/Kodecable/ClusterRightHand/client/internal/units"
	"github.com/Kodecable/ClusterRightHand/client/internal/upgrade/marker"
)

const (
	// HandOverTimeout bounds the wait for crhs to acknowledge the upgrade task's result. Without the
	// acknowledgement crhs is unreachable, and the readiness check would fail anyway.
	HandOverTimeout = 60 * time.Second
	// ReadyTimeout bounds the wait for the new crha's readiness line before the rollback.
	ReadyTimeout = 120 * time.Second
)

// testReadyTimeout, set with -ldflags -X by the upgrade system tests only (for example "30s"), shortens
// ReadyTimeout so the installer's rollback runs sooner. A release never sets it.
var testReadyTimeout string

// InstallOptions are an install's inputs. The zero values of the injectable fields are the real ones.
type InstallOptions struct {
	From, To, TaskID string
	// Self is the new binary, which copies itself into place; os.Executable by default.
	Self string
	// Root prefixes every absolute path (tests); Host.Root must be the same.
	Root string
	// Dir replaces Dir (tests); it is not prefixed by Root.
	Dir  string
	Sys  System
	Host setup.Host
	Now  func() time.Time
	// Stderr receives what cannot go to the upgrade log because another install holds the lock.
	Stderr io.Writer
	// HandOverTimeout and ReadyTimeout replace the defaults (tests).
	HandOverTimeout, ReadyTimeout time.Duration
	// Migrations replaces the migration registry (tests).
	Migrations []Migration
}

type installer struct {
	opts InstallOptions
	log  *Log
	dir  string
	// running is the set of units the node runs, in start order.
	running []string
	mode    string
	// fixed is the plan of the fixed set, the same crha enroll makes.
	fixed *setup.Plan
	// manifest is set once the backup exists; from then on a failure restores it.
	manifest *backup.Manifest
}

func (in *installer) path(p string) string { return filepath.Join(in.opts.Root, p) }

func (in *installer) backupsDir() string { return filepath.Join(in.dir, "backups") }

// Install upgrades crha from the running version to this binary (doc/design/distribution.md "On the
// node"). It runs as root in a transient unit, outside crha's cgroups, and writes every step to the
// upgrade log while it holds the install lock. Everything that can fail on the files themselves is
// planned before the services stop, so such a failure changes nothing; a later failure rolls back.
func Install(ctx context.Context, opts InstallOptions) error {
	if opts.Sys == nil {
		opts.Sys = ExecSystem{}
	}
	if opts.Host == nil {
		opts.Host = setup.ProductionHost()
	}
	if opts.Now == nil {
		opts.Now = time.Now
	}
	if opts.Stderr == nil {
		opts.Stderr = os.Stderr
	}
	if opts.HandOverTimeout == 0 {
		opts.HandOverTimeout = HandOverTimeout
	}
	if opts.ReadyTimeout == 0 {
		opts.ReadyTimeout = ReadyTimeout
		if d, err := time.ParseDuration(testReadyTimeout); err == nil && d > 0 {
			opts.ReadyTimeout = d
		}
	}
	if opts.Migrations == nil {
		opts.Migrations = migrations
	}
	if opts.Self == "" {
		self, err := os.Executable()
		if err != nil {
			return fmt.Errorf("locate this binary: %w", err)
		}
		opts.Self = self
	}
	dir := opts.Dir
	if dir == "" {
		dir = Dir
	}
	// Only the holder of the lock writes the log: a second installer only says why it stopped.
	unlock, err := lock(dir)
	if err != nil {
		fmt.Fprintf(opts.Stderr, "crha upgrade to %s (task %s): %v\n", opts.To, opts.TaskID, err)
		return err
	}
	defer unlock()
	in := &installer{
		opts: opts,
		dir:  dir,
		log:  &Log{Path: filepath.Join(dir, LogName), UpgradeID: opts.TaskID, From: opts.From, To: opts.To, Now: opts.Now},
	}
	in.info("start", "upgrading crha from %s to %s", opts.From, opts.To)
	return in.run(ctx)
}

// prune removes older upgrade backups, whatever the outcome of this upgrade, keeping this one's
// directory (it holds the received binary) and the backup a rollback by hand would restore now, however
// many upgrades failed since.
func (in *installer) prune() {
	except := []string{backup.UpgradeID(in.opts.TaskID)}
	if plan, err := PlanRollback(in.opts.Root, in.dir); err == nil {
		except = append(except, backup.UpgradeID(plan.UpgradeID))
	}
	if err := backup.Prune(in.backupsDir(), backup.KindUpgrade, in.opts.Now(), except...); err != nil {
		in.info("prune", "removing old backups failed: %v", err)
	}
}

func (in *installer) fail(step string, err error) {
	_ = in.log.Write("error", OutcomeFailed, fmt.Sprintf("%s: %v", step, err))
}

func (in *installer) info(step, format string, args ...any) {
	_ = in.log.Write("info", step, fmt.Sprintf(format, args...))
}

func (in *installer) run(ctx context.Context) error {
	// There is no downgrade: migrations only go forward.
	if !IsReleaseVersion(in.opts.From) || !IsReleaseVersion(in.opts.To) || compareVersions(in.opts.From, in.opts.To) >= 0 {
		err := fmt.Errorf("an upgrade goes from a release to a newer release, not from %s to %s; nothing was changed", in.opts.From, in.opts.To)
		in.fail("version", err)
		return err
	}
	in.prune()

	// 1. Plan: read the fixed set, migrate the configuration, render the units, self-test.
	if err := in.plan(); err != nil {
		in.fail("plan", fmt.Errorf("%v; nothing was changed", err))
		return err
	}

	// 2. Wait for the hand-over: the old crha logs it once crhs has the task's result.
	waitCtx, cancel := context.WithTimeout(ctx, in.opts.HandOverTimeout)
	err := in.opts.Sys.Follow(waitCtx, journalArgs("-b"), func(line []byte) bool {
		return marker.IsHandOver(journalMessage(line), in.opts.TaskID)
	})
	cancel()
	if err != nil {
		err = fmt.Errorf("crhs did not confirm the upgrade task's result within %s (%v); nothing was changed", in.opts.HandOverTimeout, err)
		in.fail("hand-over", err)
		return err
	}
	in.info("hand_over", "crhs confirmed task %s", in.opts.TaskID)

	// 3. Stop both modes: the privileged mode keeps writing its state while it runs.
	if err := units.Stop(ctx, in.opts.Sys.Run, in.running); err != nil {
		in.fail("stop", err)
		_ = in.startUnits(context.WithoutCancel(ctx))
		return err
	}
	in.info("stop", "stopped %v", in.running)

	// 4. Set the host up as this version's enroll would, then replace the fixed set.
	if err := setup.EnsureLayout(ctx, in.opts.Host, in.mode, func(line string) { in.info("layout", "%s", line) }); err != nil {
		return in.rollback(ctx, "layout", err)
	}
	if err := in.backup(); err != nil {
		return in.rollback(ctx, "backup", err)
	}
	if err := in.write(ctx); err != nil {
		return in.rollback(ctx, "install", err)
	}

	// 5. Start the new version and wait for its readiness line.
	since := in.opts.Now()
	if err := in.startUnits(ctx); err != nil {
		return in.rollback(ctx, "start", err)
	}
	readyCtx, cancel := context.WithTimeout(ctx, in.opts.ReadyTimeout)
	err = in.opts.Sys.Follow(readyCtx, journalArgs("--since", "@"+strconv.FormatInt(since.Unix(), 10)), func(line []byte) bool {
		return marker.IsReady(journalMessage(line), in.opts.To)
	})
	cancel()
	if err != nil {
		return in.rollback(ctx, "ready", fmt.Errorf("crha %s did not report ready within %s: %v", in.opts.To, in.opts.ReadyTimeout, err))
	}
	in.info(OutcomeActivated, "crha %s is connected to crhs and its privileged side works", in.opts.To)
	return nil
}

// plan works out the fixed set as this version sets it up, changing nothing: the same plan crha enroll
// makes, from the files already there, with the migrations as the configuration's edits and this binary
// as the new one.
func (in *installer) plan() error {
	server, err := readManagedUnit(in.opts.Root, units.Server)
	if err != nil {
		return err
	}
	in.mode = server.Meta.Mode
	in.running = units.Names(in.mode)
	binary, err := os.ReadFile(in.opts.Self)
	if err != nil {
		return fmt.Errorf("read this binary: %w", err)
	}
	migrate := func(file string) func([]byte) ([]byte, []string, error) {
		return func(data []byte) ([]byte, []string, error) {
			return migrateFile(in.opts.Migrations, file, in.opts.From, in.opts.To, data)
		}
	}
	in.fixed, err = setup.BuildPlan(setup.PlanInput{
		Root: in.opts.Root, ConfigPath: server.Meta.Config, Executable: server.Executable,
		Mode: in.mode, Version: in.opts.To,
		Config:     setup.Content{Edit: migrate(FileCrha)},
		Privileged: setup.Content{Edit: migrate(FilePrivileged)},
		Binary:     binary,
	})
	if err != nil {
		return err
	}
	for _, f := range in.fixed.Files {
		for _, line := range f.Changes {
			in.info("migrate", "%s", line)
		}
	}
	return nil
}

// backup copies every file of the fixed set and writes the manifest, with each file's hash after the
// upgrade.
func (in *installer) backup() error {
	m, manifestPath, err := backup.Take(backup.Options{
		Root: in.opts.Root, Dir: in.backupsDir(), ID: backup.UpgradeID(in.opts.TaskID),
		From: in.opts.From, To: in.opts.To, Units: in.running, Now: in.opts.Now(),
	}, in.fixed.BackupFiles())
	if err != nil {
		return err
	}
	in.manifest = m
	_ = in.log.WriteManifest(manifestPath)
	return nil
}

// write writes what changed, the binary last, reloads systemd and enables the units, as enroll does.
func (in *installer) write(ctx context.Context) error {
	var written []string
	for _, f := range in.fixed.Files {
		if f.Changed() {
			written = append(written, f.Path)
		}
	}
	if err := in.fixed.Apply(ctx, in.opts.Sys.Run, in.opts.Host.Chown); err != nil {
		return err
	}
	in.info("replace", "wrote %v", written)
	return nil
}

// rollback restores the backup, reloads systemd and starts the old version. It does not check the old
// version's health (doc/design/distribution.md "On the node").
func (in *installer) rollback(ctx context.Context, step string, cause error) error {
	// The rollback is what brings the node back, so it runs to its end even when the installer is
	// being stopped.
	ctx = context.WithoutCancel(ctx)
	_ = in.log.Write("error", step, cause.Error())
	if in.manifest == nil {
		// The failure came before the backup: nothing was replaced.
		_ = in.startUnits(ctx)
		in.fail(step, cause)
		return cause
	}
	_ = units.Stop(ctx, in.opts.Sys.Run, in.running)
	// A file that cannot be put back does not keep the others stopped: the units start either way.
	restoreErr := backup.Restore(in.opts.Root, in.manifest)
	_ = in.systemctl(ctx, "daemon-reload")
	startErr := in.startUnits(ctx)
	if restoreErr != nil || startErr != nil {
		in.fail("rollback", fmt.Errorf("%v; restoring the backup: %v; starting the units: %v", cause, restoreErr, startErr))
		return errors.Join(cause, restoreErr, startErr)
	}
	_ = in.log.Write("error", OutcomeRolledBack, fmt.Sprintf("rolled back to crha %s: %v", in.opts.From, cause))
	return cause
}

func (in *installer) startUnits(ctx context.Context) error {
	return units.Start(ctx, in.opts.Sys.Run, in.running)
}

func (in *installer) systemctl(ctx context.Context, args ...string) error {
	return units.Systemctl(ctx, in.opts.Sys.Run, args...)
}

// readManagedUnit reads a unit crha manages; a unit it did not write is never rewritten.
func readManagedUnit(root, name string) (units.Parsed, error) {
	data, err := os.ReadFile(filepath.Join(root, units.Dir, name))
	if err != nil {
		return units.Parsed{}, fmt.Errorf("read %s: %w", name, err)
	}
	parsed := units.Parse(string(data))
	if !parsed.Managed || parsed.Meta == nil || parsed.Executable == "" {
		return units.Parsed{}, fmt.Errorf("%s is not a unit crha manages", name)
	}
	return parsed, nil
}

func journalArgs(extra ...string) []string {
	args := []string{"-o", "json", "--no-pager", "-f", "-n", "all"}
	args = append(args, extra...)
	return append(args, "_SYSTEMD_UNIT="+units.Server)
}

// lock takes the install lock in dir, so two upgrades, or an upgrade and a rollback, never run at once.
// Only the holder of the lock writes the upgrade log.
func lock(dir string) (func(), error) {
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return nil, err
	}
	f, err := os.OpenFile(filepath.Join(dir, "install.lock"), os.O_RDWR|os.O_CREATE|syscall.O_NOFOLLOW, 0o600)
	if err != nil {
		return nil, err
	}
	if err := syscall.Flock(int(f.Fd()), syscall.LOCK_EX|syscall.LOCK_NB); err != nil {
		f.Close()
		return nil, errors.New("another upgrade or rollback is running")
	}
	return func() { _ = syscall.Flock(int(f.Fd()), syscall.LOCK_UN); f.Close() }, nil
}
