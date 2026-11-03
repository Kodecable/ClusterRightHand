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
	// ProtocolMajor and ProtocolMinor are the versions advertised in the handshake. An
	// incompatible change bumps the major version and the Noise prologue, so a peer with another
	// major fails the handshake itself (doc/protocol.md, 握手载荷). The minor version is
	// additive: new commands and events are negotiated through the handshake's commands field.
	// Protocol 2.0 reads files by line range and adds task.exit.result; 1.1 was the M4 command
	// set and 1.0 the M3.5 one.
	ProtocolMajor = 2
	ProtocolMinor = 0
	// MaxFrameBytes bounds one encoded frame so that it fits a Noise transport message.
	MaxFrameBytes = 61440
	// MaxSafeInteger is the largest integer allowed by the protocol schema: 2^53-1.
	// The CBOR profile itself allows the full native uint64/int64 range.
	MaxSafeInteger = 1<<53 - 1
	// MaxErrorMessageBytes bounds Error.message in UTF-8 bytes. The sender sanitises and
	// truncates it; the receiver does not check its length.
	MaxErrorMessageBytes = 1024
	// MaxNameBytes bounds a command or event name (cmd, name) in UTF-8 bytes.
	MaxNameBytes = 64
)

// Command names of the M3.5 command set.
const (
	CmdHello      = "hello"
	CmdPing       = "ping"
	CmdTaskStart  = "task.start"
	CmdTaskInput  = "task.input"
	CmdTaskCancel = "task.cancel"
	CmdTaskQuery  = "task.query"
)

// Event names of the M3.5 command set.
const (
	EventTaskOutput  = "task.output"
	EventTaskExit    = "task.exit"
	EventFacts       = "facts"
	EventNodeStatus  = "node.status"
	EventOutputAck   = "task.output.ack"
	EventTaskExitAck = "task.exit.ack"
)

// Command and event names added in M4 (doc/protocol.md#m4提权). They are optional in the
// handshake: a peer that does not offer them still connects.
const (
	CmdLocalRequest    = "local.request"
	CmdLocalWithdraw   = "local.withdraw"
	EventTrustSummary  = "trust.summary"
	EventLocalDecision = "local.decision"
)

// commandNames and eventNames are the M3.5 names: the set every peer must implement
// and therefore the required set of a handshake.
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

// optionalCommandNames and optionalEventNames are the M4 names this package
// knows the bodies of. crha advertises them in every privileged mode: non-forward modes
// answer the commands with privileged_unsupported and report not_forward instead of a
// trust summary (doc/protocol.md M4：提权).
var (
	optionalCommandNames = []string{
		CmdLocalRequest,
		CmdLocalWithdraw,
	}
	optionalEventNames = []string{
		EventTrustSummary,
		EventLocalDecision,
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
	CmdLocalRequest: {
		request:  func() any { return new(LocalRequest) },
		response: func() any { return new(LocalState) },
	},
	CmdLocalWithdraw: {
		request:  func() any { return new(LocalWithdraw) },
		response: func() any { return new(Empty) },
	},
}

// validateRequest decodes raw as the command's request body. The body was either encoded by Marshal
// (an outgoing request) or taken from a frame DecodeFrame validated, so only the schema decode is
// left (UnmarshalBody).
func (s commandSchema) validateRequest(raw cbor.RawMessage) error {
	return UnmarshalBody(raw, s.request())
}

// validateResponse decodes raw as the command's success response body, under the same rule.
func (s commandSchema) validateResponse(raw cbor.RawMessage) error {
	return UnmarshalBody(raw, s.response())
}

// eventSchemas names the body type of every event this package knows, so Emit can validate an
// outgoing body the same way a receiver validates a command body.
var eventSchemas = map[string]func() any{
	EventTaskOutput:    func() any { return new(TaskOutput) },
	EventTaskExit:      func() any { return new(TaskExit) },
	EventFacts:         func() any { return new(Facts) },
	EventNodeStatus:    func() any { return new(NodeStatus) },
	EventOutputAck:     func() any { return new(OutputAck) },
	EventTaskExitAck:   func() any { return new(TaskExitAck) },
	EventTrustSummary:  func() any { return new(TrustReport) },
	EventLocalDecision: func() any { return new(LocalDecision) },
}

// validateEventBody decodes raw as the named event's body. A name outside the schema is
// completely unknown and its body is not checked.
func validateEventBody(name string, raw cbor.RawMessage) error {
	newBody, ok := eventSchemas[name]
	if !ok {
		return nil
	}
	return UnmarshalBody(raw, newBody())
}

// SupportedCommands returns the command names this package advertises in a handshake,
// including the optional M4 commands.
func SupportedCommands() []string {
	return slices.Concat(commandNames, optionalCommandNames)
}

// SupportedEvents returns the event names this package advertises in a handshake, including
// the optional M4 events.
func SupportedEvents() []string {
	return slices.Concat(eventNames, optionalEventNames)
}

// SupportedNames returns every command and event name crha advertises in a handshake,
// sorted. It is the list to put in a handshake's commands field. The M4 names are optional
// for the peer: one that does not offer them still connects, and crha then only sends and
// answers the M3.5 names.
func SupportedNames() []string {
	names := slices.Concat(SupportedCommands(), SupportedEvents())
	slices.Sort(names)
	return names
}

// SupportedSet returns SupportedNames as a Set.
func SupportedSet() Set { return NewSet(SupportedNames()...) }

// RequiredNames returns the M3.5 command and event names, sorted. A handshake
// whose negotiated intersection lacks one of them is rejected (doc/protocol.md, 握手载荷).
func RequiredNames() []string {
	names := append(slices.Clone(commandNames), eventNames...)
	slices.Sort(names)
	return names
}

// OptionalNames returns the M4 command and event names, sorted. They are optional in the
// handshake: a peer that does not implement them still connects.
func OptionalNames() []string {
	names := append(slices.Clone(optionalCommandNames), optionalEventNames...)
	slices.Sort(names)
	return names
}

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
