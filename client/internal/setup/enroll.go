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
	"slices"
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
	"github.com/Kodecable/ClusterRightHand/client/internal/protocol"
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
	// The install lock keeps an upgrade or a rollback by hand from changing the fixed set, or starting
	// and stopping its units, while enroll does.
	unlock, err := backup.Lock(at(host, filepath.Dir(backup.Dir)))
	if err != nil {
		return err
	}
	defer unlock()
	// The units name this binary and run it as root: one in a place a user can change is refused before
	// any question.
	executable, err := host.Executable()
	if err != nil {
		return fmt.Errorf("locate the crha binary: %w", err)
	}
	if err := checkExecutable(host, executable); err != nil {
		return err
	}
	if err := checkUnitPath("the configuration", configPath); err != nil {
		return err
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

	// The node as this version sets it up, worked out from the files already there with the same plan as
	// an upgrade (doc/design/distribution.md "Switching a node set up before"): the answers become edits
	// of the existing files, or the content of new ones.
	mode := answers.Mode
	v := opts.Version
	if v == "" {
		v = version.Version
	}
	if err := EnsureLayout(ctx, host, mode, say); err != nil {
		return err
	}
	want := PlanInput{
		Root: host.Root(), ConfigPath: configPath, Executable: executable, Mode: mode, Version: v,
		Config:     Content{New: []byte(renderConfig(answers)), Mode: 0o640, Owner: "root", Group: SystemUser},
		Privileged: Content{Mode: 0o600, Owner: "root", Group: "root"},
	}
	if existing != nil {
		want.Config.Edit = editing(configChanges(existing, answers)...)
	}
	if answers.ReplaceTrust {
		want.Privileged.Edit = editing(trustChange(answers.LocalRoot, answers.Trust))
	}
	if mode == config.ModeForward && !privilegedConfig && !keep {
		// A new privileged.toml names the node; the id is known after registering, a stand-in until then.
		uid, err := host.UID(SystemUser)
		if err != nil {
			return fmt.Errorf("look up uid of %s: %w", SystemUser, err)
		}
		if want.Privileged.New, err = renderPrivilegedConfig(standInNodeID, uid, answers.LocalRoot, answers.Trust); err != nil {
			return fmt.Errorf("privileged.trust: %w", err)
		}
	}
	plan, err := BuildPlan(want)
	if err != nil {
		return err
	}
	// Enrolling again may register a new node, whose id privileged.toml must then name. The edit is tried
	// now on the stand-in, so that nothing after registering can fail but writing the files.
	nameNode := !keep && plan.File(PrivilegedConfigPath).After != nil
	if nameNode {
		if err := plan.Amend(PrivilegedConfigPath, nodeIDEdit(standInNodeID), true); err != nil {
			return err
		}
	}
	// Registration uses crha.toml as this run will leave it, before any file changes, so a refused token
	// changes nothing.
	cfg, err := config.Parse(plan.File(configPath).After)
	if err != nil {
		return err
	}

	// The set is backed up while the node still runs. privileged.toml may still change with the node id,
	// so a node with one is backed up on every new enrollment; the manifest records it once it is known.
	manifestPath := ""
	if existing != nil && (plan.Changed() || (nameNode && privilegedConfig)) {
		id := backup.EnrollID(time.Now())
		if _, manifestPath, err = backup.Take(backup.Options{
			Root: host.Root(), Dir: at(host, backup.Dir), ID: id, From: v, To: v, Units: plan.Units,
		}, plan.BackupFiles()); err != nil {
			return fmt.Errorf("back up: %w", err)
		}
		say("backed up: the previous files to " + filepath.Join(backup.Dir, id))
	}
	// Before anything changes, the units the node runs stop, as for an upgrade: crha must not run on a
	// key or a configuration being replaced, and the privileged mode keeps writing its state while it
	// runs. A failure from here on starts them again.
	run := hostRunner(host)
	var stopped []string
	if existing != nil && (plan.Changed() || !keep) {
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

	// privileged.toml answers only to the node it names: a new node keeps the privileged mode's
	// configuration under its new id, also when kept outside forward mode, for the way back.
	if nameNode {
		if err := plan.Amend(PrivilegedConfigPath, nodeIDEdit(result.NodeID), false); err != nil {
			return err
		}
		if manifestPath != "" {
			if err := backup.SetAfter(manifestPath, PrivilegedConfigPath, plan.File(PrivilegedConfigPath).After); err != nil {
				say("warning: the backup does not record the new privileged.toml: " + err.Error())
			}
		}
	}
	if err := plan.Apply(ctx, run, host.Chown); err != nil {
		if keep {
			return err
		}
		// crhs holds the new key now: putting the previous files back would not bring the previous
		// enrollment back. What is left is said, and running enroll again finishes it.
		where := ""
		if manifestPath != "" {
			where = "; the previous files are in " + filepath.Dir(manifestPath)
		}
		return fmt.Errorf("registered as node %s, but writing the files failed: %w%s; fix it and run crha enroll again", result.NodeID, err, where)
	}
	reportPlan(plan, executable, say)
	if answers.Start {
		// Started in order, privileged mode first, as an upgrade does; a unit that runs already stays. A
		// privileged unit written by hand that enroll stopped is started again, though the mode does not
		// run it.
		start := slices.Clone(plan.Units)
		for _, name := range stopped {
			if !slices.Contains(start, name) && slices.Contains(units.Present(host.Root()), name) {
				start = append([]string{name}, start...)
			}
		}
		if err := units.Start(ctx, run, start); err != nil {
			return err
		}
		stopped = nil
	}
	if existing != nil {
		if err := backup.Prune(at(host, backup.Dir), backup.KindEnroll, time.Now()); err != nil {
			say("warning: removing old backups failed: " + err.Error())
		}
	}

	if !keep {
		say("approve the node in the WebUI")
	}
	return nil
}

// reportPlan says what happened to each file of the set but the binary, which enroll never replaces.
func reportPlan(plan *Plan, executable string, say func(string)) {
	for _, f := range plan.Files {
		switch {
		case f.Path == executable:
		case !f.Changed():
			if f.After != nil {
				say("skipped: " + f.Path)
			}
		case f.After == nil:
			say("removed: " + f.Path)
		case f.Before == nil || len(f.Changes) == 0:
			say("wrote: " + f.Path)
		default:
			for _, line := range f.Changes {
				say("changed: " + f.Path + ": " + line)
			}
		}
	}
}

// standInNodeID stands for the node id a registration will return, to try privileged.toml's edit.
const standInNodeID = "00000000-0000-7000-8000-000000000000"

// previousNodeID is the node id of the current enrollment: the one the last enrollment recorded in the
// state directory, else the one privileged.toml names (a node enrolled before crha kept it); empty
// when neither says.
func previousNodeID(host Host, stateDir string) string {
	if id := readNodeID(at(host, filepath.Join(stateDir, "node_id"))); id != "" {
		return id
	}
	if data, err := os.ReadFile(at(host, PrivilegedConfigPath)); err == nil {
		if cfg, err := privconfig.Parse(data); err == nil {
			return cfg.NodeID
		}
	}
	return ""
}

// readNodeID reads the node id crha recorded. The state directory is crha's, and enroll runs as root:
// the file is not followed through a link, only its start is read, and anything but a node id is none.
func readNodeID(path string) string {
	f, err := os.OpenFile(path, os.O_RDONLY|syscall.O_NOFOLLOW|syscall.O_NONBLOCK, 0)
	if err != nil {
		return ""
	}
	defer f.Close()
	if info, err := f.Stat(); err != nil || !info.Mode().IsRegular() {
		return ""
	}
	data, _ := io.ReadAll(io.LimitReader(f, 128))
	if id := strings.TrimSpace(string(data)); protocol.IsUUID(id) {
		return id
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
	content, err := renderPrivilegedConfig("00000000-0000-0000-0000-000000000000", 0, answers.LocalRoot, answers.Trust)
	if err == nil {
		_, err = privconfig.Parse(content)
	}
	if err != nil {
		return fmt.Errorf("privileged.trust: %w", err)
	}
	return nil
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

// renderPrivilegedConfig is the privileged.toml of a forward node. The trust entries go in by the same
// edit that replaces them in an existing file, which takes [[trust]] tables only: pasted text cannot set
// a top-level key such as clock_skew.
func renderPrivilegedConfig(nodeID string, uid uint32, localRoot bool, trust string) ([]byte, error) {
	lines := []string{
		"node_id = " + tomlString(nodeID),
		"unprivileged_uid = " + strconv.FormatUint(uint64(uid), 10),
		"socket = " + tomlString(PrivilegedSocket),
		"socket_group = " + tomlString(SystemUser),
		"state_dir = " + tomlString(PrivilegedStateDir),
		"log = " + tomlString(PrivilegedLogPath),
	}
	out, _, err := editing(trustChange(localRoot, trust))([]byte(strings.Join(lines, "\n") + "\n"))
	return out, err
}

// tomlString renders a TOML basic string. JSON's escaping is valid TOML for the paths and URLs stored.
func tomlString(value string) string {
	return strconv.Quote(value)
}
