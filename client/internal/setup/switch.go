package setup

import (
	"fmt"
	"strings"

	toml "github.com/pelletier/go-toml/v2"
	"github.com/pelletier/go-toml/v2/unstable/edit"

	"github.com/Kodecable/ClusterRightHand/client/internal/config"
	privconfig "github.com/Kodecable/ClusterRightHand/client/internal/privileged/config"
)

// Switching an existing node (doc/design/distribution.md "crha enroll"): when the answers differ from
// crha.toml, or replace the trust entries of privileged.toml, enroll edits the files in place with
// go-toml's comment-preserving editor, so whatever it does not change stays as it was.

// editConfig returns crha.toml switched to the answers' crhs address, TLS check and privileged mode,
// and what changed; nil when nothing does.
func editConfig(data []byte, a resolved) ([]byte, []string, error) {
	current, err := config.Parse(data)
	if err != nil {
		return nil, nil, err
	}
	doc, err := edit.Parse(data)
	if err != nil {
		return nil, nil, err
	}
	var changes []string
	set := func(path []string, from, to string) error {
		if from == to {
			return nil
		}
		changes = append(changes, fmt.Sprintf("%s: %s -> %s", strings.Join(path, "."), from, to))
		return doc.Set(path, to)
	}
	if err := set([]string{"server"}, current.Server, a.Server); err != nil {
		return nil, nil, err
	}
	if err := set([]string{"tls_verify"}, current.TLSVerify, a.TLSVerify); err != nil {
		return nil, nil, err
	}
	if err := set([]string{"privileged", "mode"}, current.Privilege.Mode, a.Mode); err != nil {
		return nil, nil, err
	}
	// forward needs the socket, which a node first set up in another mode does not name.
	if a.Mode == config.ModeForward && !doc.Has([]string{"privileged", "socket"}) {
		if err := doc.Set([]string{"privileged", "socket"}, PrivilegedSocket); err != nil {
			return nil, nil, err
		}
	}
	if len(changes) == 0 {
		return nil, nil, nil
	}
	out := doc.Bytes()
	if _, err := config.Parse(out); err != nil {
		return nil, nil, fmt.Errorf("switched crha.toml: %w", err)
	}
	return out, changes, nil
}

// replaceTrust returns privileged.toml with every trust entry replaced by the local root entry (when
// localRoot) and the pasted ones; the rest of the file stays as it was.
func replaceTrust(data []byte, localRoot bool, trust string) ([]byte, error) {
	doc, err := edit.Parse(data)
	if err != nil {
		return nil, err
	}
	doc.Delete([]string{"trust"})
	out := strings.TrimRight(string(doc.Bytes()), "\n") + "\n"
	if entries := trustEntries(localRoot, trust); entries != "" {
		out += "\n" + entries + "\n"
	}
	return []byte(out), nil
}

// setNodeID returns privileged.toml naming nodeID, and the id it named; nil when it names it already.
func setNodeID(data []byte, nodeID string) ([]byte, string, error) {
	current, err := privconfig.Parse(data)
	if err != nil {
		return nil, "", fmt.Errorf("%s: %w", PrivilegedConfigPath, err)
	}
	if current.NodeID == nodeID {
		return nil, "", nil
	}
	doc, err := edit.Parse(data)
	if err != nil {
		return nil, "", err
	}
	if err := doc.Set([]string{"node_id"}, nodeID); err != nil {
		return nil, "", err
	}
	out := doc.Bytes()
	if _, err := privconfig.Parse(out); err != nil {
		return nil, "", fmt.Errorf("privileged.toml with the new node id: %w", err)
	}
	return out, current.NodeID, nil
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
