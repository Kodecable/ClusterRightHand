// Package config loads and validates the crha configuration file.
package config

import (
	"bytes"
	"errors"
	"fmt"
	"net"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/pelletier/go-toml/v2"
)

// DefaultPath is where crha looks for its configuration by default.
const DefaultPath = "/etc/crha/crha.toml"

const (
	DefaultStateDir         = "/var/lib/crha"
	DefaultPrivilegedSocket = "/run/crha/privileged.sock"
)

// Privileged modes.
const (
	ModeForward = "forward"
	ModeNative  = "native"
	ModeIgnore  = "ignore"
	ModeReject  = "reject"
)

// TLS verification modes.
const (
	TLSVerifySystem = "system"
	TLSVerifyNone   = "none"
)

const (
	defaultMaxAge   = 168 * time.Hour
	defaultMaxTotal = int64(1) << 30
)

var groupRe = regexp.MustCompile(`^[a-z0-9][a-z0-9._-]{0,63}$`)

// Config is the validated crha configuration.
type Config struct {
	Server    string
	TLSVerify string
	StateDir  string
	Notes     string
	Groups    []string
	Privilege Privileged
	Output    Output
}

// Privileged configures handling of privileged tasks.
type Privileged struct {
	Mode   string
	Socket string
	Native string
}

// Output configures retention of task output.
type Output struct {
	Dir      string
	MaxAge   time.Duration
	MaxTotal int64
}

type rawConfig struct {
	Server     string   `toml:"server"`
	TLSVerify  string   `toml:"tls_verify"`
	StateDir   string   `toml:"state_dir"`
	Notes      string   `toml:"notes"`
	Groups     []string `toml:"groups"`
	Privileged struct {
		Mode   string `toml:"mode"`
		Socket string `toml:"socket"`
		Native string `toml:"native"`
	} `toml:"privileged"`
	Output struct {
		Dir      string `toml:"dir"`
		MaxAge   string `toml:"max_age"`
		MaxTotal string `toml:"max_total"`
	} `toml:"output"`
}

// Load reads and parses the configuration file at path.
func Load(path string) (*Config, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, fmt.Errorf("config: read %s: %w", path, err)
	}
	return Parse(data)
}

// Parse parses and validates TOML configuration data.
func Parse(data []byte) (*Config, error) {
	var raw rawConfig
	dec := toml.NewDecoder(bytes.NewReader(data))
	dec.DisallowUnknownFields()
	if err := dec.Decode(&raw); err != nil {
		var sm *toml.StrictMissingError
		if errors.As(err, &sm) {
			return nil, fmt.Errorf("config: unknown key: %s", unknownKeys(sm))
		}
		return nil, fmt.Errorf("config: parse: %w", err)
	}
	return build(&raw)
}

func unknownKeys(sm *toml.StrictMissingError) string {
	keys := make([]string, 0, len(sm.Errors))
	for _, e := range sm.Errors {
		keys = append(keys, strings.Join(e.Key(), "."))
	}
	return strings.Join(keys, ", ")
}

func build(raw *rawConfig) (*Config, error) {
	c := &Config{
		Server:    raw.Server,
		TLSVerify: orDefault(raw.TLSVerify, TLSVerifySystem),
		StateDir:  orDefault(raw.StateDir, DefaultStateDir),
		Notes:     raw.Notes,
		Privilege: Privileged{
			Mode:   orDefault(raw.Privileged.Mode, ModeReject),
			Socket: orDefault(raw.Privileged.Socket, DefaultPrivilegedSocket),
			Native: orDefault(raw.Privileged.Native, "sudo"),
		},
		Output: Output{Dir: raw.Output.Dir, MaxAge: defaultMaxAge, MaxTotal: defaultMaxTotal},
	}
	if err := validateServer(c.Server); err != nil {
		return nil, err
	}
	if c.TLSVerify != TLSVerifySystem && c.TLSVerify != TLSVerifyNone {
		return nil, fmt.Errorf("config: tls_verify: invalid value %q (want system or none)", c.TLSVerify)
	}
	if err := requireAbs("state_dir", c.StateDir, true); err != nil {
		return nil, err
	}
	if c.Notes == "" {
		c.Notes = filepath.Join(c.StateDir, "NOTES.md")
	}
	if c.Output.Dir == "" {
		c.Output.Dir = filepath.Join(c.StateDir, "output")
	}
	for name, p := range map[string]string{"notes": c.Notes, "output.dir": c.Output.Dir} {
		if err := requireAbs(name, p, false); err != nil {
			return nil, err
		}
	}
	groups, err := validateGroups(raw.Groups)
	if err != nil {
		return nil, err
	}
	c.Groups = groups
	if err := c.validatePrivileged(); err != nil {
		return nil, err
	}
	if err := c.parseOutput(&raw.Output.MaxAge, &raw.Output.MaxTotal); err != nil {
		return nil, err
	}
	return c, nil
}

func orDefault(v, def string) string {
	if v == "" {
		return def
	}
	return v
}

func requireAbs(name, p string, required bool) error {
	if p == "" && required {
		return fmt.Errorf("config: %s: required", name)
	}
	if !filepath.IsAbs(p) {
		return fmt.Errorf("config: %s: path %q must be absolute", name, p)
	}
	return nil
}

func validateServer(s string) error {
	if s == "" {
		return errors.New("config: server: required")
	}
	u, err := url.Parse(s)
	if err != nil {
		return fmt.Errorf("config: server: %w", err)
	}
	if u.Hostname() == "" {
		return fmt.Errorf("config: server: %q has no host", s)
	}
	switch u.Scheme {
	case "https":
	case "http":
		if !isLoopback(u.Hostname()) {
			return fmt.Errorf("config: server: http is only allowed for loopback hosts, got %q", u.Hostname())
		}
	default:
		return fmt.Errorf("config: server: unsupported scheme %q (want https)", u.Scheme)
	}
	return nil
}

func isLoopback(host string) bool {
	if host == "localhost" {
		return true
	}
	ip := net.ParseIP(host)
	return ip != nil && ip.IsLoopback()
}

func validateGroups(in []string) ([]string, error) {
	var out []string
	seen := map[string]bool{}
	for _, g := range in {
		if !groupRe.MatchString(g) {
			return nil, fmt.Errorf("config: groups: invalid group name %q", g)
		}
		if !seen[g] {
			seen[g] = true
			out = append(out, g)
		}
	}
	return out, nil
}

func (c *Config) validatePrivileged() error {
	p := &c.Privilege
	switch p.Mode {
	case ModeForward, ModeNative, ModeIgnore, ModeReject:
	default:
		return fmt.Errorf("config: privileged.mode: invalid value %q", p.Mode)
	}
	if p.Socket != "" && !filepath.IsAbs(p.Socket) {
		return fmt.Errorf("config: privileged.socket: path %q must be absolute", p.Socket)
	}
	switch p.Native {
	case "sudo", "doas", "run0":
	default:
		return fmt.Errorf("config: privileged.native: invalid value %q (want sudo, doas or run0)", p.Native)
	}
	return nil
}

func (c *Config) parseOutput(maxAge, maxTotal *string) error {
	if *maxAge != "" {
		d, err := time.ParseDuration(*maxAge)
		if err != nil {
			return fmt.Errorf("config: output.max_age: %w", err)
		}
		if d <= 0 {
			return fmt.Errorf("config: output.max_age: must be positive")
		}
		c.Output.MaxAge = d
	}
	if *maxTotal != "" {
		n, err := parseSize(*maxTotal)
		if err != nil {
			return fmt.Errorf("config: output.max_total: %w", err)
		}
		c.Output.MaxTotal = n
	}
	return nil
}

var sizeUnits = []struct {
	suffix string
	mult   int64
}{{"KiB", 1 << 10}, {"MiB", 1 << 20}, {"GiB", 1 << 30}}

func parseSize(s string) (int64, error) {
	num, mult := strings.TrimSpace(s), int64(1)
	for _, u := range sizeUnits {
		if t, ok := strings.CutSuffix(num, u.suffix); ok {
			num, mult = strings.TrimSpace(t), u.mult
			break
		}
	}
	n, err := strconv.ParseInt(num, 10, 64)
	if err != nil {
		return 0, fmt.Errorf("invalid size %q", s)
	}
	if n <= 0 {
		return 0, fmt.Errorf("size %q must be positive", s)
	}
	if n > (1<<63-1)/mult {
		return 0, fmt.Errorf("size %q overflows", s)
	}
	return n * mult, nil
}

// IdentityKeyPath returns the path of the node identity key.
func (c *Config) IdentityKeyPath() string { return filepath.Join(c.StateDir, "identity.key") }

// ServerKeyPath returns the path of the pinned server public key.
func (c *Config) ServerKeyPath() string { return filepath.Join(c.StateDir, "server.pub") }

// AgentURL returns the websocket URL of the server's agent endpoint.
func (c *Config) AgentURL() string {
	u, err := url.Parse(c.Server)
	if err != nil {
		return ""
	}
	if u.Scheme == "https" {
		u.Scheme = "wss"
	} else {
		u.Scheme = "ws"
	}
	u.Path = strings.TrimRight(u.Path, "/") + "/agent"
	u.RawPath = ""
	u.RawQuery, u.Fragment = "", ""
	return u.String()
}
