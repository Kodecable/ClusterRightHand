// Package setup implements `crha enroll`: the questions, the host layout, the generated units and the
// enrollment handshake shared with `crha register` (doc/design/distribution.md "crha enroll").
package setup

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strconv"
	"strings"

	"github.com/Kodecable/ClusterRightHand/client/internal/config"
	"github.com/Kodecable/ClusterRightHand/client/internal/enroll"
	"github.com/Kodecable/ClusterRightHand/client/internal/execenv"
	privconfig "github.com/Kodecable/ClusterRightHand/client/internal/privileged/config"
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
	// PrivilegedStateDir holds the privileged mode's used-task records.
	PrivilegedStateDir = "/var/lib/crha/privileged"
	// PrivilegedLogPath is the privileged mode's audit log.
	PrivilegedLogPath = "/var/log/crha/privileged.jsonl"
	// UnitDir is where crha writes its units.
	UnitDir = "/etc/systemd/system"
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
	// An existing crha.toml decides where the identity key lives; the file is never rewritten.
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
	answers, err := collectAnswers(file, existing, enrolled, interactive, input, promptOut, say)
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

	if err := ensureSystemUser(ctx, host, say); err != nil {
		return err
	}
	if err := ensureDirectory(host, "/etc/crha", 0o750, "root", SystemUser, say); err != nil {
		return err
	}
	if err := ensureDirectory(host, StateDir, 0o700, SystemUser, SystemUser, say); err != nil {
		return err
	}
	cfg, err := ensureConfig(host, configPath, answers, say)
	if err != nil {
		return err
	}
	mode := answers.Mode
	if existing != nil {
		mode = cfg.Privilege.Mode
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
				return enroll.Run(ctx, cfg, token, enroll.Options{Replace: replace, Env: env, Root: host.Root()})
			}
		}
		result, err = register(ctx, cfg, answers.Token, answers.Replace)
		if err != nil {
			return err
		}
		fmt.Fprintf(out, "enrolled as node %s, waiting for approval\nnode key fingerprint: %s\n", result.NodeID, result.Fingerprint)
	}
	for _, path := range []string{cfg.IdentityKeyPath(), cfg.ServerKeyPath()} {
		if err := host.Chown(at(host, path), SystemUser, SystemUser); err != nil {
			return err
		}
	}

	if mode == config.ModeForward {
		if err := ensureDirectory(host, PrivilegedStateDir, 0o700, "root", "root", say); err != nil {
			return err
		}
		if err := ensureDirectory(host, "/var/log/crha", 0o750, "root", "root", say); err != nil {
			return err
		}
		if keep {
			say("skipped: " + PrivilegedConfigPath)
		} else {
			uid, err := host.UID(SystemUser)
			if err != nil {
				return fmt.Errorf("look up uid of %s: %w", SystemUser, err)
			}
			if err := ensurePrivilegedConfig(host, result.NodeID, uid, answers, say); err != nil {
				return err
			}
		}
	}

	executable, err := host.Executable()
	if err != nil {
		return fmt.Errorf("locate the crha binary: %w", err)
	}
	v := opts.Version
	if v == "" {
		v = version.Version
	}
	if err := writeUnit(host, "crha.service", renderServerUnit(executable, configPath, mode, v), say); err != nil {
		return err
	}
	units := []string{"crha"}
	if mode == config.ModeForward {
		if err := writeUnit(host, "crha-privileged.service", renderPrivilegedUnit(executable, v), say); err != nil {
			return err
		}
		units = append(units, "crha-privileged")
	}
	if err := systemctl(ctx, host, "daemon-reload"); err != nil {
		return err
	}
	enable := []string{"enable"}
	if answers.Start {
		enable = append(enable, "--now")
	}
	enable = append(enable, units...)
	if err := systemctl(ctx, host, enable...); err != nil {
		return err
	}

	if !keep {
		say("approve the node in the WebUI")
	}
	return nil
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

func ensureDirectory(host Host, path string, mode os.FileMode, owner, group string, say func(string)) error {
	actual := at(host, path)
	ok, err := exists(actual)
	if err != nil {
		return err
	}
	if ok {
		say("skipped: " + path)
		return nil
	}
	if err := os.MkdirAll(actual, 0o755); err != nil {
		return err
	}
	if err := os.Chmod(actual, mode); err != nil {
		return err
	}
	if err := host.Chown(actual, owner, group); err != nil {
		return err
	}
	say("created: " + path)
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
	if answers.Mode != config.ModeForward {
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
	if localRoot {
		lines = append(lines,
			"",
			"[[trust]]",
			`name = "local-root"`,
			`role = "local"`,
			"uids = [0]",
			`kinds = ["execute"]`,
		)
	}
	if trust = strings.TrimSpace(trust); trust != "" {
		lines = append(lines, "", trust)
	}
	return strings.Join(lines, "\n") + "\n"
}

const managedHeader = "# This file is managed by crha. DO NOT EDIT; customize with systemctl edit.\n"

type unitMeta struct {
	V       int    `json:"v"`
	Version string `json:"version"`
	Mode    string `json:"mode"`
	Config  string `json:"config"`
}

func metaLine(mode, configPath, v string) string {
	meta, err := json.Marshal(unitMeta{V: 1, Version: v, Mode: mode, Config: configPath})
	if err != nil {
		return ""
	}
	return "X-CRH-Meta=" + string(meta)
}

func renderServerUnit(executable, configPath, mode, v string) string {
	after := "network-online.target"
	wants := "network-online.target"
	if mode == config.ModeForward {
		after += " crha-privileged.service"
		wants += " crha-privileged.service"
	}
	return managedHeader + `[Unit]
Description=ClusterRightHand node agent
After=` + after + `
Wants=` + wants + `
X-CRH-Managed=1
` + metaLine(mode, configPath, v) + `

[Service]
User=` + SystemUser + `
Group=` + SystemUser + `
ExecStart=` + executable + ` run --config ` + configPath + `
ExecReload=/bin/kill -HUP $MAINPID
Restart=on-failure

[Install]
WantedBy=multi-user.target
`
}

func renderPrivilegedUnit(executable, v string) string {
	return managedHeader + `[Unit]
Description=ClusterRightHand node agent (privileged)
Before=crha.service
X-CRH-Managed=1
` + metaLine(config.ModeForward, PrivilegedConfigPath, v) + `

[Service]
User=root
RuntimeDirectory=crha
RuntimeDirectoryMode=0755
ExecStart=` + executable + ` privileged run --config ` + PrivilegedConfigPath + `
ExecReload=/bin/kill -HUP $MAINPID
Restart=on-failure
UMask=0077

[Install]
WantedBy=multi-user.target
`
}

// tomlString renders a TOML basic string. JSON's escaping is valid TOML for the paths and URLs stored.
func tomlString(value string) string {
	return strconv.Quote(value)
}
