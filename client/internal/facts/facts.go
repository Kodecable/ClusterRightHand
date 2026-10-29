// Package facts collects system facts reported by crha.
package facts

import (
	"bufio"
	"bytes"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"

	"golang.org/x/sys/unix"

	"github.com/Kodecable/ClusterRightHand/client/internal/protocol"
)

var (
	packageManagers = []string{"apt", "dnf", "yum", "zypper", "pacman", "apk", "emerge", "xbps-install", "nix"}
	privilegeTools  = []string{"sudo", "doas", "run0"}
)

// Collect gathers facts about the local system. NotesPath, Groups and
// ClockOffsetMs are left for the caller.
func Collect() protocol.Facts {
	return collect("/", exec.LookPath)
}

func collect(root string, lookPath func(string) (string, error)) protocol.Facts {
	f := protocol.Facts{
		InitSystem:      initSystem(root),
		PackageManagers: found(lookPath, packageManagers),
		PrivilegeTools:  found(lookPath, privilegeTools),
		Arch:            runtime.GOARCH,
	}
	f.Hostname, _ = os.Hostname()
	var u unix.Utsname
	if unix.Uname(&u) == nil {
		f.Kernel = unixString(u.Release[:])
		if m := unixString(u.Machine[:]); m != "" {
			f.Arch = m
		}
	}
	osr := osRelease(root)
	f.OSID, f.OSVersionID, f.OSPrettyName = osr["ID"], osr["VERSION_ID"], osr["PRETTY_NAME"]
	return Clean(f)
}

// Clean returns f with every text field passed through protocol.CleanText. Facts come from
// outside the process (/etc/os-release, the host name, configured groups), and the protocol
// encoder rejects invalid UTF-8 instead of letting a frame break the connection.
func Clean(f protocol.Facts) protocol.Facts {
	f.Hostname = protocol.CleanText(f.Hostname)
	f.OSID = protocol.CleanText(f.OSID)
	f.OSVersionID = protocol.CleanText(f.OSVersionID)
	f.OSPrettyName = protocol.CleanText(f.OSPrettyName)
	f.Kernel = protocol.CleanText(f.Kernel)
	f.Arch = protocol.CleanText(f.Arch)
	f.InitSystem = protocol.CleanText(f.InitSystem)
	f.PackageManagers = cleanTexts(f.PackageManagers)
	f.PrivilegeTools = cleanTexts(f.PrivilegeTools)
	f.NotesPath = protocol.CleanText(f.NotesPath)
	f.Groups = cleanTexts(f.Groups)
	return f
}

func cleanTexts(values []string) []string {
	if values == nil {
		return nil
	}
	out := make([]string, len(values))
	for i, v := range values {
		out[i] = protocol.CleanText(v)
	}
	return out
}

func unixString(b []byte) string {
	if i := bytes.IndexByte(b, 0); i >= 0 {
		b = b[:i]
	}
	return string(b)
}

func found(lookPath func(string) (string, error), names []string) []string {
	var out []string
	for _, n := range names {
		if _, err := lookPath(n); err == nil {
			out = append(out, n)
		}
	}
	return out
}

func osRelease(root string) map[string]string {
	for _, p := range []string{"etc/os-release", "usr/lib/os-release"} {
		data, err := os.ReadFile(filepath.Join(root, p))
		if err == nil {
			return parseOSRelease(data)
		}
	}
	return nil
}

func parseOSRelease(data []byte) map[string]string {
	out := map[string]string{}
	sc := bufio.NewScanner(bytes.NewReader(data))
	for sc.Scan() {
		line := strings.TrimSpace(sc.Text())
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		k, v, ok := strings.Cut(line, "=")
		if !ok {
			continue
		}
		out[strings.TrimSpace(k)] = unquote(strings.TrimSpace(v))
	}
	return out
}

func unquote(v string) string {
	if len(v) >= 2 && (v[0] == '"' || v[0] == '\'') && v[len(v)-1] == v[0] {
		if v[0] == '"' {
			if s, err := strconv.Unquote(v); err == nil {
				return s
			}
		}
		return v[1 : len(v)-1]
	}
	return v
}

func exists(root, p string) bool {
	_, err := os.Stat(filepath.Join(root, p))
	return err == nil
}

func initSystem(root string) string {
	switch {
	case exists(root, "run/systemd/system"):
		return "systemd"
	case exists(root, "sbin/openrc-run"), exists(root, "run/openrc"):
		return "openrc"
	}
	data, err := os.ReadFile(filepath.Join(root, "proc/1/comm"))
	if err != nil {
		return ""
	}
	return filepath.Base(strings.TrimSpace(string(data)))
}
