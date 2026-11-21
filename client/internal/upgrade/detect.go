// Package upgrade is crha's self-upgrade (doc/design/distribution.md "crha self-upgrade"): whether this
// node can be upgraded, and the installer the new binary runs.
package upgrade

import (
	"os"
	"path/filepath"
	"strings"

	"github.com/Kodecable/ClusterRightHand/client/internal/config"
	"github.com/Kodecable/ClusterRightHand/client/internal/units"
)

const (
	// Dir holds the received binaries, the backups and the upgrade log. It is root's and 0755, so the
	// unprivileged mode can read the log; each version's directory is 0700.
	Dir = "/var/lib/crha-upgrade"
	// LogName is the upgrade log in Dir: JSON lines, written only under the install lock.
	LogName = "upgrade.jsonl"
)

// LogPath is the upgrade log crha reports in its facts.
var LogPath = filepath.Join(Dir, LogName)

// The reasons a node reports when crhs cannot upgrade it (doc/design/distribution.md "Who can
// self-upgrade"). They are open names on the wire, so crhs shows a newer one as is.
const (
	ReasonPackageManaged        = "package_managed"
	ReasonNotSystemd            = "not_systemd"
	ReasonUnmanagedUnit         = "unmanaged_unit"
	ReasonUnitMismatch          = "unit_mismatch"
	ReasonNoPrivilege           = "no_privilege"
	ReasonPrivilegedNotRoot     = "privileged_not_root"
	ReasonPrivilegedUnavailable = "privileged_unavailable"
)

// Host is what detection reads; tests replace it.
type Host struct {
	// Root prefixes every absolute path (tests use a temporary directory).
	Root string
	// UID is the unprivileged mode's uid.
	UID int
	// Executable is the running binary's resolved path.
	Executable string
}

// ProductionHost reads the real system.
func ProductionHost() Host {
	exe, err := os.Executable()
	if err == nil {
		if resolved, rerr := filepath.EvalSymlinks(exe); rerr == nil {
			exe = resolved
		}
	}
	return Host{UID: os.Getuid(), Executable: exe}
}

func (h Host) read(path string) ([]byte, error) {
	return os.ReadFile(filepath.Join(h.Root, path))
}

// ServiceUnit is the systemd service the process with this cgroup file runs in, or "" when it is not
// in a .service cgroup.
func ServiceUnit(cgroup string) string {
	for _, line := range strings.Split(cgroup, "\n") {
		// cgroup v2 is "0::/system.slice/crha.service"; on v1 the name=systemd hierarchy says the same.
		parts := strings.SplitN(line, ":", 3)
		if len(parts) != 3 || (parts[0] != "0" && parts[1] != "name=systemd") {
			continue
		}
		name := filepath.Base(parts[2])
		if strings.HasSuffix(name, ".service") {
			return name
		}
	}
	return ""
}

// StaticReasons are the reasons that hold for the life of the process: how crha is installed and
// started, and whether anything on the node can write the binary as root. The forward daemon's state
// is added at fact time (see Reasons).
func StaticReasons(host Host, mode string, packageManaged bool) []string {
	var reasons []string
	add := func(reason string) {
		for _, r := range reasons {
			if r == reason {
				return
			}
		}
		reasons = append(reasons, reason)
	}
	if packageManaged {
		add(ReasonPackageManaged)
	}
	switch mode {
	case config.ModeReject:
		add(ReasonNoPrivilege)
	case config.ModeIgnore:
		if host.UID != 0 {
			add(ReasonNoPrivilege)
		}
	}
	cgroup, err := host.read("/proc/self/cgroup")
	unit := ""
	if err == nil {
		unit = ServiceUnit(string(cgroup))
	}
	if unit == "" {
		add(ReasonNotSystemd)
		return reasons
	}
	// A node set up by hand gives up self-upgrade rather than having its units rewritten.
	if unit != units.Server {
		add(ReasonUnmanagedUnit)
		return reasons
	}
	executables := map[string]bool{}
	for _, name := range units.Names(mode) {
		content, err := host.read(filepath.Join(units.Dir, name))
		if err != nil {
			add(ReasonUnmanagedUnit)
			continue
		}
		parsed := units.Parse(string(content))
		if !parsed.Managed || parsed.Meta == nil || parsed.Executable == "" {
			add(ReasonUnmanagedUnit)
			continue
		}
		executables[parsed.Executable] = true
	}
	if len(executables) > 1 {
		add(ReasonUnitMismatch)
	}
	// The units must start the binary that runs: the installer replaces the file they name.
	for exe := range executables {
		resolved := exe
		if r, err := filepath.EvalSymlinks(filepath.Join(host.Root, exe)); err == nil {
			resolved = strings.TrimPrefix(r, host.Root)
		}
		if host.Executable != "" && resolved != host.Executable {
			add(ReasonUnitMismatch)
		}
	}
	return reasons
}

// Forward is the forward daemon's state as the unprivileged mode sees it.
type Forward struct {
	// Connected is true while the crh-priv connection is up (its handshake already checked the version).
	Connected bool
	// PeerUID is the daemon's uid from SO_PEERCRED, -1 when unknown.
	PeerUID int
}

// Reasons are the static reasons plus, in forward mode, the daemon's.
func Reasons(static []string, mode string, forward Forward) []string {
	reasons := append([]string(nil), static...)
	if mode == config.ModeForward {
		if !forward.Connected {
			reasons = append(reasons, ReasonPrivilegedUnavailable)
		} else if forward.PeerUID != 0 {
			reasons = append(reasons, ReasonPrivilegedNotRoot)
		}
	}
	return reasons
}
