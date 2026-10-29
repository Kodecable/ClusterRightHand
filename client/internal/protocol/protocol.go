// Package protocol implements the CBOR-CORE-INT-v1 wire format shared by crhs and crha
// (M3.5): handshake payloads, request/response/event frames, command and event bodies,
// and a Peer that multiplexes requests, responses and events over one ordered message
// stream. See doc/protocol.md for the authoritative schema and doc/execution-plane.md
// for the CBOR profile.
package protocol

import (
	"slices"

	"github.com/fxamacker/cbor/v2"
)

const (
	// ProtocolMajor and ProtocolMinor are the versions advertised in the handshake.
	ProtocolMajor = 1
	ProtocolMinor = 0
	// MaxFrameBytes bounds one encoded frame so that it fits a Noise transport message.
	MaxFrameBytes = 61440
	// MaxSafeInteger is the largest integer allowed by the protocol schema: 2^53-1.
	// The CBOR profile itself allows the full native uint64/int64 range.
	MaxSafeInteger = 1<<53 - 1
)

// Command names of protocol 1.0.
const (
	CmdHello      = "hello"
	CmdPing       = "ping"
	CmdTaskStart  = "task.start"
	CmdTaskInput  = "task.input"
	CmdTaskCancel = "task.cancel"
	CmdTaskQuery  = "task.query"
)

// Event names of protocol 1.0.
const (
	EventTaskOutput  = "task.output"
	EventTaskExit    = "task.exit"
	EventFacts       = "facts"
	EventNodeStatus  = "node.status"
	EventOutputAck   = "task.output.ack"
	EventTaskExitAck = "task.exit.ack"
)

// commandNames and eventNames are the names implemented by this package. M4-reserved
// names (trust.query, revocations.set, trust.summary) are deliberately absent: 1.0 does
// not declare or implement them.
var (
	commandNames = []string{
		CmdHello,
		CmdPing,
		CmdTaskStart,
		CmdTaskInput,
		CmdTaskCancel,
		CmdTaskQuery,
	}
	eventNames = []string{
		EventTaskOutput,
		EventTaskExit,
		EventFacts,
		EventNodeStatus,
		EventOutputAck,
		EventTaskExitAck,
	}
)

// commandSchema names the request and response body types of one command. The Peer uses
// commandSchemas to decode and validate a body independent of whether the command was
// negotiated or has a handler, as doc/protocol.md requires.
type commandSchema struct {
	request  func() any
	response func() any
}

// commandSchemas covers every command this package knows. A name outside it is completely
// unknown and its body must not be decoded.
var commandSchemas = map[string]commandSchema{
	CmdHello: {
		request:  func() any { return new(Hello) },
		response: func() any { return new(Welcome) },
	},
	CmdPing: {
		request:  func() any { return new(Ping) },
		response: func() any { return new(Ping) },
	},
	CmdTaskStart: {
		request:  func() any { return new(TaskStart) },
		response: func() any { return new(Empty) },
	},
	CmdTaskInput: {
		request:  func() any { return new(TaskInput) },
		response: func() any { return new(Empty) },
	},
	CmdTaskCancel: {
		request:  func() any { return new(TaskCancel) },
		response: func() any { return new(Empty) },
	},
	CmdTaskQuery: {
		request:  func() any { return new(TaskQuery) },
		response: func() any { return new(TaskStatus) },
	},
}

// validateRequest decodes raw as the command's request body.
func (s commandSchema) validateRequest(raw cbor.RawMessage) error {
	return Unmarshal(raw, s.request())
}

// validateResponse decodes raw as the command's success response body.
func (s commandSchema) validateResponse(raw cbor.RawMessage) error {
	return Unmarshal(raw, s.response())
}

// SupportedCommands returns the command names implemented by this package.
func SupportedCommands() []string { return slices.Clone(commandNames) }

// SupportedEvents returns the event names implemented by this package.
func SupportedEvents() []string { return slices.Clone(eventNames) }

// SupportedNames returns every command and event name, sorted. This is the list to put
// in a handshake's commands field.
func SupportedNames() []string {
	names := append(SupportedCommands(), SupportedEvents()...)
	slices.Sort(names)
	return names
}

// SupportedSet returns SupportedNames as a Set.
func SupportedSet() Set { return NewSet(SupportedNames()...) }

// Set is a set of command and event names. The handshake intersects the two peers' sets;
// only names in the intersection may be sent.
type Set map[string]bool

// NewSet returns a Set containing names.
func NewSet(names ...string) Set {
	s := make(Set, len(names))
	for _, name := range names {
		s[name] = true
	}
	return s
}

// Has reports whether name is in the set.
func (s Set) Has(name string) bool { return s[name] }

// Add inserts name into the set.
func (s Set) Add(name string) { s[name] = true }

// Clone returns an independent copy of the set.
func (s Set) Clone() Set {
	if s == nil {
		return nil
	}
	out := make(Set, len(s))
	for name := range s {
		out[name] = true
	}
	return out
}

// Names returns the names in sorted order.
func (s Set) Names() []string {
	out := make([]string, 0, len(s))
	for name := range s {
		out = append(out, name)
	}
	slices.Sort(out)
	return out
}

// Intersect returns the names present in both sets.
func (s Set) Intersect(other Set) Set {
	out := make(Set)
	for name := range s {
		if other.Has(name) {
			out[name] = true
		}
	}
	return out
}
