package setup

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"strings"

	"github.com/Kodecable/ClusterRightHand/client/internal/config"
	"github.com/Kodecable/ClusterRightHand/client/internal/fsutil"
	"github.com/Kodecable/ClusterRightHand/client/internal/yesno"
)

// fileAnswers is the schema of `--answers <file>`: every field is optional, so a file may answer
// only some questions. Unknown fields and wrong types are errors.
type fileAnswers struct {
	Version    int             `json:"version"`
	Server     *string         `json:"server"`
	Token      *string         `json:"token"`
	TLSVerify  *string         `json:"tls_verify"`
	Replace    *bool           `json:"replace"`
	Privileged *filePrivileged `json:"privileged"`
	Service    *fileService    `json:"service"`
}

type filePrivileged struct {
	Mode      *string `json:"mode"`
	LocalRoot *bool   `json:"local_root"`
	Trust     *string `json:"trust"`
}

type fileService struct {
	Start *bool `json:"start"`
}

// resolved is the fully answered question set the steps use.
type resolved struct {
	Server    string
	Token     string
	TLSVerify string
	Replace   bool
	// Keep is replace=no on an enrolled node: the enrollment is left alone and needs no token.
	Keep bool
	// FromConfig means an existing crha.toml gave the defaults of the server, TLS and privileged mode
	// questions; an answer that differs switches crha.toml to it, edited in place.
	FromConfig bool
	Mode       string
	// PrivilegedAnswers means LocalRoot and Trust were answered for trust entries to write: a new
	// privileged.toml, or the replacement of an existing one's entries (ReplaceTrust).
	PrivilegedAnswers bool
	// ReplaceTrust means the trust entries of the existing privileged.toml are replaced; everything else
	// in the file stays as it was.
	ReplaceTrust bool
	LocalRoot    bool
	Trust        string
	Start        bool
	// Previous is the existing crha.toml's server, TLS and mode, for the summary of what changes.
	Previous *config.Config
}

// existingSetup is what a previous run left on the host, which decides the questions.
type existingSetup struct {
	// config is the existing crha.toml; nil when there is none.
	config *config.Config
	// enrolled means the identity key exists.
	enrolled bool
	// privilegedConfig means privileged.toml exists.
	privilegedConfig bool
	// trustNames are the names of the existing privileged.toml's trust entries.
	trustNames []string
}

// needsPrivilegedAnswers reports whether an existing forward crha.toml lacks its privileged.toml, so the
// local root and trust questions are still asked on a re-enrollment.
func (e existingSetup) needsPrivilegedAnswers() bool {
	return e.config != nil && e.config.Privilege.Mode == config.ModeForward && !e.privilegedConfig
}

// loadAnswersFile reads and validates one answers file. A file that holds the token is refused unless
// only its owner can read it, because the token is a secret.
func loadAnswersFile(path string) (*fileAnswers, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return nil, fmt.Errorf("answers file %s not found", path)
		}
		return nil, fmt.Errorf("cannot read answers file %s: %w", path, err)
	}
	answers, err := parseAnswers(data)
	if err != nil {
		return nil, fmt.Errorf("%s: %w", path, err)
	}
	if answers.Token != nil && *answers.Token != "" {
		info, err := os.Stat(path)
		if err != nil {
			return nil, err
		}
		if info.Mode().Perm()&0o077 != 0 {
			return nil, fmt.Errorf("answers file %s contains a secret and must not be accessible by group or others (chmod 600)", path)
		}
	}
	return answers, nil
}

// parseAnswers decodes one JSON object strictly: unknown fields, wrong types and other versions are
// errors.
func parseAnswers(data []byte) (*fileAnswers, error) {
	var answers fileAnswers
	dec := json.NewDecoder(bytes.NewReader(data))
	dec.DisallowUnknownFields()
	if err := dec.Decode(&answers); err != nil {
		return nil, fmt.Errorf("invalid answers: %w", err)
	}
	if err := dec.Decode(&struct{}{}); !errors.Is(err, io.EOF) {
		return nil, errors.New("invalid answers: unexpected data after the JSON object")
	}
	if err := answers.validate(); err != nil {
		return nil, err
	}
	return &answers, nil
}

func (a *fileAnswers) validate() error {
	if a.Version != 1 {
		return fmt.Errorf("invalid answers: version must be 1, got %d", a.Version)
	}
	if a.Server != nil && strings.TrimSpace(*a.Server) == "" {
		return errors.New("invalid answers: server must not be empty")
	}
	if a.Token != nil && strings.TrimSpace(*a.Token) == "" {
		return errors.New("invalid answers: token must not be empty")
	}
	if a.TLSVerify != nil && *a.TLSVerify != "system" && *a.TLSVerify != "none" {
		return fmt.Errorf("invalid answers: tls_verify must be \"system\" or \"none\", got %q", *a.TLSVerify)
	}
	if a.Privileged != nil && a.Privileged.Mode != nil &&
		*a.Privileged.Mode != "ignore" && *a.Privileged.Mode != "forward" {
		return fmt.Errorf("invalid answers: privileged.mode must be \"ignore\" or \"forward\", got %q", *a.Privileged.Mode)
	}
	return nil
}

// missingFields lists the questions a non-interactive run must have answered by the file. Defaulted
// questions count too: without a terminal they are not prompted, so a missing answer is an error
// naming every field. The keep path (replace=no on an enrolled node) needs neither the enrollment
// questions nor the privileged ones, and an existing crha.toml answers server, tls_verify and
// privileged.mode.
func (a *fileAnswers) missingFields(state existingSetup) []string {
	var fields []string
	add := func(name string, present bool) {
		if !present {
			fields = append(fields, name)
		}
	}
	addStart := func() { add("service.start", a.Service != nil && a.Service.Start != nil) }
	if state.enrolled {
		add("replace", a.Replace != nil)
		if a.Replace == nil {
			// The branch is unknown until replace is answered; only fields both branches need are named.
			addStart()
			return fields
		}
		if !*a.Replace {
			addStart()
			return fields
		}
	}
	if state.config != nil {
		add("token", a.Token != nil)
		mode := state.config.Privilege.Mode
		if m := privilegedMode(a); m != nil {
			mode = strings.TrimSpace(*m)
		}
		if mode == config.ModeForward && !state.privilegedConfig {
			add("privileged.local_root", a.Privileged != nil && a.Privileged.LocalRoot != nil)
			add("privileged.trust", a.Privileged != nil && a.Privileged.Trust != nil)
		}
		addStart()
		return fields
	}
	add("server", a.Server != nil)
	add("token", a.Token != nil)
	add("tls_verify", a.TLSVerify != nil)
	add("privileged.mode", a.Privileged != nil && a.Privileged.Mode != nil)
	if a.Privileged != nil && a.Privileged.Mode != nil && *a.Privileged.Mode == "forward" {
		add("privileged.local_root", a.Privileged.LocalRoot != nil)
		add("privileged.trust", a.Privileged.Trust != nil)
	}
	addStart()
	return fields
}

// collectAnswers resolves every question. A value from the answers file is used as is; a missing one
// is asked on a terminal. Without a terminal, all missing fields are reported in one error before
// anything is asked or changed. An interactive run that asked something then shows a summary and
// asks to proceed; a run answered entirely by the file does not.
func collectAnswers(file *fileAnswers, state existingSetup, interactive bool, input io.Reader, promptOut io.Writer, say func(string)) (resolved, error) {
	existing, enrolled := state.config, state.enrolled
	if !interactive {
		if missing := file.missingFields(state); len(missing) > 0 {
			return resolved{}, fmt.Errorf("missing answers for %s; put them in the --answers file or run on a terminal", strings.Join(missing, ", "))
		}
		return resolveFileAnswers(file, state)
	}
	p := newPrompter(input, promptOut)
	asked := false
	take := func(value *string, prompt, fallback string, required bool) (string, error) {
		if value != nil {
			return strings.TrimSpace(*value), nil
		}
		asked = true
		suffix := ""
		if fallback != "" {
			suffix = " [" + fallback + "]"
		}
		text, err := p.ask(prompt + suffix + ": ")
		if err != nil {
			return "", err
		}
		if text != "" {
			return text, nil
		}
		if fallback != "" {
			return fallback, nil
		}
		if required {
			return "", fmt.Errorf("%s must not be empty", prompt)
		}
		return "", nil
	}
	yesNo := func(value *bool, prompt string, fallback bool) (bool, error) {
		if value != nil {
			return *value, nil
		}
		asked = true
		suffix := "[Y/n]"
		if !fallback {
			suffix = "[y/N]"
		}
		text, err := p.ask(prompt + "? " + suffix + ": ")
		if err != nil {
			return false, err
		}
		answer, ok := yesno.Parse(text, fallback)
		if !ok {
			return false, fmt.Errorf("%s: answer yes or no", prompt)
		}
		return answer, nil
	}

	a, err := startAnswers(file, state)
	if err != nil {
		return resolved{}, err
	}
	// Re-enrollment is the first question on an enrolled node: answering no keeps the existing
	// enrollment, which needs no token and keeps the crhs address.
	if enrolled && file.Replace == nil {
		// What a new enrollment does depends on the token, which only crhs knows: the summary after
		// registering says which it was.
		say("This node is enrolled. Enrolling again gives it a new key: a Re-enroll token keeps the node's id, name, groups and grants; a New node token registers another node.")
		replace, err := yesNo(nil, "Enroll again with a new key", false)
		if err != nil {
			return resolved{}, err
		}
		a.Replace, a.Keep = replace, !replace
		if a.Keep && existing == nil {
			return resolved{}, errors.New("crha.toml is missing; re-enroll (replace) or restore it")
		}
		// The answers file may name a crhs address, taken before this question was answered.
		if err := checkKeptServer(a); err != nil {
			return resolved{}, err
		}
	}
	if !a.Keep {
		if a.Server, err = take(file.Server, "crhs address", a.Server, true); err != nil {
			return resolved{}, err
		}
		keepServerSpelling(&a)
		if file.Token != nil {
			a.Token = strings.TrimSpace(*file.Token)
		} else {
			asked = true
			if a.Token, err = p.askSecret("Enrollment token: "); err != nil {
				return resolved{}, err
			}
			a.Token = strings.TrimSpace(a.Token)
			if a.Token == "" {
				return resolved{}, errors.New("Enrollment token must not be empty")
			}
		}
	}
	if file.TLSVerify == nil {
		verify, err := yesNo(nil, "Check the TLS certificate against the system CAs", a.TLSVerify != "none")
		if err != nil {
			return resolved{}, err
		}
		a.TLSVerify = "system"
		if !verify {
			a.TLSVerify = "none"
		}
	}
	if a.Mode, err = take(privilegedMode(file), "Privileged mode (ignore or forward)", defaultMode(a.Mode), true); err != nil {
		return resolved{}, err
	}
	if err := checkMode(a.Mode, existing); err != nil {
		return resolved{}, err
	}
	if a.Mode == config.ModeForward {
		replaceTrust := false
		switch {
		case !state.privilegedConfig && a.Keep:
			// No node id to write privileged.toml with: checkKeep refuses before anything changes.
		case !state.privilegedConfig:
			a.PrivilegedAnswers = true
		case file.Privileged != nil && file.Privileged.Trust != nil:
			a.PrivilegedAnswers, replaceTrust = true, true
		default:
			// The entries are long keys: they are named, never printed back as a default.
			keep, err := yesNo(nil, "Keep the current trust entries ("+trustSummary(state.trustNames)+")", true)
			if err != nil {
				return resolved{}, err
			}
			a.PrivilegedAnswers, replaceTrust = !keep, !keep
		}
		a.ReplaceTrust = replaceTrust
		if a.PrivilegedAnswers {
			if a.LocalRoot, err = yesNo(privilegedLocalRoot(file), "Let local root open the local approval window", true); err != nil {
				return resolved{}, err
			}
			if file.Privileged != nil && file.Privileged.Trust != nil {
				a.Trust = strings.TrimRight(*file.Privileged.Trust, " \t\r\n")
			} else {
				asked = true
				if a.Trust, err = askTrust(p); err != nil {
					return resolved{}, err
				}
			}
		}
	}
	if a.Start, err = yesNo(serviceStart(file), "Start the services", true); err != nil {
		return resolved{}, err
	}
	if asked {
		if err := confirm(p, a, enrolled, say); err != nil {
			return resolved{}, err
		}
	}
	return a, nil
}

// checkKeptServer refuses a crhs address other than crha.toml's when the enrollment is kept: the
// address belongs to the enrollment, and the kept key is registered with that crhs only.
func checkKeptServer(a resolved) error {
	if a.Keep && a.Previous != nil && sameServer(a.Server, a.Previous.Server) {
		return nil
	}
	if a.Keep && a.Previous != nil && a.Server != a.Previous.Server {
		return fmt.Errorf("the crhs address is %q in crha.toml: changing it to %q is a new enrollment; enroll again with a token from that crhs", a.Previous.Server, a.Server)
	}
	return nil
}

// sameServer compares crhs addresses as crha uses them: a trailing slash names the same crhs.
func sameServer(a, b string) bool {
	return strings.TrimRight(a, "/") == strings.TrimRight(b, "/")
}

// keepServerSpelling keeps crha.toml's spelling of the crhs address when an answer names the same crhs,
// so the file does not change for a trailing slash.
func keepServerSpelling(a *resolved) {
	if a.Previous != nil && sameServer(a.Server, a.Previous.Server) {
		a.Server = a.Previous.Server
	}
}

// startAnswers takes what the answers file and an existing crha.toml say before any question: the
// file's values, over the existing configuration's as defaults. The crhs address belongs to the
// enrollment, so on the keep path a different one is refused.
func startAnswers(file *fileAnswers, state existingSetup) (resolved, error) {
	existing := state.config
	a := resolved{}
	if file.Replace != nil && state.enrolled {
		a.Replace, a.Keep = *file.Replace, !*file.Replace
	}
	if a.Keep && existing == nil {
		return resolved{}, errors.New("crha.toml is missing; re-enroll (replace) or restore it")
	}
	if existing != nil {
		a.FromConfig = true
		a.Previous = existing
		a.Server, a.TLSVerify, a.Mode = existing.Server, existing.TLSVerify, existing.Privilege.Mode
	}
	if file.Server != nil {
		a.Server = strings.TrimSpace(*file.Server)
		keepServerSpelling(&a)
		if err := checkKeptServer(a); err != nil {
			return resolved{}, err
		}
	}
	if file.TLSVerify != nil {
		a.TLSVerify = strings.TrimSpace(*file.TLSVerify)
	}
	if m := privilegedMode(file); m != nil {
		a.Mode = strings.TrimSpace(*m)
	}
	return a, nil
}

// defaultMode is the privileged mode question's default: the existing one, ignore for a new node.
func defaultMode(current string) string {
	if current == "" {
		return config.ModeIgnore
	}
	return current
}

// checkMode allows ignore and forward, and keeps an existing native or reject set up by hand.
func checkMode(mode string, existing *config.Config) error {
	if mode == config.ModeIgnore || mode == config.ModeForward {
		return nil
	}
	if existing != nil && mode == existing.Privilege.Mode {
		return nil
	}
	return fmt.Errorf("privileged.mode must be \"ignore\" or \"forward\", got %q", mode)
}

// trustSummary names the trust entries without their keys.
func trustSummary(names []string) string {
	if len(names) == 0 {
		return "none"
	}
	return fmt.Sprintf("%d: %s", len(names), strings.Join(names, ", "))
}

// confirm shows the settings of an interactive run and asks to proceed.
func confirm(p *prompter, a resolved, enrolled bool, say func(string)) error {
	say("crha enroll: settings")
	if enrolled {
		enrollment := "enroll again with a new key"
		switch {
		case a.Keep:
			enrollment = "keep existing"
		case a.Previous != nil && !sameServer(a.Previous.Server, a.Server):
			enrollment = "enroll again with a new key, as a new node of " + a.Server
		}
		say("  enrollment: " + enrollment)
	}
	setting := func(name, value, previous string) {
		switch {
		case !a.FromConfig:
			say("  " + name + ": " + value)
		case value == previous:
			say("  " + name + ": " + value + " (unchanged)")
		default:
			say("  " + name + ": " + previous + " -> " + value)
		}
	}
	var previous config.Config
	if a.Previous != nil {
		previous = *a.Previous
	}
	setting("crhs address", a.Server, previous.Server)
	setting("TLS verify", a.TLSVerify, previous.TLSVerify)
	setting("privileged mode", a.Mode, previous.Privilege.Mode)
	if a.PrivilegedAnswers {
		localRoot := "no"
		if a.LocalRoot {
			localRoot = "yes"
		}
		trust := "pasted"
		if strings.TrimSpace(a.Trust) == "" {
			trust = "configure later"
		}
		if a.ReplaceTrust {
			trust = "replace the current entries with the pasted ones"
		}
		say("  local root approval: " + localRoot + ", trust: " + trust)
	}
	start := "do not start"
	if a.Start {
		start = "start"
	}
	say("  service: " + start)
	answer, err := p.ask("Proceed? [Y/n] ")
	if err != nil {
		return err
	}
	proceed, ok := yesno.Parse(answer, true)
	if !ok {
		return errors.New("please answer yes or no")
	}
	if !proceed {
		return errors.New("aborted")
	}
	return nil
}

// resolveFileAnswers is the all-from-file path: every missing field already failed, so this never asks.
func resolveFileAnswers(file *fileAnswers, state existingSetup) (resolved, error) {
	if state.enrolled && file.Replace == nil {
		return resolved{}, errors.New("missing answers for replace; put it in the --answers file")
	}
	a, err := startAnswers(file, state)
	if err != nil {
		return resolved{}, err
	}
	a.Start = *serviceStart(file)
	if !a.Keep {
		a.Token = trimValue(file.Token)
	}
	if err := checkMode(a.Mode, state.config); err != nil {
		return resolved{}, err
	}
	// Without privileged.toml on the keep path there is no node id to write one with: checkKeep says so.
	if a.Mode == config.ModeForward && file.Privileged != nil && file.Privileged.Trust != nil {
		a.PrivilegedAnswers = true
		a.ReplaceTrust = state.privilegedConfig
		a.LocalRoot = true
		if v := privilegedLocalRoot(file); v != nil {
			a.LocalRoot = *v
		}
		a.Trust = strings.TrimRight(*file.Privileged.Trust, " \t\r\n")
	}
	return a, nil
}

func trimValue(value *string) string {
	if value == nil {
		return ""
	}
	return strings.TrimSpace(*value)
}

func privilegedMode(file *fileAnswers) *string {
	if file.Privileged == nil {
		return nil
	}
	return file.Privileged.Mode
}

func privilegedLocalRoot(file *fileAnswers) *bool {
	if file.Privileged == nil {
		return nil
	}
	return file.Privileged.LocalRoot
}

func serviceStart(file *fileAnswers) *bool {
	if file.Service == nil {
		return nil
	}
	return file.Service.Start
}

// askTrust reads the pasted trust entries until a line containing only ".".
func askTrust(p *prompter) (string, error) {
	fmt.Fprintln(p.out, `Paste the trust entries from the WebUI's "Generate trust config", ending with a line "." (empty to configure later):`)
	var lines []string
	for {
		line, err := p.ask("")
		if errors.Is(err, io.EOF) {
			return "", errors.New(`the trust config must end with a line "."`)
		}
		if err != nil {
			return "", err
		}
		if line == "." {
			break
		}
		lines = append(lines, line)
	}
	return strings.TrimRight(strings.Join(lines, "\n"), " \t\r\n"), nil
}

// savedAnswers is `--save-answers`: the answers without the token.
type savedAnswers struct {
	Version    int             `json:"version"`
	Server     string          `json:"server"`
	TLSVerify  string          `json:"tls_verify"`
	Replace    bool            `json:"replace"`
	Privileged savedPrivileged `json:"privileged"`
	Service    fileService     `json:"service"`
}

type savedPrivileged struct {
	Mode      string  `json:"mode"`
	LocalRoot *bool   `json:"local_root,omitempty"`
	Trust     *string `json:"trust,omitempty"`
}

// saveAnswers writes the answered questions without the token, readable only by their owner.
func saveAnswers(path string, a resolved) error {
	saved := savedAnswers{
		Version:   1,
		Server:    a.Server,
		TLSVerify: a.TLSVerify,
		Replace:   a.Replace,
		Privileged: savedPrivileged{
			Mode: a.Mode,
		},
		Service: fileService{Start: &a.Start},
	}
	if a.PrivilegedAnswers {
		localRoot := a.LocalRoot
		trust := a.Trust
		saved.Privileged.LocalRoot = &localRoot
		saved.Privileged.Trust = &trust
	}
	data, err := json.MarshalIndent(saved, "", "  ")
	if err != nil {
		return err
	}
	data = append(data, '\n')
	// The file may hold trust entries: written whole, 0600, never through a link at path.
	return fsutil.WriteFile(path, data, 0o600, fsutil.WriteOptions{})
}
