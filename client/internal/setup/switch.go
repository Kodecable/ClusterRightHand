package setup

import (
	"fmt"
	"strings"

	toml "github.com/pelletier/go-toml/v2"

	"github.com/Kodecable/ClusterRightHand/client/internal/config"
	privconfig "github.com/Kodecable/ClusterRightHand/client/internal/privileged/config"
	"github.com/Kodecable/ClusterRightHand/client/internal/tomledit"
)

// Switching an existing node (doc/design/distribution.md "Switching a node set up before"): when the
// answers differ from crha.toml, replace the trust entries of privileged.toml, or register a new node,
// enroll edits the files in place through tomledit, as the self-upgrade's migrations do, so whatever it
// does not change stays as it was. Each edit comes with the line enroll reports when it changes the file.

// change is one edit and the line that reports it.
type change struct {
	edit tomledit.Edit
	line string
}

// editing turns changes into a Content.Edit: each applied in order, reported when it changed something.
func editing(changes ...change) func([]byte) ([]byte, []string, error) {
	return func(data []byte) ([]byte, []string, error) {
		var lines []string
		for _, c := range changes {
			out, changed, err := tomledit.ApplyOne(data, c.edit)
			if err != nil {
				return nil, nil, fmt.Errorf("%s: %w", c.edit, err)
			}
			if changed {
				data, lines = out, append(lines, c.line)
			}
		}
		return data, lines, nil
	}
}

// configChanges switch crha.toml to the answers' crhs address, TLS check and privileged mode.
func configChanges(current *config.Config, a resolved) []change {
	var out []change
	set := func(path []string, from, to string) {
		if from != to {
			out = append(out, change{
				edit: tomledit.Edit{Op: tomledit.Set, Path: path, Value: to},
				line: fmt.Sprintf("%s: %s -> %s", strings.Join(path, "."), from, to),
			})
		}
	}
	set([]string{"server"}, current.Server, a.Server)
	set([]string{"tls_verify"}, current.TLSVerify, a.TLSVerify)
	set([]string{"privileged", "mode"}, current.Privilege.Mode, a.Mode)
	// forward needs the socket, which a node first set up in another mode does not name.
	if a.Mode == config.ModeForward && current.Privilege.Socket == "" {
		set([]string{"privileged", "socket"}, "", PrivilegedSocket)
	}
	return out
}

// trustChange replaces every trust entry by the local root entry (when localRoot) and the pasted ones.
func trustChange(localRoot bool, trust string) change {
	return change{
		edit: tomledit.Edit{Op: tomledit.ReplaceTables, Path: []string{"trust"}, Tables: trustEntries(localRoot, trust)},
		line: "the trust entries",
	}
}

// nodeIDEdit points privileged.toml at nodeID, reporting the id it named before.
func nodeIDEdit(nodeID string) func([]byte) ([]byte, []string, error) {
	return func(data []byte) ([]byte, []string, error) {
		current, err := privconfig.Parse(data)
		if err != nil {
			return nil, nil, err
		}
		return editing(change{
			edit: tomledit.Edit{Op: tomledit.Set, Path: []string{"node_id"}, Value: nodeID},
			line: fmt.Sprintf("node_id: %s -> %s", current.NodeID, nodeID),
		})(data)
	}
}

// trustEntries renders the trust entries of a privileged.toml: the local root entry and the pasted ones.
func trustEntries(localRoot bool, trust string) string {
	var parts []string
	if localRoot {
		parts = append(parts, "[[trust]]\nname = \"local-root\"\nrole = \"local\"\nuids = [0]")
	}
	if trust = strings.TrimSpace(trust); trust != "" {
		parts = append(parts, trust)
	}
	return strings.Join(parts, "\n\n")
}

// trustNamesOf names the trust entries of a privileged.toml, for a question that must not print keys.
func trustNamesOf(data []byte) []string {
	var file struct {
		Trust []struct {
			Name string `toml:"name"`
		} `toml:"trust"`
	}
	if toml.Unmarshal(data, &file) != nil {
		return nil
	}
	names := make([]string, 0, len(file.Trust))
	for _, entry := range file.Trust {
		names = append(names, entry.Name)
	}
	return names
}
