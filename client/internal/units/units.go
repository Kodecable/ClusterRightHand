// Package units renders and reads the systemd units crha manages (doc/design/distribution.md
// "Generated units"). `crha enroll` writes them, and an upgrade regenerates them from their metadata
// with the new version's templates, so both go through this one package.
package units

import (
	"bufio"
	"encoding/json"
	"strings"

	"github.com/Kodecable/ClusterRightHand/client/internal/config"
)

const (
	// Dir is where crha writes its units.
	Dir = "/etc/systemd/system"
	// Server is the unprivileged mode's unit.
	Server = "crha.service"
	// Privileged is the privileged mode's unit, present in forward mode only.
	Privileged = "crha-privileged.service"
	// ManagedHeader starts every unit crha writes.
	ManagedHeader = "# This file is managed by crha. DO NOT EDIT; customize with systemctl edit.\n"
	// MetaVersion is the version of the X-CRH-Meta object.
	MetaVersion = 1
)

// Meta is the X-CRH-Meta object: what a later version needs to regenerate the unit.
type Meta struct {
	V       int    `json:"v"`
	Version string `json:"version"`
	Mode    string `json:"mode"`
	Config  string `json:"config"`
}

func metaLine(mode, configPath, version string) string {
	meta, err := json.Marshal(Meta{V: MetaVersion, Version: version, Mode: mode, Config: configPath})
	if err != nil {
		return ""
	}
	return "X-CRH-Meta=" + string(meta)
}

// Names are the units crha runs under in a privileged mode.
func Names(mode string) []string {
	if mode == config.ModeForward {
		return []string{Privileged, Server}
	}
	return []string{Server}
}

// RenderServer renders crha.service: the unprivileged mode, as user, with its configuration.
func RenderServer(executable, configPath, mode, user, version string) string {
	after := "network-online.target"
	wants := "network-online.target"
	if mode == config.ModeForward {
		after += " " + Privileged
		wants += " " + Privileged
	}
	return ManagedHeader + `[Unit]
Description=ClusterRightHand node agent
After=` + after + `
Wants=` + wants + `
X-CRH-Managed=1
` + metaLine(mode, configPath, version) + `

[Service]
User=` + user + `
Group=` + user + `
ExecStart=` + executable + ` run --config ` + configPath + `
ExecReload=/bin/kill -HUP $MAINPID
Restart=on-failure

[Install]
WantedBy=multi-user.target
`
}

// RenderPrivileged renders crha-privileged.service: the privileged mode, as root.
func RenderPrivileged(executable, configPath, version string) string {
	return ManagedHeader + `[Unit]
Description=ClusterRightHand node agent (privileged)
Before=` + Server + `
X-CRH-Managed=1
` + metaLine(config.ModeForward, configPath, version) + `

[Service]
User=root
RuntimeDirectory=crha
RuntimeDirectoryMode=0755
ExecStart=` + executable + ` privileged run --config ` + configPath + `
ExecReload=/bin/kill -HUP $MAINPID
Restart=on-failure
UMask=0077

[Install]
WantedBy=multi-user.target
`
}

// Parsed is what crha reads back from a unit file.
type Parsed struct {
	// Managed is true when [Unit] carries X-CRH-Managed=1.
	Managed bool
	// Meta is the X-CRH-Meta object, nil when absent or unreadable.
	Meta *Meta
	// Executable is the first word of [Service] ExecStart, empty when there is none.
	Executable string
}

// Parse reads the keys crha cares about. It is deliberately small: only units crha wrote are
// regenerated, and those have one ExecStart without systemd's prefixes or quoting.
func Parse(content string) Parsed {
	var out Parsed
	section := ""
	scanner := bufio.NewScanner(strings.NewReader(content))
	scanner.Buffer(make([]byte, 64*1024), 1024*1024)
	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		if line == "" || strings.HasPrefix(line, "#") || strings.HasPrefix(line, ";") {
			continue
		}
		if strings.HasPrefix(line, "[") && strings.HasSuffix(line, "]") {
			section = line
			continue
		}
		key, value, ok := strings.Cut(line, "=")
		if !ok {
			continue
		}
		key, value = strings.TrimSpace(key), strings.TrimSpace(value)
		switch {
		case section == "[Unit]" && key == "X-CRH-Managed":
			out.Managed = value == "1"
		case section == "[Unit]" && key == "X-CRH-Meta":
			var meta Meta
			if json.Unmarshal([]byte(value), &meta) == nil {
				out.Meta = &meta
			}
		case section == "[Service]" && key == "ExecStart":
			if fields := strings.Fields(value); len(fields) > 0 {
				out.Executable = fields[0]
			}
		}
	}
	return out
}
