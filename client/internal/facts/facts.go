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

// Collect gathers facts about the local system. NotesPath and ClockOffsetMs are left for the
// caller.
func Collect() protocol.Facts {
	return collect("/", exec.LookPath, runtime.GOOS, runtime.GOARCH)
}

// collect builds the two descriptive facts (doc/design/protocol.md "Events"): platform and hints are
// written for people and models, so they are sentences and a summary line, not fields to parse.
func collect(root string, lookPath func(string) (string, error), goos, goarch string) protocol.Facts {
	f := protocol.Facts{
		Platform: optionalText(platform(goos, goarch, osRelease(root))),
		Hints:    optionalText(TruncateHints(strings.Join(hints(root, lookPath), "\n"))),
	}
	f.Hostname, _ = os.Hostname()
	return Clean(f)
}

// platform is "<os>, <arch>, <distribution>": crha's own GOOS and GOARCH, then the os-release name. The
// distribution falls back to NAME VERSION_ID and then ID, and is left out when nothing names it.
func platform(goos, goarch string, osr map[string]string) string {
	parts := []string{goos, goarch}
	name := osr["PRETTY_NAME"]
	if name == "" {
		name = strings.TrimSpace(osr["NAME"] + " " + osr["VERSION_ID"])
	}
	if name == "" {
		name = osr["ID"]
	}
	if name != "" {
		parts = append(parts, name)
	}
	return strings.Join(parts, ", ")
}

// hints are the sentences a model needs before it runs anything: the init system and PID 1, the
// package managers and privilege tools on PATH (and their absence), and the kernel.
func hints(root string, lookPath func(string) (string, error)) []string {
	var out []string
	switch {
	case exists(root, "run/systemd/system"):
		out = append(out, "Found systemd.")
	case exists(root, "sbin/openrc-run"), exists(root, "run/openrc"):
		out = append(out, "Found OpenRC.")
	}
	if data, err := os.ReadFile(filepath.Join(root, "proc/1/comm")); err == nil {
		if comm := strings.TrimSpace(string(data)); comm != "" {
			out = append(out, "PID 1 is "+filepath.Base(comm)+".")
		}
	}
	for _, name := range found(lookPath, packageManagers) {
		out = append(out, "Found "+name+".")
	}
	tools := found(lookPath, privilegeTools)
	for _, name := range tools {
		out = append(out, "Found "+name+".")
	}
	if len(tools) == 0 {
		out = append(out, "No sudo, doas or run0 found.")
	}
	var u unix.Utsname
	if unix.Uname(&u) == nil {
		if release := unixString(u.Release[:]); release != "" {
			out = append(out, "Kernel "+release+".")
		}
	}
	return out
}

// TruncateHints keeps whole lines within protocol.MaxHintLines lines and protocol.MaxHintBytes bytes.
func TruncateHints(text string) string {
	var kept []string
	size := 0
	for _, line := range strings.Split(text, "\n") {
		if len(kept) == protocol.MaxHintLines {
			break
		}
		add := len(line)
		if len(kept) > 0 {
			add++
		}
		if size+add > protocol.MaxHintBytes {
			break
		}
		kept = append(kept, line)
		size += add
	}
	return strings.Join(kept, "\n")
}

// optionalText is an optional text fact. The node reports a value it did not find as absent, which
// the protocol omits instead of sending an empty string (doc/design/protocol.md "Events").
func optionalText(s string) *string {
	if s == "" {
		return nil
	}
	return &s
}

// Clean returns f with every text field passed through protocol.CleanText. Facts come from
// outside the process (/etc/os-release, the host name), and the protocol
// encoder rejects invalid UTF-8 instead of letting a frame break the connection.
func Clean(f protocol.Facts) protocol.Facts {
	f.Hostname = protocol.CleanText(f.Hostname)
	f.Platform = cleanTextPtr(f.Platform)
	f.Hints = cleanTextPtr(f.Hints)
	f.NotesPath = cleanTextPtr(f.NotesPath)
	if f.Shells != nil {
		shells := *f.Shells
		shells.Sh = protocol.CleanText(shells.Sh)
		if shells.Bash != nil {
			bash := protocol.CleanText(*shells.Bash)
			shells.Bash = &bash
		}
		f.Shells = &shells
	}
	return f
}

// cleanTextPtr cleans an optional text fact, keeping an absent one absent.
func cleanTextPtr(p *string) *string {
	if p == nil {
		return nil
	}
	cleaned := protocol.CleanText(*p)
	return &cleaned
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
