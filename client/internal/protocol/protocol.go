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
	// Protocol 1.1 adds the M4 privilege commands and events; they are optional in the
	// handshake, so a 1.0 peer still connects (doc/protocol.md, M4：提权).
	ProtocolMajor = 1
	ProtocolMinor = 1
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

// Command and event names added in protocol 1.1 (M4, doc/protocol.md#m4提权). They are
// optional in the handshake: a 1.0 peer that does not offer them still connects.
const (
	CmdRevocationsAdd  = "revocations.add"
	CmdLocalRequest    = "local.request"
	CmdLocalWithdraw   = "local.withdraw"
	EventTrustSummary  = "trust.summary"
	EventLocalDecision = "local.decision"
)

// commandNames and eventNames are the protocol 1.0 names: the required set, and (until
// forward mode implements the 1.1 commands) the set crha advertises in its handshake.
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

// optionalCommandNames and optionalEventNames are the protocol 1.1 names this package
// knows the bodies of. They are not advertised yet: only the M4 forward implementation
// sends and handles them.
var (
	optionalCommandNames = []string{
		CmdRevocationsAdd,
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
	CmdRevocationsAdd: {
		request:  func() any { return new(RevocationsAdd) },
		response: func() any { return new(Empty) },
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

// validateRequest decodes raw as the command's request body.
func (s commandSchema) validateRequest(raw cbor.RawMessage) error {
	return Unmarshal(raw, s.request())
}

// validateResponse decodes raw as the command's success response body.
func (s commandSchema) validateResponse(raw cbor.RawMessage) error {
	return Unmarshal(raw, s.response())
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
	return Unmarshal(raw, newBody())
}

// SupportedCommands returns the command names this package advertises in a handshake.
func SupportedCommands() []string { return slices.Clone(commandNames) }

// SupportedEvents returns the event names this package advertises in a handshake.
func SupportedEvents() []string { return slices.Clone(eventNames) }

// SupportedNames returns every advertised command and event name, sorted. This is the
// list to put in a handshake's commands field; the protocol 1.1 names are not in it yet,
// because crha does not implement their forward side.
func SupportedNames() []string {
	names := append(SupportedCommands(), SupportedEvents()...)
	slices.Sort(names)
	return names
}

// SupportedSet returns SupportedNames as a Set.
func SupportedSet() Set { return NewSet(SupportedNames()...) }

// RequiredNames returns the protocol 1.0 command and event names, sorted. A handshake
// whose negotiated intersection lacks one of them is rejected (doc/protocol.md, 握手载荷).
func RequiredNames() []string {
	names := append(slices.Clone(commandNames), eventNames...)
	slices.Sort(names)
	return names
}

// OptionalNames returns the protocol 1.1 command and event names, sorted. They are
// optional in the handshake: a 1.0 peer that does not implement them still connects.
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
