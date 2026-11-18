package crhu

import (
	"bufio"
	"bytes"
	"errors"
	"fmt"
	"net"
	"os"
	"path/filepath"
	"strings"

	"github.com/spf13/pflag"
	"golang.org/x/crypto/ssh"
	"golang.org/x/crypto/ssh/agent"
)

// keyChoice selects the SSH key a command signs with. The key itself is never read: ssh-keygen
// signs with the file or, for an agent key, through the agent.
type keyChoice struct {
	key     string
	hints   []string
	keyDirs []string
	yes     bool
}

// addFlags registers the key selection flags; only the commands that confirm with --yes pass true.
func (o *keyChoice) addFlags(f *pflag.FlagSet, withYes bool) {
	f.StringVar(&o.key, "key", "", "path to the signing SSH key")
	f.StringArrayVar(&o.hints, "hint", nil, "SHA256 fingerprint of the signing key (repeatable)")
	f.StringArrayVar(&o.keyDirs, "key-dir", nil, "directory of public keys to consider (repeatable)")
	if withYes {
		f.BoolVar(&o.yes, "yes", false, "do not ask for confirmation")
	}
}

// keyCandidate is one key that could sign: a public key file, or an agent identity.
type keyCandidate struct {
	publicKey   ssh.PublicKey
	fingerprint string
	comment     string
	// path is the .pub file ssh-keygen signs with; empty for an agent-only identity.
	path string
	// agent is set when only the agent holds the key; signerPath writes a temporary .pub for it.
	agent bool
}

// signerPath returns the file to pass to ssh-keygen -f and a cleanup function.
func (c keyCandidate) signerPath() (string, func(), error) {
	if c.path != "" {
		return c.path, func() {}, nil
	}
	file, err := os.CreateTemp("", "crhu-agent-*.pub")
	if err != nil {
		return "", nil, fmt.Errorf("create a temporary public key: %w", err)
	}
	name := file.Name()
	cleanup := func() { _ = os.Remove(name) }
	if _, err := file.Write(ssh.MarshalAuthorizedKey(c.publicKey)); err != nil {
		_ = file.Close()
		cleanup()
		return "", nil, fmt.Errorf("write the temporary public key: %w", err)
	}
	if err := file.Close(); err != nil {
		cleanup()
		return "", nil, fmt.Errorf("close the temporary public key: %w", err)
	}
	return name, cleanup, nil
}

// describe is one line of the candidate list: the fingerprint, where it comes from and its comment.
func (c keyCandidate) describe() string {
	where := c.path
	if where == "" {
		where = "ssh-agent"
	}
	line := fmt.Sprintf("%s  %s", c.fingerprint, where)
	if c.comment != "" {
		line += fmt.Sprintf(" (%s)", c.comment)
	}
	return line
}

// discoverCandidates lists the keys that could sign, in order: the agent's identities, then
// ~/.ssh/*.pub, then each --key-dir. Duplicates by fingerprint keep their first position; an
// agent identity that also has a .pub file uses that file.
func discoverCandidates(opts *keyChoice) ([]keyCandidate, error) {
	var candidates []keyCandidate
	byFingerprint := make(map[string]int)
	add := func(candidate keyCandidate) {
		if index, ok := byFingerprint[candidate.fingerprint]; ok {
			// A .pub file for an agent-only key gives ssh-keygen a path to read.
			if candidates[index].path == "" && candidate.path != "" {
				candidates[index].path = candidate.path
				candidates[index].agent = false
			}
			return
		}
		byFingerprint[candidate.fingerprint] = len(candidates)
		candidates = append(candidates, candidate)
	}
	if socket := os.Getenv("SSH_AUTH_SOCK"); socket != "" {
		if conn, err := net.Dial("unix", socket); err == nil {
			keys, err := agent.NewClient(conn).List()
			_ = conn.Close()
			if err == nil {
				for _, key := range keys {
					add(keyCandidate{publicKey: key, fingerprint: ssh.FingerprintSHA256(key), comment: key.Comment, agent: true})
				}
			}
		}
	}
	if home, err := os.UserHomeDir(); err == nil {
		// A missing ~/.ssh is normal: there are simply no keys there.
		_ = addPubKeys(filepath.Join(home, ".ssh"), add)
	}
	for _, dir := range opts.keyDirs {
		if err := addPubKeys(dir, add); err != nil {
			return nil, fmt.Errorf("--key-dir %s: %w", dir, err)
		}
	}
	return candidates, nil
}

// addPubKeys adds every parsable *.pub in dir. A malformed public key is skipped: the directory
// may hold files that are not keys, and only a key that signs can be chosen.
func addPubKeys(dir string, add func(keyCandidate)) error {
	entries, err := os.ReadDir(dir)
	if err != nil {
		return err
	}
	for _, entry := range entries {
		if entry.IsDir() || !strings.HasSuffix(entry.Name(), ".pub") {
			continue
		}
		path := filepath.Join(dir, entry.Name())
		data, err := os.ReadFile(path)
		if err != nil {
			continue
		}
		key, comment, _, rest, err := ssh.ParseAuthorizedKey(data)
		if err != nil || len(bytes.TrimSpace(rest)) != 0 {
			continue
		}
		add(keyCandidate{publicKey: key, fingerprint: ssh.FingerprintSHA256(key), comment: comment, path: path})
	}
	return nil
}

// signer chooses the key path for one signing command, prompting on the terminal when the choice
// is ambiguous. With --key the flag's path is used exactly; with hints the first matching candidate
// wins; without either a single candidate is used automatically.
func (o *keyChoice) signer(command string) (keyCandidate, error) {
	if o.key != "" {
		return keyCandidate{path: o.key}, nil
	}
	for _, hint := range o.hints {
		if !strings.HasPrefix(hint, "SHA256:") || len(hint) == len("SHA256:") {
			return keyCandidate{}, fmt.Errorf("%s: --hint %q is not a SHA256 fingerprint", command, hint)
		}
	}
	candidates, err := discoverCandidates(o)
	if err != nil {
		return keyCandidate{}, fmt.Errorf("%s: %w", command, err)
	}
	if len(o.hints) > 0 {
		for _, candidate := range candidates {
			for _, hint := range o.hints {
				if candidate.fingerprint == hint {
					return candidate, nil
				}
			}
		}
		return keyCandidate{}, fmt.Errorf("%s: no key matches --hint; wanted %s; found %s",
			command, strings.Join(o.hints, ", "), describeCandidates(candidates))
	}
	if len(candidates) == 0 {
		return keyCandidate{}, fmt.Errorf("%s: no SSH signing key found; pass --key or --hint", command)
	}
	if len(candidates) == 1 {
		return candidates[0], nil
	}
	if o.yes {
		return keyCandidate{}, fmt.Errorf("%s: several SSH keys can sign; pass --hint or --key:\n%s",
			command, candidateList(candidates))
	}
	return chooseCandidate(command, candidates)
}

// describeCandidates is the compact form used in errors: fingerprints and their sources.
func describeCandidates(candidates []keyCandidate) string {
	if len(candidates) == 0 {
		return "none"
	}
	parts := make([]string, 0, len(candidates))
	for _, candidate := range candidates {
		where := candidate.path
		if where == "" {
			where = "ssh-agent"
		}
		parts = append(parts, fmt.Sprintf("%s (%s)", candidate.fingerprint, where))
	}
	return strings.Join(parts, ", ")
}

// candidateList is the numbered form shown before a prompt or in an error.
func candidateList(candidates []keyCandidate) string {
	var list strings.Builder
	for index, candidate := range candidates {
		fmt.Fprintf(&list, "  %d. %s\n", index+1, candidate.describe())
	}
	return strings.TrimRight(list.String(), "\n")
}

// chooseCandidate asks on the controlling terminal which key to sign with. Without a terminal the
// candidate list is returned as the error, like a missing confirmation.
func chooseCandidate(command string, candidates []keyCandidate) (keyCandidate, error) {
	terminal, err := openTerminal()
	if err != nil {
		return keyCandidate{}, fmt.Errorf("%s: several SSH keys can sign and there is no terminal to choose; pass --key or --hint:\n%s",
			command, candidateList(candidates))
	}
	defer terminal.Close()
	fmt.Fprintf(terminal, "Several SSH keys can sign:\n%s\nChoose a key [1-%d]: ", candidateList(candidates), len(candidates))
	line, err := bufio.NewReader(terminal).ReadString('\n')
	if err != nil && line == "" {
		return keyCandidate{}, fmt.Errorf("%s: read the key choice: %w", command, err)
	}
	var index int
	if _, err := fmt.Sscanf(strings.TrimSpace(line), "%d", &index); err != nil || index < 1 || index > len(candidates) {
		return keyCandidate{}, errors.New(command + ": no key chosen")
	}
	return candidates[index-1], nil
}
