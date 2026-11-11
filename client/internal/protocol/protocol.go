// Package protocol implements the CBOR-CORE-INT-v1 wire format shared by crhs and crha:
// handshake payloads, request/response/event frames, command and event bodies,
// and a Peer that multiplexes requests, responses and events over one ordered message
// stream. See doc/design/protocol.md for the authoritative schema and its "Encoding rules" for the
// CBOR profile.
package protocol

import (
	"regexp"
	"slices"

	"github.com/fxamacker/cbor/v2"
)

// uuidRe matches the canonical lowercase UUID textual form crhs uses for node ids and node groups.
var uuidRe = regexp.MustCompile(`^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$`)

const (
	// ProtocolMajor and ProtocolMinor are the versions advertised in the handshake. An
	// incompatible change bumps the major version and the Noise prologue, so a peer with another
	// major fails the handshake itself (doc/design/protocol.md "Handshake payloads"). The minor version is
	// additive: new commands and events are negotiated through the handshake's commands field.
	ProtocolMajor = 0
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

// IsUUID reports whether s is a canonical lowercase UUID, the textual form of node ids and node
// group ids (doc/design/protocol.md "Authorization object").
func IsUUID(s string) bool {
	return uuidRe.MatchString(s)
}

// Command names.
const (
	CmdHello      = "hello"
	CmdPing       = "ping"
	CmdTaskStart  = "task.start"
	CmdTaskInput  = "task.input"
	CmdTaskCancel = "task.cancel"
	CmdTaskQuery  = "task.query"
)

// Event names.
const (
	EventTaskOutput  = "task.output"
	EventTaskExit    = "task.exit"
	EventFacts       = "facts"
	EventNodeStatus  = "node.status"
	EventOutputAck   = "task.output.ack"
	EventTaskExitAck = "task.exit.ack"
)

// Privilege command and event names (doc/design/protocol.md "Privilege messages").
const (
	CmdLocalRequest    = "local.request"
	CmdLocalWithdraw   = "local.withdraw"
	EventTrustSummary  = "trust.summary"
	EventLocalDecision = "local.decision"
)

// commandNames and eventNames are every command and event name: the set every peer must
// implement and therefore the set a handshake requires.
var (
	commandNames = []string{
		CmdHello,
		CmdPing,
		CmdTaskStart,
		CmdTaskInput,
		CmdTaskCancel,
		CmdTaskQuery,
		CmdLocalRequest,
		CmdLocalWithdraw,
	}
	eventNames = []string{
		EventTaskOutput,
		EventTaskExit,
		EventFacts,
		EventNodeStatus,
		EventOutputAck,
		EventTaskExitAck,
		EventTrustSummary,
		EventLocalDecision,
	}
)

// commandSchema names the request and response body types of one command. The Peer uses
// commandSchemas to decode and validate a body independent of whether the command was
// negotiated or has a handler, as doc/design/protocol.md requires.
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

// RequiredNames returns every command and event name, sorted. It is the list to put in a
// handshake's commands field; a handshake whose intersection lacks one is rejected
// (doc/design/protocol.md "Handshake payloads").
func RequiredNames() []string {
	names := append(slices.Clone(commandNames), eventNames...)
	slices.Sort(names)
	return names
}

// RequiredSet returns RequiredNames as a Set.
func RequiredSet() Set { return NewSet(RequiredNames()...) }

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
