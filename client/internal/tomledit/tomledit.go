// Package tomledit changes a TOML document in place with go-toml's comment-preserving editor
// (doc/design/distribution.md "Configuration migrations"): what an edit does not name stays as it was,
// byte for byte, comments and order included. After every edit both versions of the document are
// decoded, and they must differ by exactly that edit, so a defect of the editor stops the caller
// instead of being written. crha enroll's switches and the self-upgrade's migrations both go through it.
package tomledit

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

// Edit is one change to a configuration document. Path addresses a value as edit.Document does: one
// element per key part, and a decimal index into an array or an array of tables.
type Edit struct {
	Op   Op
	Path []string
	// Value is the new value of a set, rendered as go-toml renders it.
	Value any
	// To is the new last key of a rename.
	To string
	// Tables is the TOML text of the arrays of tables that replace Path, as `[[name]]` sections; empty
	// removes them.
	Tables string
}

// Op is what an Edit does.
type Op int

const (
	// Set sets Path to Value, adding the key when it is missing.
	Set Op = iota
	// Delete removes Path with its comments; a missing key is not an error.
	Delete
	// Rename moves Path's value and comments to the key To in the same table.
	Rename
	// ReplaceTables removes the array of tables at the top-level key Path and appends Tables in its
	// place at the end of the document; everything else stays as it was.
	ReplaceTables
)

func (e Edit) String() string {
	path := strings.Join(e.Path, ".")
	switch e.Op {
	case Set:
		return fmt.Sprintf("set %s = %v", path, e.Value)
	case Delete:
		return "delete " + path
	case ReplaceTables:
		return "replace the [[" + path + "]] tables"
	default:
		return fmt.Sprintf("rename %s to %s", path, e.To)
	}
}

// Apply applies edits to data in order and returns the result and the edits that changed something.
// An edit that changes nothing (a missing key deleted, a value set to what it is) is not returned.
func Apply(data []byte, edits []Edit) ([]byte, []Edit, error) {
	var done []Edit
	for _, e := range edits {
		out, changed, err := ApplyOne(data, e)
		if err != nil {
			return nil, nil, fmt.Errorf("%s: %w", e, err)
		}
		if changed {
			data, done = out, append(done, e)
		}
	}
	return data, done, nil
}

// ApplyOne applies one edit and checks that the document changed by exactly that edit.
func ApplyOne(data []byte, e Edit) ([]byte, bool, error) {
	doc, err := edit.Parse(data)
	if err != nil {
		return nil, false, err
	}
	var out []byte
	if e.Op == ReplaceTables {
		if len(e.Path) != 1 {
			return nil, false, errors.New("replacing tables needs one top-level key")
		}
		doc.Delete(e.Path)
		out = []byte(strings.TrimRight(string(doc.Bytes()), "\n") + "\n")
		if tables := strings.TrimSpace(e.Tables); tables != "" {
			out = append(out, "\n"+tables+"\n"...)
		}
	} else {
		changed, err := applyEdit(doc, e)
		if err != nil || !changed {
			return data, false, err
		}
		out = doc.Bytes()
	}
	if string(out) == string(data) {
		return data, false, nil
	}
	if err := checkEdit(data, out, e); err != nil {
		return nil, false, err
	}
	// A value set to what it was is no change, whatever bytes the editor wrote.
	if e.Op == Set {
		var before, after map[string]any
		if toml.Unmarshal(data, &before) == nil && toml.Unmarshal(out, &after) == nil && reflect.DeepEqual(before, after) {
			return data, false, nil
		}
	}
	return out, true, nil
}

// applyEdit applies one edit; it reports false when the edit had nothing to do.
func applyEdit(doc *edit.Document, e Edit) (bool, error) {
	switch e.Op {
	case Set:
		return true, doc.Set(e.Path, e.Value)
	case Delete:
		return doc.Delete(e.Path), nil
	case Rename:
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
	case Set:
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
	case Delete:
		if err := deletePath(want, e.Path); err != nil {
			return err
		}
	case ReplaceTables:
		if err := deletePath(want, e.Path); err != nil {
			return err
		}
		if strings.TrimSpace(e.Tables) != "" {
			var tables map[string]any
			if err := toml.Unmarshal([]byte(e.Tables), &tables); err != nil {
				return fmt.Errorf("the new tables: %w", err)
			}
			if len(tables) != 1 || tables[e.Path[0]] == nil {
				return fmt.Errorf("the new tables are not only [[%s]]", e.Path[0])
			}
			want[e.Path[0]] = tables[e.Path[0]]
		}
	case Rename:
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
