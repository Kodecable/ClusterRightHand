package setup

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"

	"github.com/Kodecable/ClusterRightHand/client/internal/backup"
	"github.com/Kodecable/ClusterRightHand/client/internal/config"
	"github.com/Kodecable/ClusterRightHand/client/internal/fsutil"
	privconfig "github.com/Kodecable/ClusterRightHand/client/internal/privileged/config"
	"github.com/Kodecable/ClusterRightHand/client/internal/units"
)

// The plan of a node's fixed set (doc/design/distribution.md "Switching a node set up before" and "On
// the node"): crha enroll and the self-upgrade both read every file of the set as it is, work out each
// one as this version sets it up, check the result with this version's strict parsers, back the set up
// and write what changed. They differ only in what they ask of the files: enroll edits the
// configuration to its answers (or writes it new), an upgrade runs its migrations and brings a new
// binary. An upgrade is this version setting the node up again from the files already there.

// Content says how one configuration file of the set changes.
type Content struct {
	// Edit turns the existing file into the new one and describes each change; nil keeps it.
	Edit func(current []byte) (after []byte, changes []string, err error)
	// New is the file's content when it does not exist yet; nil leaves it absent.
	New []byte
	// Mode, Owner and Group are those of a new file.
	Mode         os.FileMode
	Owner, Group string
}

// PlanInput is what a caller asks of the fixed set.
type PlanInput struct {
	// Root prefixes every path (tests).
	Root       string
	ConfigPath string
	// Executable is the binary the units start, which the set includes.
	Executable string
	Mode       string
	// Version is the version the units' X-CRH-Meta records.
	Version    string
	Config     Content
	Privileged Content
	// Binary is the binary's new content; nil keeps it.
	Binary []byte
}

// PlannedFile is one file of the set, before and after.
type PlannedFile struct {
	Path string
	// Before and After are the content; nil is an absent file.
	Before, After []byte
	// Mode, Owner and Group are those of a new file; an existing file keeps its own.
	Mode         os.FileMode
	Owner, Group string
	// Changes describe what an edit changed, for the caller to report.
	Changes []string
}

// Changed reports whether the file is written or removed.
func (f *PlannedFile) Changed() bool {
	return (f.Before == nil) != (f.After == nil) || !bytes.Equal(f.Before, f.After)
}

// Plan is the fixed set as this version leaves it.
type Plan struct {
	root       string
	mode       string
	configPath string
	// Units are the units of the mode, in start order.
	Units []string
	// Files are in write order: the units, crha.toml, privileged.toml, the binary last (it may be the
	// running one copying itself).
	Files []*PlannedFile
}

// BuildPlan reads the fixed set and works out every file as this version sets it up, changing nothing.
func BuildPlan(in PlanInput) (*Plan, error) {
	p := &Plan{root: in.Root, mode: in.Mode, configPath: in.ConfigPath, Units: units.Names(in.Mode)}
	read := func(path string) ([]byte, error) {
		data, err := os.ReadFile(filepath.Join(in.Root, path))
		if errors.Is(err, os.ErrNotExist) {
			return nil, nil
		}
		return data, err
	}
	rendered := map[string][]byte{}
	for _, unit := range UnitFiles(in.Executable, in.ConfigPath, in.Mode, in.Version) {
		rendered[unit.Name] = []byte(unit.Content)
	}
	for _, name := range []string{units.Privileged, units.Server} {
		path := filepath.Join(units.Dir, name)
		before, err := read(path)
		if err != nil {
			return nil, err
		}
		after := rendered[name]
		// Outside forward mode the privileged unit goes if crha wrote it; one written by hand stays.
		if after == nil && before != nil && !units.Parse(string(before)).Managed {
			after = before
		}
		p.Files = append(p.Files, &PlannedFile{Path: path, Before: before, After: after, Mode: 0o644, Owner: "root", Group: "root"})
	}
	for _, c := range []struct {
		path    string
		content Content
	}{{in.ConfigPath, in.Config}, {PrivilegedConfigPath, in.Privileged}} {
		before, err := read(c.path)
		if err != nil {
			return nil, err
		}
		f := &PlannedFile{Path: c.path, Before: before, After: before, Mode: c.content.Mode, Owner: c.content.Owner, Group: c.content.Group}
		switch {
		case before == nil:
			f.After = c.content.New
		case c.content.Edit != nil:
			if f.After, f.Changes, err = c.content.Edit(before); err != nil {
				return nil, fmt.Errorf("%s: %w", c.path, err)
			}
		}
		p.Files = append(p.Files, f)
	}
	binary, err := read(in.Executable)
	if err != nil {
		return nil, fmt.Errorf("read %s: %w", in.Executable, err)
	}
	after := binary
	if in.Binary != nil {
		after = in.Binary
	}
	p.Files = append(p.Files, &PlannedFile{Path: in.Executable, Before: binary, After: after, Mode: 0o755, Owner: "root", Group: "root"})
	if err := p.selfTest(); err != nil {
		return nil, err
	}
	return p, nil
}

// selfTest checks that this version's strict parsers read the configuration it is about to leave.
func (p *Plan) selfTest() error {
	configPath := p.configPath
	crha := p.File(configPath)
	if crha.After == nil {
		return fmt.Errorf("%s is missing", configPath)
	}
	if _, err := config.Parse(crha.After); err != nil {
		return fmt.Errorf("self-test of %s: %w", configPath, err)
	}
	// A privileged.toml kept outside forward mode is checked only when it changes.
	priv := p.File(PrivilegedConfigPath)
	if p.mode == config.ModeForward && priv.After == nil {
		return fmt.Errorf("%s is missing in forward mode", PrivilegedConfigPath)
	}
	if priv.After != nil && (p.mode == config.ModeForward || priv.Changed()) {
		if _, err := privconfig.Parse(priv.After); err != nil {
			return fmt.Errorf("self-test of %s: %w", PrivilegedConfigPath, err)
		}
	}
	return nil
}

// File returns the planned file at path, nil when the set has none.
func (p *Plan) File(path string) *PlannedFile {
	for _, f := range p.Files {
		if f.Path == path {
			return f
		}
	}
	return nil
}

// Amend edits a planned configuration file further, as Content.Edit does, and checks the result again.
// With try, it only checks: the plan stays as it was.
func (p *Plan) Amend(path string, edit func([]byte) ([]byte, []string, error), try bool) error {
	f := p.File(path)
	if f == nil || f.After == nil {
		return fmt.Errorf("%s is not in the plan", path)
	}
	after, changes, err := edit(f.After)
	if err != nil {
		return fmt.Errorf("%s: %w", path, err)
	}
	previous, previousChanges := f.After, f.Changes
	f.After = after
	f.Changes = append(append([]string(nil), f.Changes...), changes...)
	if err := p.selfTest(); err != nil || try {
		f.After, f.Changes = previous, previousChanges
		return err
	}
	return nil
}

// Changed reports whether any file is written or removed.
func (p *Plan) Changed() bool {
	for _, f := range p.Files {
		if f.Changed() {
			return true
		}
	}
	return false
}

// BackupFiles is the whole set with each file's content after the plan, for backup.Take.
func (p *Plan) BackupFiles() []backup.File {
	out := make([]backup.File, 0, len(p.Files))
	for _, f := range p.Files {
		out = append(out, backup.File{Path: f.Path, After: f.After})
	}
	return out
}

// Apply writes the changed files in order, each by fsutil.WriteFile, removes a privileged unit crha
// wrote that the mode no longer runs (disabling it first), reloads systemd and enables the units. A
// new file gets the plan's mode and owner through chown; an existing one keeps its own.
func (p *Plan) Apply(ctx context.Context, run units.Runner, chown func(path, owner, group string) error) error {
	for _, f := range p.Files {
		if !f.Changed() {
			continue
		}
		actual := filepath.Join(p.root, f.Path)
		if f.After == nil {
			if f.Path == filepath.Join(units.Dir, units.Privileged) {
				if err := units.Systemctl(ctx, run, "disable", "--now", units.Privileged); err != nil {
					return err
				}
			}
			if err := os.Remove(actual); err != nil && !errors.Is(err, os.ErrNotExist) {
				return err
			}
			continue
		}
		mode := f.Mode
		if info, err := os.Stat(actual); err == nil {
			mode = info.Mode().Perm()
		}
		if err := os.MkdirAll(filepath.Dir(actual), 0o755); err != nil {
			return err
		}
		if err := fsutil.WriteFile(actual, f.After, mode, fsutil.WriteOptions{}); err != nil {
			return err
		}
		if f.Before == nil && f.Owner != "" && chown != nil {
			if err := chown(actual, f.Owner, f.Group); err != nil {
				return err
			}
		}
	}
	if err := units.Systemctl(ctx, run, "daemon-reload"); err != nil {
		return err
	}
	return units.Systemctl(ctx, run, append([]string{"enable"}, p.Units...)...)
}
