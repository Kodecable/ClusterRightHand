package setup

import (
	"context"

	"github.com/Kodecable/ClusterRightHand/client/internal/config"
	"github.com/Kodecable/ClusterRightHand/client/internal/units"
)

// The host layout and units below are shared by crha enroll and the self-upgrade
// (doc/design/distribution.md "On the node"): an upgrade is the new version setting up the host again
// from the files already there, so whatever a version needs from the host is defined once, here.

// EnsureLayout creates the system user and the directories crha needs in mode, or repairs their
// owner and mode. It changes nothing that is already right, so it is run again on every upgrade.
func EnsureLayout(ctx context.Context, host Host, mode string, say func(string)) error {
	if say == nil {
		say = func(string) {}
	}
	if err := ensureSystemUser(ctx, host, say); err != nil {
		return err
	}
	if err := ensureDirectory(host, "/etc/crha", 0o750, "root", SystemUser, say); err != nil {
		return err
	}
	if err := ensureDirectory(host, StateDir, 0o700, SystemUser, SystemUser, say); err != nil {
		return err
	}
	if mode == config.ModeForward {
		if err := ensureDirectory(host, PrivilegedStateDir, 0o700, "root", "root", say); err != nil {
			return err
		}
		if err := ensureDirectory(host, "/var/log/crha", 0o750, "root", "root", say); err != nil {
			return err
		}
	}
	return nil
}

// UnitFile is one unit crha writes, by its name in units.Dir.
type UnitFile struct {
	Name    string
	Content string
}

// UnitFiles are the units crha runs under in mode, in start order: crha-privileged.service (forward
// mode) before crha.service.
func UnitFiles(executable, configPath, mode, version string) []UnitFile {
	var out []UnitFile
	if mode == config.ModeForward {
		out = append(out, UnitFile{units.Privileged, units.RenderPrivileged(executable, PrivilegedConfigPath, version)})
	}
	return append(out, UnitFile{units.Server, units.RenderServer(executable, configPath, mode, SystemUser, version)})
}
