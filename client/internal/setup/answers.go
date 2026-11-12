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
	// Keep is replace=no on an enrolled node: the enrollment is left alone and its questions (server,
	// TLS, privileged mode) are answered by the existing crha.toml instead of being asked.
	Keep      bool
	Mode      string
	LocalRoot bool
	Trust     string
	Start     bool
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
// questions nor the privileged ones, because the existing crha.toml answers them.
func (a *fileAnswers) missingFields(enrolled bool) []string {
	var fields []string
	add := func(name string, present bool) {
		if !present {
			fields = append(fields, name)
		}
	}
	addStart := func() { add("service.start", a.Service != nil && a.Service.Start != nil) }
	if enrolled {
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
func collectAnswers(file *fileAnswers, existing *config.Config, enrolled bool, interactive bool, input io.Reader, promptOut io.Writer, say func(string)) (resolved, error) {
	if !interactive {
		if missing := file.missingFields(enrolled); len(missing) > 0 {
			return resolved{}, fmt.Errorf("missing answers for %s; put them in the --answers file or run on a terminal", strings.Join(missing, ", "))
		}
		return resolveFileAnswers(file, existing, enrolled)
	}
	p := newPrompter(input, promptOut)
	asked := false
	take := func(value *string, prompt, fallback string, required bool) (string, error) {
		if value != nil {
			return *value, nil
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
		switch strings.ToLower(text) {
		case "":
			return fallback, nil
		case "y", "yes":
			return true, nil
		case "n", "no":
			return false, nil
		default:
			return false, fmt.Errorf("%s: answer yes or no", prompt)
		}
	}

	a := resolved{}
	var err error
	// Re-enrollment is the first question on an enrolled node: answering no keeps the existing
	// enrollment, so the questions it would otherwise ask are not asked at all.
	if enrolled {
		replace, err := yesNo(file.Replace, "Re-enroll, keeping the node's id, name, groups and grants", false)
		if err != nil {
			return resolved{}, err
		}
		a.Replace = replace
		a.Keep = !replace
	}
	if a.Keep {
		if existing == nil {
			return resolved{}, errors.New("crha.toml is missing; re-enroll (replace) or restore it")
		}
		a.Server = existing.Server
		a.TLSVerify = existing.TLSVerify
		a.Mode = existing.Privilege.Mode
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

	if a.Server, err = take(file.Server, "crhs address", "", true); err != nil {
		return resolved{}, err
	}
	if file.Token != nil {
		a.Token = *file.Token
	} else {
		asked = true
		if a.Token, err = p.askSecret("Enrollment token: "); err != nil {
			return resolved{}, err
		}
		if a.Token == "" {
			return resolved{}, errors.New("Enrollment token must not be empty")
		}
	}

	if file.TLSVerify != nil {
		a.TLSVerify = *file.TLSVerify
	} else {
		verify, err := yesNo(nil, "Check the TLS certificate against the system CAs", true)
		if err != nil {
			return resolved{}, err
		}
		a.TLSVerify = "system"
		if !verify {
			a.TLSVerify = "none"
		}
	}

	if a.Mode, err = take(privilegedMode(file), "Privileged mode (ignore or forward)", "ignore", true); err != nil {
		return resolved{}, err
	}
	if a.Mode != "ignore" && a.Mode != "forward" {
		return resolved{}, fmt.Errorf("privileged.mode must be \"ignore\" or \"forward\", got %q", a.Mode)
	}
	if a.Mode == "forward" {
		if a.LocalRoot, err = yesNo(privilegedLocalRoot(file), "Let local root approve with crha approve", true); err != nil {
			return resolved{}, err
		}
		if file != nil && file.Privileged != nil && file.Privileged.Trust != nil {
			a.Trust = *file.Privileged.Trust
		} else {
			asked = true
			a.Trust, err = askTrust(p)
			if err != nil {
				return resolved{}, err
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

// confirm shows the settings of an interactive run and asks to proceed.
func confirm(p *prompter, a resolved, enrolled bool, say func(string)) error {
	say("crha enroll: settings")
	if enrolled {
		enrollment := "re-enroll"
		if a.Keep {
			enrollment = "keep existing"
		}
		say("  enrollment: " + enrollment)
	}
	if !a.Keep {
		say("  crhs address: " + a.Server)
		say("  TLS verify: " + a.TLSVerify)
		say("  privileged mode: " + a.Mode)
		if a.Mode == "forward" {
			localRoot := "no"
			if a.LocalRoot {
				localRoot = "yes"
			}
			trust := "pasted"
			if strings.TrimSpace(a.Trust) == "" {
				trust = "configure later"
			}
			say("  local root approval: " + localRoot + ", trust: " + trust)
		}
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
	switch strings.ToLower(answer) {
	case "", "y", "yes":
		return nil
	case "n", "no":
		return errors.New("aborted")
	default:
		return errors.New("please answer yes or no")
	}
}

// resolveFileAnswers is the all-from-file path: every missing field already failed, so this never asks.
func resolveFileAnswers(file *fileAnswers, existing *config.Config, enrolled bool) (resolved, error) {
	a := resolved{
		Server:    trimValue(file.Server),
		Token:     trimValue(file.Token),
		TLSVerify: trimValue(file.TLSVerify),
		Mode:      trimValue(privilegedMode(file)),
		Start:     *serviceStart(file),
	}
	if enrolled {
		if file.Replace == nil {
			return resolved{}, errors.New("missing answers for replace; put it in the --answers file")
		}
		if !*file.Replace {
			if existing == nil {
				return resolved{}, errors.New("crha.toml is missing; re-enroll (replace) or restore it")
			}
			// The file's enrollment and privileged fields are ignored: the existing crha.toml answers them.
			return resolved{
				Keep:      true,
				Server:    existing.Server,
				TLSVerify: existing.TLSVerify,
				Mode:      existing.Privilege.Mode,
				Start:     *serviceStart(file),
			}, nil
		}
		a.Replace = true
	}
	if a.Mode == "forward" {
		a.LocalRoot = *privilegedLocalRoot(file)
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
	if a.Mode == "forward" && !a.Keep {
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
	if err := os.WriteFile(path, data, 0o600); err != nil {
		return err
	}
	return os.Chmod(path, 0o600)
}
