// Package setup implements `crha enroll`: the questions, the host layout, the generated units and the
// enrollment handshake shared with `crha register` (doc/design/distribution.md "crha enroll").
package setup

import (
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"time"

	"github.com/Kodecable/ClusterRightHand/client/internal/backup"
	"github.com/Kodecable/ClusterRightHand/client/internal/config"
	"github.com/Kodecable/ClusterRightHand/client/internal/enroll"
	"github.com/Kodecable/ClusterRightHand/client/internal/execenv"
	"github.com/Kodecable/ClusterRightHand/client/internal/identity"
	privconfig "github.com/Kodecable/ClusterRightHand/client/internal/privileged/config"
	"github.com/Kodecable/ClusterRightHand/client/internal/privileged/statedir"
	"github.com/Kodecable/ClusterRightHand/client/internal/units"
	"github.com/Kodecable/ClusterRightHand/client/internal/version"
)

const (
	// DefaultConfigPath is where crha enroll writes crha.toml.
	DefaultConfigPath = "/etc/crha/crha.toml"
	// SystemUser is the account the unprivileged mode runs as.
	SystemUser = "crha"
	// StateDir is the state directory crha enroll writes.
	StateDir = "/var/lib/crha"
	// PrivilegedConfigPath is the trust configuration of forward mode.
	PrivilegedConfigPath = "/etc/crha/privileged.toml"
	// PrivilegedSocket is the local approval socket of forward mode.
	PrivilegedSocket = "/run/crha/privileged.sock"
	// PrivilegedStateDir holds the privileged mode's used-task records. It is outside StateDir:
	// crha owns StateDir, so anything root keeps below it could be renamed away by crha.
	PrivilegedStateDir = statedir.DefaultDir
	// PrivilegedLogPath is the privileged mode's audit log.
	PrivilegedLogPath = "/var/log/crha/privileged.jsonl"
	// UnitDir is where crha writes its units.
	UnitDir = units.Dir
)

// RegisterFunc is the shared enrollment core. Tests inject a fake; production calls enroll.Run.
type RegisterFunc func(ctx context.Context, cfg *config.Config, token string, replace bool) (enroll.Result, error)

// Options configures Run.
type Options struct {
	ConfigPath      string
	AnswersPath     string
	SaveAnswersPath string
	Input           io.Reader
	// Output receives progress and the result (stdout, normally).
	Output io.Writer
	// PromptOutput receives the questions (stderr, normally).
	PromptOutput io.Writer
	// Interactive overrides terminal detection; tests use it.
	Interactive *bool
	Host        Host
	Register    RegisterFunc
	// Version is written to the units' X-CRH-Meta; empty uses version.Version.
	Version string
}

// Run asks the enrollment questions and performs each setup step that is not already done.
func Run(ctx context.Context, opts Options) (err error) {
	host := opts.Host
	if host == nil {
		host = ProductionHost()
	}
	out := opts.Output
	if out == nil {
		out = io.Discard
	}
	promptOut := opts.PromptOutput
	if promptOut == nil {
		promptOut = io.Discard
	}
	input := opts.Input
	if input == nil {
		input = strings.NewReader("")
	}
	configPath := opts.ConfigPath
	if configPath == "" {
		configPath = DefaultConfigPath
	}
	say := func(line string) { fmt.Fprintln(out, line) }

	if !host.IsRoot() {
		return errors.New("crha enroll must run as root")
	}

	file := &fileAnswers{Version: 1}
	if opts.AnswersPath != "" {
		if file, err = loadAnswersFile(opts.AnswersPath); err != nil {
			return err
		}
	}
	// An existing crha.toml decides where the identity key lives and answers the server, TLS and
	// privileged mode questions; the file is never rewritten.
	existing, err := loadConfig(host, configPath)
	if err != nil {
		return err
	}
	stateDir := StateDir
	if existing != nil {
		stateDir = existing.StateDir
	}
	enrolled, err := exists(at(host, filepath.Join(stateDir, "identity.key")))
	if err != nil {
		return err
	}
	interactive := IsTerminalReader(input)
	if opts.Interactive != nil {
		interactive = *opts.Interactive
	}
	privilegedConfig, err := exists(at(host, PrivilegedConfigPath))
	if err != nil {
		return err
	}
	state := existingSetup{config: existing, enrolled: enrolled, privilegedConfig: privilegedConfig}
	if privilegedConfig {
		if data, err := os.ReadFile(at(host, PrivilegedConfigPath)); err == nil {
			state.trustNames = trustNamesOf(data)
		}
	}
	// The node id of the current enrollment, to tell after registering whether this run gave the node a
	// new key or registered a new node.
	previousID := ""
	if enrolled {
		previousID = previousNodeID(host, stateDir)
	}
	answers, err := collectAnswers(file, state, interactive, input, promptOut, say)
	if err != nil {
		return err
	}
	// The keep path writes no key and needs no token; it stays on the existing enrollment, whose
	// crha.toml answers the questions of the enrollment step itself.
	keep := answers.Keep
	if keep {
		if err := checkKeep(host, answers); err != nil {
			return err
		}
	} else {
		if _, _, err := enroll.ParseToken(answers.Token); err != nil {
			return err
		}
		if err := validateTrust(answers); err != nil {
			return err
		}
		if existing == nil {
			if _, err := config.Parse([]byte(renderConfig(answers))); err != nil {
				return err
			}
		}
	}
	if opts.SaveAnswersPath != "" {
		if err := saveAnswers(opts.SaveAnswersPath, answers); err != nil {
			return fmt.Errorf("save answers: %w", err)
		}
	}

	// Plan everything that changes on a node set up before, and check it, before anything is written.
	mode := answers.Mode
	executable, err := host.Executable()
	if err != nil {
		return fmt.Errorf("locate the crha binary: %w", err)
	}
	v := opts.Version
	if v == "" {
		v = version.Version
	}
	unitFiles := UnitFiles(executable, configPath, mode, v)
	var newConfig, newPrivileged []byte
	trustChanged := false
	var switches []string
	if existing != nil {
		data, err := os.ReadFile(at(host, configPath))
		if err != nil {
			return err
		}
		if newConfig, switches, err = editConfig(data, answers); err != nil {
			return err
		}
	}
	if answers.ReplaceTrust {
		data, err := os.ReadFile(at(host, PrivilegedConfigPath))
		if err != nil {
			return err
		}
		if newPrivileged, err = replaceTrust(data, answers.LocalRoot, answers.Trust); err != nil {
			return err
		}
		if _, err := privconfig.Parse(newPrivileged); err != nil {
			return fmt.Errorf("privileged.toml with the new trust entries: %w", err)
		}
		// The same entries again, as from a rerun with the same answers file, change nothing.
		if string(newPrivileged) == string(data) {
			newPrivileged = nil
		}
		trustChanged = newPrivileged != nil
	}
	dropPrivilegedUnit := false
	if mode != config.ModeForward {
		if data, err := os.ReadFile(at(host, filepath.Join(UnitDir, units.Privileged))); err == nil {
			dropPrivilegedUnit = units.Parse(string(data)).Managed
		}
	}
	if err := EnsureLayout(ctx, host, mode, say); err != nil {
		return err
	}
	// On a node set up before, registration uses crha.toml as this run will leave it and runs before
	// any file changes, so a refused token changes nothing; the node id it returns is the last input
	// of the plan.
	var cfg *config.Config
	if existing == nil {
		if cfg, err = ensureConfig(host, configPath, answers, say); err != nil {
			return err
		}
	} else if newConfig != nil {
		if cfg, err = config.Parse(newConfig); err != nil {
			return err
		}
	} else {
		cfg = existing
	}

	// Everything that changes is known now but the node id. Before anything changes, the units the node
	// runs stop, as for an upgrade: crha must not run on a key or a configuration being replaced, and
	// the privileged mode keeps writing its state while it runs. A failure from here on starts them again.
	changed := newConfig != nil || newPrivileged != nil || dropPrivilegedUnit
	for _, unit := range unitFiles {
		current, err := os.ReadFile(at(host, filepath.Join(UnitDir, unit.Name)))
		if err != nil || string(current) != unit.Content {
			changed = true
		}
	}
	run := hostRunner(host)
	var stopped []string
	if existing != nil && (changed || !keep) {
		stopped = units.Present(host.Root())
		if err := units.Stop(ctx, run, stopped); err != nil {
			return err
		}
		if len(stopped) > 0 {
			say("stopped: " + strings.Join(stopped, ", "))
		}
		defer func() {
			if err == nil || len(stopped) == 0 {
				return
			}
			if serr := units.Start(context.WithoutCancel(ctx), run, stopped); serr != nil {
				say("warning: starting " + strings.Join(stopped, ", ") + " again failed: " + serr.Error())
			} else {
				say("started again: " + strings.Join(stopped, ", "))
			}
		}()
	}

	var result enroll.Result
	if keep {
		say("skipped: enrollment (already enrolled)")
	} else {
		register := opts.Register
		if register == nil {
			register = func(ctx context.Context, cfg *config.Config, token string, replace bool) (enroll.Result, error) {
				env, err := execenv.Resolve(execenv.Options{})
				if err != nil {
					return enroll.Result{}, err
				}
				// The keys are written as root. They must belong to crha from the moment their
				// final names exist, so the owner is set on the temporary file before publication.
				uid, err := host.UID(SystemUser)
				if err != nil {
					return enroll.Result{}, fmt.Errorf("look up uid of %s: %w", SystemUser, err)
				}
				gid, err := host.GID(SystemUser)
				if err != nil {
					return enroll.Result{}, fmt.Errorf("look up gid of %s: %w", SystemUser, err)
				}
				return enroll.Run(ctx, cfg, token, enroll.Options{
					Replace: replace,
					Env:     env,
					Root:    host.Root(),
					Owner:   &identity.Owner{UID: uid, GID: gid},
				})
			}
		}
		result, err = register(ctx, cfg, answers.Token, answers.Replace)
		if err != nil {
			return err
		}
		switch {
		case previousID == "":
			fmt.Fprintf(out, "enrolled as node %s, waiting for approval\n", result.NodeID)
		case previousID == result.NodeID:
			fmt.Fprintf(out, "enrolled node %s again with a new key, waiting for approval\n", result.NodeID)
		default:
			fmt.Fprintf(out, "enrolled as a new node %s, waiting for approval\n", result.NodeID)
			say("the previous node " + previousID + " stays on crhs; delete it in the WebUI if it is no longer needed")
		}
		fmt.Fprintf(out, "node key fingerprint: %s\n", result.Fingerprint)
	}

	// A new node keeps the privileged mode's configuration, under its new id: privileged.toml
	// answers only to the node it names. A privileged.toml kept outside forward mode follows too, so
	// the way back to forward still works.
	nodeIDChange := ""
	if !keep && privilegedConfig {
		base := newPrivileged
		if base == nil {
			if base, err = os.ReadFile(at(host, PrivilegedConfigPath)); err != nil {
				return err
			}
		}
		edited, from, err := setNodeID(base, result.NodeID)
		if err != nil {
			return err
		}
		if edited != nil {
			newPrivileged = edited
			nodeIDChange = from + " -> " + result.NodeID
			changed = true
		}
	}

	if existing != nil && changed {
		dir, err := backupExisting(host, configPath, executable, v, newConfig, newPrivileged, unitFiles, dropPrivilegedUnit)
		if err != nil {
			return fmt.Errorf("back up: %w", err)
		}
		say("backed up: the previous files to " + dir)
	}
	if existing != nil {
		if newConfig != nil {
			if err := backup.ReplaceFile(at(host, configPath), newConfig, 0o640); err != nil {
				return err
			}
			for _, line := range switches {
				say("changed: " + configPath + ": " + line)
			}
		} else {
			say("skipped: " + configPath)
		}
	}

	switch {
	case newPrivileged != nil:
		if err := backup.ReplaceFile(at(host, PrivilegedConfigPath), newPrivileged, 0o600); err != nil {
			return err
		}
		if trustChanged {
			say("changed: the trust entries of " + PrivilegedConfigPath)
		}
		if nodeIDChange != "" {
			say("changed: " + PrivilegedConfigPath + ": node_id: " + nodeIDChange)
		}
	case mode != config.ModeForward:
	case keep || privilegedConfig:
		say("skipped: " + PrivilegedConfigPath)
	default:
		uid, err := host.UID(SystemUser)
		if err != nil {
			return fmt.Errorf("look up uid of %s: %w", SystemUser, err)
		}
		if err := ensurePrivilegedConfig(host, result.NodeID, uid, answers, say); err != nil {
			return err
		}
	}

	if dropPrivilegedUnit {
		// Leaving forward mode: the privileged mode's unit goes; privileged.toml stays for a way back.
		if err := systemctl(ctx, host, "disable", "--now", strings.TrimSuffix(units.Privileged, ".service")); err != nil {
			return err
		}
		if err := os.Remove(at(host, filepath.Join(UnitDir, units.Privileged))); err != nil && !errors.Is(err, os.ErrNotExist) {
			return err
		}
		say("removed: " + filepath.Join(UnitDir, units.Privileged))
	}
	var unitNames []string
	for _, unit := range unitFiles {
		if err := writeUnit(host, unit.Name, unit.Content, say); err != nil {
			return err
		}
		// Enabled crha first, as enroll always has; systemd does not care about the order.
		unitNames = append([]string{strings.TrimSuffix(unit.Name, ".service")}, unitNames...)
	}
	if err := systemctl(ctx, host, "daemon-reload"); err != nil {
		return err
	}
	if err := systemctl(ctx, host, append([]string{"enable"}, unitNames...)...); err != nil {
		return err
	}
	if answers.Start {
		// Started in order, privileged mode first, as an upgrade does; a unit that runs already stays.
		var start []string
		for _, unit := range unitFiles {
			start = append(start, unit.Name)
		}
		if err := units.Start(ctx, run, start); err != nil {
			return err
		}
		stopped = nil
	}
	if existing != nil {
		if err := backup.Prune(at(host, backup.Dir)); err != nil {
			say("warning: removing old backups failed: " + err.Error())
		}
	}

	if !keep {
		say("approve the node in the WebUI")
	}
	return nil
}

// backupExisting backs up the fixed set of a node set up before enroll changes it
// (doc/design/distribution.md "Backups"), with each file's content after this run where it is known.
func backupExisting(host Host, configPath, executable, v string, newConfig, newPrivileged []byte, unitFiles []UnitFile, dropPrivilegedUnit bool) (string, error) {
	current := func(path string) []byte {
		data, err := os.ReadFile(at(host, path))
		if err != nil {
			return nil
		}
		return data
	}
	after := func(path string, changed []byte) []byte {
		if changed != nil {
			return changed
		}
		return current(path)
	}
	rendered := map[string][]byte{}
	for _, unit := range unitFiles {
		rendered[unit.Name] = []byte(unit.Content)
	}
	files := []backup.File{
		{Path: configPath, After: after(configPath, newConfig)},
		{Path: PrivilegedConfigPath, After: after(PrivilegedConfigPath, newPrivileged)},
	}
	for _, name := range []string{units.Privileged, units.Server} {
		path := filepath.Join(UnitDir, name)
		content := rendered[name]
		if content == nil && !(name == units.Privileged && dropPrivilegedUnit) {
			content = current(path)
		}
		files = append(files, backup.File{Path: path, After: content})
	}
	files = append(files, backup.File{Path: executable, After: current(executable)})
	units := []string{}
	for _, unit := range unitFiles {
		units = append(units, unit.Name)
	}
	id := backup.EnrollID(time.Now())
	if _, _, err := backup.Take(backup.Options{
		Root: host.Root(), Dir: at(host, backup.Dir), ID: id, From: v, To: v, Units: units,
	}, files); err != nil {
		return "", err
	}
	return filepath.Join(backup.Dir, id), nil
}

// previousNodeID is the node id of the current enrollment: the one the last enrollment recorded in the
// state directory, else the one privileged.toml names (a node enrolled before crha kept it); empty
// when neither says.
func previousNodeID(host Host, stateDir string) string {
	if data, err := os.ReadFile(at(host, filepath.Join(stateDir, "node_id"))); err == nil {
		if id := strings.TrimSpace(string(data)); id != "" {
			return id
		}
	}
	if data, err := os.ReadFile(at(host, PrivilegedConfigPath)); err == nil {
		if cfg, err := privconfig.Parse(data); err == nil {
			return cfg.NodeID
		}
	}
	return ""
}

// loadConfig loads an existing configuration; nil means it does not exist yet.
func loadConfig(host Host, path string) (*config.Config, error) {
	actual := at(host, path)
	if _, err := os.Stat(actual); err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return nil, nil
		}
		return nil, err
	}
	cfg, err := config.Load(actual)
	if err != nil {
		return nil, err
	}
	return cfg, nil
}

func ensureSystemUser(ctx context.Context, host Host, say func(string)) error {
	group, err := host.Exec(ctx, "getent", "group", SystemUser)
	if err != nil {
		return err
	}
	if group.Code == 0 {
		say("skipped: system group " + SystemUser)
	} else {
		if err := runChecked(ctx, host, "groupadd --system "+SystemUser, "groupadd", "--system", SystemUser); err != nil {
			return err
		}
		say("created: system group " + SystemUser)
	}
	id, err := host.Exec(ctx, "id", "-u", SystemUser)
	if err != nil {
		return err
	}
	if id.Code == 0 {
		say("skipped: system user " + SystemUser)
		return nil
	}
	if err := runChecked(ctx, host, "useradd "+SystemUser, "useradd", "--system", "--gid", SystemUser,
		"--home-dir", StateDir, "--shell", "/usr/sbin/nologin", SystemUser); err != nil {
		return err
	}
	say("created: system user " + SystemUser)
	return nil
}

// ensureDirectory creates path with the requested owner and mode, or repairs an existing real
// directory. A symlink or non-directory is refused: root never follows a path below a directory
// the unprivileged account controls.
func ensureDirectory(host Host, path string, mode os.FileMode, owner, group string, say func(string)) error {
	actual := at(host, path)
	info, err := os.Lstat(actual)
	if errors.Is(err, os.ErrNotExist) {
		if err := os.MkdirAll(actual, 0o755); err != nil {
			return err
		}
		if err := chmodDirectory(actual, mode); err != nil {
			return err
		}
		if err := host.Chown(actual, owner, group); err != nil {
			return err
		}
		say("created: " + path)
		return nil
	}
	if err != nil {
		return err
	}
	if info.Mode()&os.ModeSymlink != 0 {
		return fmt.Errorf("%s is a symbolic link, not a directory", path)
	}
	if !info.IsDir() {
		return fmt.Errorf("%s is not a directory", path)
	}
	uid, err := host.UID(owner)
	if err != nil {
		return fmt.Errorf("look up uid of %s: %w", owner, err)
	}
	gid, err := host.GID(group)
	if err != nil {
		return fmt.Errorf("look up gid of %s: %w", group, err)
	}
	st, ok := info.Sys().(*syscall.Stat_t)
	if !ok {
		return fmt.Errorf("cannot determine the owner of %s", path)
	}
	var fixes []string
	if st.Uid != uid || st.Gid != gid {
		if err := host.Chown(actual, owner, group); err != nil {
			return err
		}
		fixes = append(fixes, fmt.Sprintf("owner %s:%s", owner, group))
	}
	if info.Mode().Perm() != mode.Perm() {
		if err := chmodDirectory(actual, mode); err != nil {
			return err
		}
		fixes = append(fixes, fmt.Sprintf("mode %04o", mode.Perm()))
	}
	if len(fixes) > 0 {
		say("fixed: " + path + " (" + strings.Join(fixes, ", ") + ")")
	} else {
		say("skipped: " + path)
	}
	return nil
}

// chmodDirectory changes a directory's mode through a descriptor opened without following a
// symlink. A path swapped after the Lstat therefore cannot redirect root's chmod to another file.
func chmodDirectory(path string, mode os.FileMode) error {
	f, err := os.OpenFile(path, os.O_RDONLY|syscall.O_NOFOLLOW|syscall.O_DIRECTORY, 0)
	if err != nil {
		return err
	}
	defer f.Close()
	if err := f.Chmod(mode); err != nil {
		return fmt.Errorf("chmod %s: %w", path, err)
	}
	return nil
}

func ensureConfig(host Host, path string, answers resolved, say func(string)) (*config.Config, error) {
	actual := at(host, path)
	if ok, err := exists(actual); err != nil {
		return nil, err
	} else if ok {
		cfg, err := config.Load(actual)
		if err != nil {
			return nil, err
		}
		say("skipped: " + path)
		return cfg, nil
	}
	content := renderConfig(answers)
	cfg, err := config.Parse([]byte(content))
	if err != nil {
		return nil, err
	}
	if err := writeFile(host, actual, 0o640, content, "root", SystemUser); err != nil {
		return nil, err
	}
	say("wrote: " + path)
	return cfg, nil
}

func ensurePrivilegedConfig(host Host, nodeID string, uid uint32, answers resolved, say func(string)) error {
	actual := at(host, PrivilegedConfigPath)
	if ok, err := exists(actual); err != nil {
		return err
	} else if ok {
		say("skipped: " + PrivilegedConfigPath)
		return nil
	}
	content := renderPrivilegedConfig(nodeID, uid, answers.LocalRoot, answers.Trust)
	if _, err := privconfig.Parse([]byte(content)); err != nil {
		return fmt.Errorf("privileged config: %w", err)
	}
	if err := writeFile(host, actual, 0o600, content, "root", "root"); err != nil {
		return err
	}
	say("wrote: " + PrivilegedConfigPath)
	return nil
}

// checkKeep validates the keep path before any step runs. The enrollment step is skipped, so for
// forward mode the node id it would return can only come from an existing privileged.toml.
func checkKeep(host Host, answers resolved) error {
	if answers.Mode != config.ModeForward {
		return nil
	}
	ok, err := exists(at(host, PrivilegedConfigPath))
	if err != nil {
		return err
	}
	if !ok {
		return errors.New("privileged.toml is missing and the node id is only returned by enrollment: re-enroll (replace) or write /etc/crha/privileged.toml by hand")
	}
	return nil
}

// validateTrust checks the pasted trust entries before anything is written. The node id and crha's
// uid are not known yet, so placeholders stand in for them: the file must parse as a whole.
func validateTrust(answers resolved) error {
	if !answers.PrivilegedAnswers {
		return nil
	}
	content := renderPrivilegedConfig("00000000-0000-0000-0000-000000000000", 0, answers.LocalRoot, answers.Trust)
	if _, err := privconfig.Parse([]byte(content)); err != nil {
		return fmt.Errorf("privileged.trust: %w", err)
	}
	return nil
}

func writeUnit(host Host, name, content string, say func(string)) error {
	if err := writeFile(host, at(host, filepath.Join(UnitDir, name)), 0o644, content, "root", "root"); err != nil {
		return err
	}
	say("wrote: " + filepath.Join(UnitDir, name))
	return nil
}

func writeFile(host Host, actual string, mode os.FileMode, content, owner, group string) error {
	if err := os.MkdirAll(filepath.Dir(actual), 0o755); err != nil {
		return err
	}
	if err := os.WriteFile(actual, []byte(content), mode); err != nil {
		return err
	}
	if err := os.Chmod(actual, mode); err != nil {
		return err
	}
	return host.Chown(actual, owner, group)
}

// hostRunner runs programs through host for the units package.
func hostRunner(host Host) units.Runner {
	return func(ctx context.Context, name string, args ...string) ([]byte, error) {
		result, err := host.Exec(ctx, name, args...)
		if err != nil {
			return nil, err
		}
		if result.Code != 0 {
			return []byte(result.Stderr), fmt.Errorf("exit status %d", result.Code)
		}
		return []byte(result.Stdout), nil
	}
}

func systemctl(ctx context.Context, host Host, args ...string) error {
	return runChecked(ctx, host, "systemctl "+strings.Join(args, " "), "systemctl", args...)
}

func runChecked(ctx context.Context, host Host, description string, name string, args ...string) error {
	result, err := host.Exec(ctx, name, args...)
	if err != nil {
		return err
	}
	if result.Code != 0 {
		return fmt.Errorf("%s failed: %s", description, strings.TrimSpace(result.Stderr))
	}
	return nil
}

func at(host Host, path string) string {
	if host.Root() == "" {
		return path
	}
	return filepath.Join(host.Root(), path)
}

func exists(path string) (bool, error) {
	_, err := os.Stat(path)
	if err == nil {
		return true, nil
	}
	if errors.Is(err, os.ErrNotExist) {
		return false, nil
	}
	return false, err
}

// renderConfig is the crha.toml of a fresh enrollment.
func renderConfig(answers resolved) string {
	lines := []string{
		"server = " + tomlString(answers.Server),
		"tls_verify = " + tomlString(answers.TLSVerify),
		"state_dir = " + tomlString(StateDir),
		"",
		"[privileged]",
		"mode = " + tomlString(answers.Mode),
	}
	if answers.Mode == config.ModeForward {
		lines = append(lines, "socket = "+tomlString(PrivilegedSocket))
	}
	return strings.Join(lines, "\n") + "\n"
}

// renderPrivilegedConfig is the privileged.toml of a forward node, including the pasted trust entries.
func renderPrivilegedConfig(nodeID string, uid uint32, localRoot bool, trust string) string {
	lines := []string{
		"node_id = " + tomlString(nodeID),
		"unprivileged_uid = " + strconv.FormatUint(uint64(uid), 10),
		"socket = " + tomlString(PrivilegedSocket),
		"socket_group = " + tomlString(SystemUser),
		"state_dir = " + tomlString(PrivilegedStateDir),
		"log = " + tomlString(PrivilegedLogPath),
	}
	if entries := trustEntries(localRoot, trust); entries != "" {
		lines = append(lines, "", entries)
	}
	return strings.Join(lines, "\n") + "\n"
}

// tomlString renders a TOML basic string. JSON's escaping is valid TOML for the paths and URLs stored.
func tomlString(value string) string {
	return strconv.Quote(value)
}
