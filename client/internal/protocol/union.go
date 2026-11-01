package protocol

import (
	"errors"
	"fmt"

	"github.com/fxamacker/cbor/v2"
)

// This file holds the two table-driven conventions of the wire schema: text enums and [tag, body]
// unions (doc/protocol.md). A type declares its values or branches once, in a table, and its
// MarshalCBOR and UnmarshalCBOR are one line each that calls the table. The tables are data, so a
// new branch or value is a row, not another copy of the decode and re-encode logic.

// enum is a validated text set: the values an enum may take and the name to report when a value is
// not one of them.
type enum[T ~string] struct {
	kind   string
	values []T
}

// newEnum defines an enum of the given values.
func newEnum[T ~string](kind string, values ...T) enum[T] {
	return enum[T]{kind: kind, values: values}
}

// valid reports whether v is one of the enum's values.
func (e enum[T]) valid(v T) bool {
	for _, want := range e.values {
		if v == want {
			return true
		}
	}
	return false
}

// marshal encodes v, rejecting a value outside the schema.
func (e enum[T]) marshal(v T) ([]byte, error) {
	if err := validateTextValue(string(v)); err != nil {
		return nil, err
	}
	if !e.valid(v) {
		return nil, fmt.Errorf("protocol: unknown %s %q", e.kind, string(v))
	}
	return encMode.Marshal(string(v))
}

// unmarshal decodes and validates one value.
func (e enum[T]) unmarshal(data []byte, dst *T) error {
	var s string
	if err := decMode.Unmarshal(data, &s); err != nil {
		return err
	}
	v := T(s)
	if !e.valid(v) {
		return fmt.Errorf("protocol: unknown %s %q", e.kind, s)
	}
	*dst = v
	return nil
}

// unionDef describes one tagged union: its name, its branches and the words its errors use.
type unionDef[T any] struct {
	// name names the union in the unknown-branch errors: "protocol: unknown task spec kind %q" and
	// "protocol: unknown task spec tag %q".
	name string
	// bodyName names the union in the "has no body" error; it is name unless the union's message is
	// worded differently (a task result says "protocol: file.read result has no body").
	bodyName string
	// kindSuffix is what the unknown-branch encode error adds after the name: " kind" for every
	// union but output mode and local state, whose messages read "unknown output mode" and "unknown
	// local state".
	kindSuffix string
	branches   []unionBranch[T]
}

// unionBranch is one branch of a tagged union: its tag, the body it encodes and how a decoded body
// fills the union.
type unionBranch[T any] struct {
	tag string
	// body returns the branch's body, or false when the branch is selected but has none.
	body func(v T) (any, bool)
	// decode stores a decoded body in the union's branch.
	decode func(v *T, body cbor.RawMessage) error
	// missing overrides the error of a branch that is selected without a body: "protocol: ok trust
	// report has no summary" is not the default wording.
	missing string
}

// newUnion defines the union name with its branches.
func newUnion[T any](name string, branches ...unionBranch[T]) unionDef[T] {
	return unionDef[T]{name: name, bodyName: name, kindSuffix: " kind", branches: branches}
}

// newBareUnion defines a union whose unknown-branch encode error says only "unknown <name> %q":
// output mode and local state are written that way.
func newBareUnion[T any](name string, branches ...unionBranch[T]) unionDef[T] {
	return unionDef[T]{name: name, bodyName: name, branches: branches}
}

// withMissing gives a branch a non-default error for a missing body.
func withMissing[T any](b unionBranch[T], message string) unionBranch[T] {
	b.missing = message
	return b
}

// marshal encodes the branch of tag as [tag, body].
func (d unionDef[T]) marshal(v T, tag string) ([]byte, error) {
	for _, b := range d.branches {
		if b.tag != tag {
			continue
		}
		body, ok := b.body(v)
		if !ok {
			if b.missing != "" {
				return nil, errors.New(b.missing)
			}
			return nil, fmt.Errorf("protocol: %s %s has no body", tag, d.bodyName)
		}
		return encodeUnion(tag, body)
	}
	return nil, fmt.Errorf("protocol: unknown %s%s %q", d.name, d.kindSuffix, tag)
}

// unmarshal decodes [tag, body] into the matching branch and returns the tag.
func (d unionDef[T]) unmarshal(data []byte, v *T) (string, error) {
	tag, body, err := decodeUnion(data)
	if err != nil {
		return "", err
	}
	for _, b := range d.branches {
		if b.tag != tag {
			continue
		}
		// The branch is decoded into a fresh value and stored only on success: a union has exactly
		// the fields of its selected branch, and a failed decode leaves the receiver untouched.
		var branch T
		if err := b.decode(&branch, body); err != nil {
			return "", err
		}
		*v = branch
		return tag, nil
	}
	return "", fmt.Errorf("protocol: unknown %s tag %q", d.name, tag)
}

// unionPtr is the branch of a union whose body is a pointer field: field returns the address of that
// field. A branch that is selected while its body is nil is an error.
func unionPtr[T, B any](tag string, field func(*T) **B) unionBranch[T] {
	return unionBranch[T]{
		tag: tag,
		body: func(v T) (any, bool) {
			if p := *field(&v); p != nil {
				return *p, true
			}
			return nil, false
		},
		decode: func(v *T, body cbor.RawMessage) error {
			var b B
			if err := decMode.Unmarshal(body, &b); err != nil {
				return err
			}
			*field(v) = &b
			return nil
		},
	}
}

// unionValue is the branch of a union whose body is a plain field: get reads it and set stores a
// decoded one.
func unionValue[T, B any](tag string, get func(T) B, set func(*T, B)) unionBranch[T] {
	return unionBranch[T]{
		tag:  tag,
		body: func(v T) (any, bool) { return get(v), true },
		decode: func(v *T, body cbor.RawMessage) error {
			var b B
			if err := decMode.Unmarshal(body, &b); err != nil {
				return err
			}
			set(v, b)
			return nil
		},
	}
}

// unionEmpty is the branch of a union whose body is the empty tuple. The body is still decoded, so a
// wrong arity is refused.
func unionEmpty[T any](tag string) unionBranch[T] {
	return unionBranch[T]{
		tag:  tag,
		body: func(T) (any, bool) { return Empty{}, true },
		decode: func(_ *T, body cbor.RawMessage) error {
			var empty Empty
			return decMode.Unmarshal(body, &empty)
		},
	}
}

// unionMessage is the branch of a union whose body is a message: the body carries get(v) and a
// decoded one is stored with set.
func unionMessage[T any](tag string, get func(T) string, set func(*T, string)) unionBranch[T] {
	return unionBranch[T]{
		tag:  tag,
		body: func(v T) (any, bool) { return messageBody{Message: get(v)}, true },
		decode: func(v *T, body cbor.RawMessage) error {
			var b messageBody
			if err := decMode.Unmarshal(body, &b); err != nil {
				return err
			}
			set(v, b.Message)
			return nil
		},
	}
}

// messageBody is the body of union branches that carry only a message.
type messageBody struct {
	_       struct{} `cbor:",toarray"`
	Message string
}
