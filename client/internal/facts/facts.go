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

	crhv1 "github.com/Kodecable/ClusterRightHand/client/internal/proto/crhv1"
)

var (
	packageManagers = []string{"apt", "dnf", "yum", "zypper", "pacman", "apk", "emerge", "xbps-install", "nix"}
	privilegeTools  = []string{"sudo", "doas", "run0"}
)

// Collect gathers facts about the local system. NotesPath, Groups and
// ClockOffsetMs are left for the caller.
func Collect() *crhv1.Facts {
	return collect("/", exec.LookPath)
}

func collect(root string, lookPath func(string) (string, error)) *crhv1.Facts {
	f := &crhv1.Facts{
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
	f.OsId, f.OsVersionId, f.OsPrettyName = osr["ID"], osr["VERSION_ID"], osr["PRETTY_NAME"]
	return f
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
