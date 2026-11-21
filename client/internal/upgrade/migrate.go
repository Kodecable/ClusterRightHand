package upgrade

import (
	"errors"
	"fmt"
	"reflect"
	"strconv"
	"strings"

	toml "github.com/pelletier/go-toml/v2"
	"github.com/pelletier/go-toml/v2/unstable"
	"github.com/pelletier/go-toml/v2/unstable/edit"
)

// The configuration migrations of the self-upgrade (doc/design/distribution.md "On the node"). A
// migration is not a way of reading a file: it is a list of edits the new version applies to the
// document before its own, strict parser reads it. What a migration does not name stays as it was,
// byte for byte, comments and order included. Migrations make no promise about behavior: a release
// may change a default or drop a key, and its release notes say so. Their one requirement is that
// the new version can read the result without anyone's help.

// Edit is one change to a configuration document. Path addresses a value as edit.Document does: one
// element per key part, and a decimal index into an array or an array of tables.
type Edit struct {
	Op   EditOp
	Path []string
	// Value is the new value of a set, rendered as go-toml renders it.
	Value any
	// To is the new last key of a rename.
	To string
}

// EditOp is what an Edit does.
type EditOp int

const (
	// EditSet sets Path to Value, adding the key when it is missing.
	EditSet EditOp = iota
	// EditDelete removes Path with its comments; a missing key is not an error.
	EditDelete
	// EditRename moves Path's value and comments to the key To in the same table.
	EditRename
)

func (e Edit) String() string {
	path := strings.Join(e.Path, ".")
	switch e.Op {
	case EditSet:
		return fmt.Sprintf("set %s = %v", path, e.Value)
	case EditDelete:
		return "delete " + path
	default:
		return fmt.Sprintf("rename %s to %s", path, e.To)
	}
}

// Config files a migration edits.
const (
	FileCrha       = "crha.toml"
	FilePrivileged = "privileged.toml"
)

// Migration is the edits one version applies to one file of the versions before it.
type Migration struct {
	// Version is the first version that needs the edits: they run on an upgrade from an older version to
	// this one or a newer one.
	Version string
	File    string
	// Edits returns the edits for the document as it is; it may read it to decide.
	Edits func(doc *edit.Document) []Edit
}

// migrations is empty: no format has changed since self-upgrade exists.
var migrations []Migration

// migrateFile applies the migrations that an upgrade from `from` to `to` needs to one file. It returns
// the new content, unchanged bytes when nothing applies, and a description of each edit for the
// upgrade log.
func migrateFile(list []Migration, file, from, to string, data []byte) ([]byte, []string, error) {
	var applicable []Migration
	for _, m := range list {
		if m.File == file && compareVersions(from, m.Version) < 0 && compareVersions(m.Version, to) <= 0 {
			applicable = append(applicable, m)
		}
	}
	if len(applicable) == 0 {
		return data, nil, nil
	}
	doc, err := edit.Parse(data)
	if err != nil {
		return nil, nil, fmt.Errorf("%s: %w", file, err)
	}
	var done []string
	for _, m := range applicable {
		for _, e := range m.Edits(doc) {
			before := doc.Bytes()
			changed, err := applyEdit(doc, e)
			if err != nil {
				return nil, nil, fmt.Errorf("%s: migration to %s: %s: %w", file, m.Version, e, err)
			}
			if !changed {
				continue
			}
			// The edit must have changed exactly what it says: anything else is a defect of the edit,
			// and the upgrade stops rather than install it.
			if err := checkEdit(before, doc.Bytes(), e); err != nil {
				return nil, nil, fmt.Errorf("%s: migration to %s: %s: %w", file, m.Version, e, err)
			}
			done = append(done, fmt.Sprintf("%s: %s (from %s)", file, e, m.Version))
		}
	}
	return doc.Bytes(), done, nil
}

// applyEdit applies one edit; it reports false when the edit had nothing to do.
func applyEdit(doc *edit.Document, e Edit) (bool, error) {
	switch e.Op {
	case EditSet:
		return true, doc.Set(e.Path, e.Value)
	case EditDelete:
		return doc.Delete(e.Path), nil
	case EditRename:
		if len(e.Path) == 0 || e.To == "" {
			return false, errors.New("rename needs a path and a new key")
		}
		value, ok := doc.Get(e.Path)
		if !ok {
			return false, nil
		}
		target := append(append([]string(nil), e.Path[:len(e.Path)-1]...), e.To)
		if doc.Has(target) {
			return false, fmt.Errorf("%s already exists", strings.Join(target, "."))
		}
		raw, err := rawValue(value)
		if err != nil {
			return false, err
		}
		comment, _ := doc.Comment(e.Path)
		trailing, _ := doc.TrailingComment(e.Path)
		if err := doc.Set(target, raw); err != nil {
			return false, err
		}
		if comment != "" {
			if err := doc.SetComment(target, comment); err != nil {
				return false, err
			}
		}
		if trailing != "" {
			if err := doc.SetTrailingComment(target, trailing); err != nil {
				return false, err
			}
		}
		doc.Delete(e.Path)
		return true, nil
	default:
		return false, fmt.Errorf("unknown edit %d", e.Op)
	}
}

// rawValue renders a decoded value as TOML text, so a renamed key keeps its value as it was decoded.
func rawValue(v any) (unstable.RawMessage, error) {
	data, err := toml.Marshal(map[string]any{"v": v})
	if err != nil {
		return nil, err
	}
	text := strings.TrimSpace(string(data))
	text, ok := strings.CutPrefix(text, "v = ")
	if !ok {
		return nil, fmt.Errorf("cannot render %v inline", v)
	}
	return unstable.RawMessage(text), nil
}

// checkEdit decodes the document before and after an edit and checks that they differ by exactly the
// edit.
func checkEdit(before, after []byte, e Edit) error {
	var want, got map[string]any
	if err := toml.Unmarshal(before, &want); err != nil {
		return err
	}
	if err := toml.Unmarshal(after, &got); err != nil {
		return fmt.Errorf("the result is not valid TOML: %w", err)
	}
	switch e.Op {
	case EditSet:
		var single map[string]any
		raw, err := rawValueOf(e.Value)
		if err != nil {
			return err
		}
		if err := toml.Unmarshal([]byte("v = "+string(raw)), &single); err != nil {
			return err
		}
		if err := setPath(want, e.Path, single["v"]); err != nil {
			return err
		}
	case EditDelete:
		if err := deletePath(want, e.Path); err != nil {
			return err
		}
	case EditRename:
		value, err := getPath(want, e.Path)
		if err != nil {
			return err
		}
		if err := deletePath(want, e.Path); err != nil {
			return err
		}
		if err := setPath(want, append(append([]string(nil), e.Path[:len(e.Path)-1]...), e.To), value); err != nil {
			return err
		}
	}
	if !reflect.DeepEqual(want, got) {
		return errors.New("the document changed more than the edit")
	}
	return nil
}

func rawValueOf(v any) (unstable.RawMessage, error) {
	if raw, ok := v.(unstable.RawMessage); ok {
		return raw, nil
	}
	return rawValue(v)
}

// container returns the map or slice that holds the last element of path.
func container(root map[string]any, path []string, create bool) (any, error) {
	var cur any = root
	for i, part := range path[:len(path)-1] {
		switch c := cur.(type) {
		case map[string]any:
			next, ok := c[part]
			if !ok {
				if !create {
					return nil, fmt.Errorf("%s is missing", strings.Join(path[:i+1], "."))
				}
				next = map[string]any{}
				c[part] = next
			}
			cur = next
		case []any:
			n, err := strconv.Atoi(part)
			if err != nil || n < 0 || n >= len(c) {
				return nil, fmt.Errorf("%s is not an index", part)
			}
			cur = c[n]
		default:
			return nil, fmt.Errorf("%s is not a table", strings.Join(path[:i+1], "."))
		}
	}
	return cur, nil
}

func setPath(root map[string]any, path []string, v any) error {
	c, err := container(root, path, true)
	if err != nil {
		return err
	}
	last := path[len(path)-1]
	switch c := c.(type) {
	case map[string]any:
		c[last] = v
		return nil
	case []any:
		n, err := strconv.Atoi(last)
		if err != nil || n < 0 || n > len(c) {
			return fmt.Errorf("%s is not an index", last)
		}
		if n == len(c) {
			// Appending changes the slice header held by the parent: set it through the parent.
			parent, err := container(root, path[:len(path)-1], false)
			if err != nil {
				return err
			}
			grown := append(c, v)
			key := path[len(path)-2]
			switch p := parent.(type) {
			case map[string]any:
				p[key] = grown
			case []any:
				i, _ := strconv.Atoi(key)
				p[i] = grown
			}
			return nil
		}
		c[n] = v
		return nil
	}
	return errors.New("not a container")
}

func getPath(root map[string]any, path []string) (any, error) {
	c, err := container(root, path, false)
	if err != nil {
		return nil, err
	}
	last := path[len(path)-1]
	switch c := c.(type) {
	case map[string]any:
		v, ok := c[last]
		if !ok {
			return nil, fmt.Errorf("%s is missing", last)
		}
		return v, nil
	case []any:
		n, err := strconv.Atoi(last)
		if err != nil || n < 0 || n >= len(c) {
			return nil, fmt.Errorf("%s is not an index", last)
		}
		return c[n], nil
	}
	return nil, errors.New("not a container")
}

func deletePath(root map[string]any, path []string) error {
	c, err := container(root, path, false)
	if err != nil {
		return err
	}
	last := path[len(path)-1]
	switch c := c.(type) {
	case map[string]any:
		delete(c, last)
		return nil
	case []any:
		n, err := strconv.Atoi(last)
		if err != nil || n < 0 || n >= len(c) {
			return fmt.Errorf("%s is not an index", last)
		}
		parent, err := container(root, path[:len(path)-1], false)
		if err != nil {
			return err
		}
		shrunk := append(append([]any(nil), c[:n]...), c[n+1:]...)
		key := path[len(path)-2]
		switch p := parent.(type) {
		case map[string]any:
			p[key] = shrunk
		case []any:
			i, _ := strconv.Atoi(key)
			p[i] = shrunk
		}
		return nil
	}
	return errors.New("not a container")
}
