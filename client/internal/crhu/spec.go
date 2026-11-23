package crhu

import (
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"os"
	"strconv"
	"strings"

	"github.com/Kodecable/ClusterRightHand/client/internal/privileged/authz"
	"github.com/Kodecable/ClusterRightHand/client/internal/protocol"
)

// specStdin is the --spec value that reads the spec from standard input. A large spec exceeds the
// argument size limit, so the WebUI renders a heredoc for it.
const specStdin = "-"

// readSpec decodes --spec: standard base64 of the canonical CBOR TaskSpec that SpecSHA256 hashes,
// or "-" for standard input. The strict decoder also refuses a non-canonical encoding, so the hash
// recomputed here is over the same bytes crhs hashed.
func readSpec(value string, stdin io.Reader) (*protocol.TaskSpec, error) {
	encoded := value
	if value == specStdin {
		data, err := io.ReadAll(stdin)
		if err != nil {
			return nil, fmt.Errorf("--spec: read standard input: %w", err)
		}
		encoded = string(data)
	}
	raw, err := base64.StdEncoding.DecodeString(strings.TrimSpace(encoded))
	if err != nil {
		return nil, fmt.Errorf("--spec is not standard base64: %w", err)
	}
	var spec protocol.TaskSpec
	if err := protocol.Unmarshal(raw, &spec); err != nil {
		return nil, fmt.Errorf("--spec: %w", err)
	}
	return &spec, nil
}

// inputRefView is the human-readable form of an InputRef: the size and SHA-256 the node verifies
// the input against.
type inputRefView struct {
	Size   uint64 `json:"size"`
	SHA256 string `json:"sha256"`
}

// endpointView names the crhs-side end of a file transfer. Its transfer id is routing and is not
// part of the spec hash, so the same authorization covers every member of a copy task group.
type endpointView struct {
	Kind       string `json:"kind"`
	TransferID string `json:"transfer_id"`
}

// editView is one old-text/new-text replacement of a file.edit spec.
type editView struct {
	OldText string `json:"old_text"`
	NewText string `json:"new_text"`
}

// specView is the human-readable form of a task spec: every field of its kind, plus the method and
// target the node renders with the same function it uses for guard rules, and the hash a `spec`
// command binds.
type specView struct {
	Kind       string `json:"kind"`
	Method     string `json:"method"`
	Target     string `json:"target"`
	SpecSHA256 string `json:"spec_sha256"`

	// exec, pty.create
	Argv  []string `json:"argv,omitempty"`
	Shell string   `json:"shell,omitempty"`

	// pty.create: true when the argv is empty, so the terminal runs the privileged identity's login
	// shell. It is shown instead of an empty argv.
	LoginShell bool `json:"login_shell,omitempty"`

	Env   map[string]string `json:"env,omitempty"`
	Cwd   string            `json:"cwd,omitempty"`
	Stdin *inputRefView     `json:"stdin,omitempty"`

	// file.read, file.stat, file.list
	Path      string  `json:"path,omitempty"`
	StartLine *uint64 `json:"start_line,omitempty"`
	LineCount *uint64 `json:"line_count,omitempty"`
	Limit     *uint64 `json:"limit,omitempty"`

	// file.write, file.push
	Content          *inputRefView `json:"content,omitempty"`
	Overwrite        *bool         `json:"overwrite,omitempty"`
	Mode             *string       `json:"mode,omitempty"`
	Owner            *string       `json:"owner,omitempty"`
	Group            *string       `json:"group,omitempty"`
	CreateParentDirs *bool         `json:"create_parent_dirs,omitempty"`

	// node.upgrade
	Version string `json:"version,omitempty"`
	Arch    string `json:"arch,omitempty"`

	// file.push, file.pull, node.upgrade
	Size     *uint64       `json:"size,omitempty"`
	SHA256   string        `json:"sha256,omitempty"`
	MaxBytes *uint64       `json:"max_bytes,omitempty"`
	Endpoint *endpointView `json:"endpoint,omitempty"`

	// file.edit
	Edits []editView `json:"edits,omitempty"`
}

// specViewFor renders a spec for confirmation. It uses authz.Target, the node's own rendering, so
// the shown method and target are exactly what guard rules and prefix authorizations match.
func specViewFor(spec *protocol.TaskSpec) (*specView, error) {
	method, target, err := authz.Target(spec)
	if err != nil {
		return nil, err
	}
	hash, err := protocol.SpecSHA256(spec)
	if err != nil {
		return nil, err
	}
	view := &specView{
		Kind:       string(spec.Kind),
		Method:     method,
		Target:     target,
		SpecSHA256: hex.EncodeToString(hash[:]),
	}
	switch spec.Kind {
	case protocol.TaskSpecExec:
		if spec.Exec == nil {
			return nil, errors.New("exec spec has no body")
		}
		switch spec.Exec.Command.Kind {
		case protocol.CommandArgv:
			view.Argv = append([]string{}, spec.Exec.Command.Argv...)
		case protocol.CommandShell:
			view.Shell = spec.Exec.Command.Shell
		}
		view.Env = spec.Exec.Env
		view.Cwd = spec.Exec.Cwd
		if spec.Exec.Stdin != nil {
			view.Stdin = inputRefViewOf(*spec.Exec.Stdin)
		}
	case protocol.TaskSpecFileRead:
		if spec.FileRead == nil {
			return nil, errors.New("file.read spec has no body")
		}
		start, count := uint64(spec.FileRead.StartLine), uint64(spec.FileRead.LineCount)
		view.Path, view.StartLine, view.LineCount = spec.FileRead.Path, &start, &count
	case protocol.TaskSpecFileStat:
		if spec.FileStat == nil {
			return nil, errors.New("file.stat spec has no body")
		}
		view.Path = spec.FileStat.Path
	case protocol.TaskSpecFileList:
		if spec.FileList == nil {
			return nil, errors.New("file.list spec has no body")
		}
		limit := uint64(spec.FileList.Limit)
		view.Path, view.Limit = spec.FileList.Path, &limit
	case protocol.TaskSpecFileWrite:
		if spec.FileWrite == nil {
			return nil, errors.New("file.write spec has no body")
		}
		view.Path = spec.FileWrite.Path
		view.Content = inputRefViewOf(spec.FileWrite.Content)
		setFileWriteFields(view, spec.FileWrite.Overwrite, spec.FileWrite.Mode,
			spec.FileWrite.Owner, spec.FileWrite.Group, spec.FileWrite.CreateParentDirs)
	case protocol.TaskSpecFilePush:
		if spec.FilePush == nil {
			return nil, errors.New("file.push spec has no body")
		}
		size := uint64(spec.FilePush.Size)
		view.Path, view.Size, view.SHA256 = spec.FilePush.Path, &size, hexHash(spec.FilePush.SHA256)
		setFileWriteFields(view, spec.FilePush.Overwrite, spec.FilePush.Mode,
			spec.FilePush.Owner, spec.FilePush.Group, spec.FilePush.CreateParentDirs)
		view.Endpoint = &endpointView{Kind: string(spec.FilePush.Endpoint.Kind), TransferID: spec.FilePush.Endpoint.TransferID}
	case protocol.TaskSpecFilePull:
		if spec.FilePull == nil {
			return nil, errors.New("file.pull spec has no body")
		}
		maxBytes := uint64(spec.FilePull.MaxBytes)
		view.Path, view.MaxBytes = spec.FilePull.Path, &maxBytes
		view.Endpoint = &endpointView{Kind: string(spec.FilePull.Endpoint.Kind), TransferID: spec.FilePull.Endpoint.TransferID}
	case protocol.TaskSpecFileEdit:
		if spec.FileEdit == nil {
			return nil, errors.New("file.edit spec has no body")
		}
		view.Path = spec.FileEdit.Path
		for _, edit := range spec.FileEdit.Edits {
			view.Edits = append(view.Edits, editView{OldText: edit.OldText, NewText: edit.NewText})
		}
	case protocol.TaskSpecPtyCreate:
		if spec.PtyCreate == nil {
			return nil, errors.New("pty.create spec has no body")
		}
		// An empty argv is the privileged identity's login shell, shown as such instead of an empty
		// argv (doc/design/pty.md "Privilege").
		if len(spec.PtyCreate.Argv) == 0 {
			view.LoginShell = true
		} else {
			view.Argv = append([]string{}, spec.PtyCreate.Argv...)
		}
	case protocol.TaskSpecNodeUpgrade:
		if spec.NodeUpgrade == nil {
			return nil, errors.New("node.upgrade spec has no body")
		}
		u := spec.NodeUpgrade
		size := uint64(u.Size)
		view.Version, view.Arch, view.Size, view.SHA256 = u.Version, u.Arch, &size, hexHash(u.SHA256)
		view.Endpoint = &endpointView{Kind: string(u.Endpoint.Kind), TransferID: u.Endpoint.TransferID}
	default:
		return nil, fmt.Errorf("unknown task spec kind %q", string(spec.Kind))
	}
	return view, nil
}

// setFileWriteFields fills the fields file.write and file.push share.
func setFileWriteFields(view *specView, overwrite bool, mode protocol.Uint, owner, group string, createParents bool) {
	octal := strconv.FormatUint(uint64(mode), 8)
	for len(octal) < 4 {
		octal = "0" + octal
	}
	view.Overwrite, view.Mode = &overwrite, &octal
	view.Owner, view.Group, view.CreateParentDirs = &owner, &group, &createParents
}

// inputRefViewOf renders an InputRef.
func inputRefViewOf(ref protocol.InputRef) *inputRefView {
	return &inputRefView{Size: uint64(ref.Size), SHA256: hexHash(ref.SHA256)}
}

// hexHash renders a hash as lowercase hex.
func hexHash(hash protocol.Hash) string { return hex.EncodeToString(hash[:]) }

// inputRefOf returns the spec's input reference and what it is called, or nil when the spec takes
// no input of its own (file.pull reads the node, a transfer's bytes arrive over the data
// connection).
func inputRefOf(spec *protocol.TaskSpec) (*protocol.InputRef, string) {
	switch spec.Kind {
	case protocol.TaskSpecExec:
		if spec.Exec != nil && spec.Exec.Stdin != nil {
			return spec.Exec.Stdin, "stdin"
		}
	case protocol.TaskSpecFileWrite:
		if spec.FileWrite != nil {
			return &spec.FileWrite.Content, "content"
		}
	case protocol.TaskSpecFilePush:
		if spec.FilePush != nil {
			return &protocol.InputRef{Size: spec.FilePush.Size, SHA256: spec.FilePush.SHA256}, "transfer"
		}
	case protocol.TaskSpecNodeUpgrade:
		// The crha binary of the release: --content checks it against crha-<v>-linux-<arch>/crha.
		if spec.NodeUpgrade != nil {
			return &protocol.InputRef{Size: spec.NodeUpgrade.Size, SHA256: spec.NodeUpgrade.SHA256}, "transfer"
		}
	}
	return nil, ""
}

// checkContents hashes every --content file and matches it against the spec's input reference.
// Each line it returns is shown with the confirmation; a mismatch is refused, because the node
// would write or run bytes the user did not check.
func checkContents(spec *protocol.TaskSpec, paths []string) ([]string, error) {
	if len(paths) == 0 {
		return nil, nil
	}
	ref, where := inputRefOf(spec)
	if ref == nil {
		return nil, errors.New("--content: the spec takes no input (stdin, content or transfer) to match")
	}
	wantHash := hexHash(ref.SHA256)
	lines := make([]string, 0, len(paths))
	for _, path := range paths {
		info, err := os.Stat(path)
		if err != nil {
			return nil, fmt.Errorf("--content %s: %w", path, err)
		}
		if !info.Mode().IsRegular() {
			return nil, fmt.Errorf("--content %s: not a regular file", path)
		}
		data, err := os.ReadFile(path)
		if err != nil {
			return nil, fmt.Errorf("--content %s: %w", path, err)
		}
		hash := sha256.Sum256(data)
		if uint64(len(data)) != uint64(ref.Size) || protocol.Hash(hash) != ref.SHA256 {
			return nil, fmt.Errorf("--content %s does not match the spec's %s: the file is %d bytes with sha256 %s, the spec binds %d bytes with sha256 %s",
				path, where, len(data), hex.EncodeToString(hash[:]), uint64(ref.Size), wantHash)
		}
		lines = append(lines, fmt.Sprintf("--content %s matches the spec's %s (size %d, sha256 %s)",
			path, where, len(data), hex.EncodeToString(hash[:])))
	}
	return lines, nil
}
