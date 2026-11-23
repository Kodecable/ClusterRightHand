// Package protocol implements the CBOR-CORE-INT-v1 wire format shared by crhs and crha:
// handshake payloads, request/response/event frames, command and event bodies,
// and a Peer that multiplexes requests, responses and events over one ordered message
// stream. See doc/design/protocol.md for the authoritative schema and its "Encoding rules" for the
// CBOR profile.
package protocol

import (
	"regexp"
	"slices"
	"time"

	"github.com/fxamacker/cbor/v2"
)

// uuidRe matches the canonical lowercase UUID textual form crhs uses for node ids and node groups.
var uuidRe = regexp.MustCompile(`^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$`)

const (
	// ProtocolMajor and ProtocolMinor are the versions advertised in the handshake. An
	// incompatible change bumps the major version and the Noise prologue, so a peer with another
	// major fails the handshake itself (doc/design/protocol.md "Version negotiation"). The minor
	// version is additive: new commands and events are negotiated through the handshake's commands
	// field, new task kinds through hello's task kinds, and methods, match kinds, roles and
	// capabilities are open names. Major 1 is the protocol of v0.4.0-rc.1, the first release under
	// the compatibility rules (doc/design/compatibility.md "Protocol"). Minor 1 adds the terminal
	// names as optional names (doc/design/pty.md "Protocol additions").
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
	// DataNoiseProloguePrefix starts the data connection's Noise prologue; it keeps a data handshake
	// from being taken for a control one, or the reverse (doc/design/protocol.md "Data connections").
	DataNoiseProloguePrefix = "crh-data/1"
	// PTYNoiseProloguePrefix starts a terminal data connection's Noise prologue, so a terminal
	// handshake can never be taken for a transfer's, or the reverse (doc/design/pty.md "crha").
	PTYNoiseProloguePrefix = "crh-pty/1"
	// SubprotocolPrefix starts the WebSocket subprotocol in which crha names its major
	// (doc/design/protocol.md "The major in the clear").
	SubprotocolPrefix = "crh."
	// DataChunkBytes is the largest chunk of a data connection frame (doc/design/protocol.md
	// "Data connections").
	DataChunkBytes = 32 << 10
	// DataIdleTimeout fails a data connection transfer that delivers no frame for this long.
	DataIdleTimeout = 90 * time.Second
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
	// CmdPTYOpen, CmdPTYResize and CmdPTYClose are optional: crhs offers them while a node offers
	// only those it implements (doc/design/pty.md "Protocol additions").
	CmdPTYOpen   = "pty.open"
	CmdPTYResize = "pty.resize"
	CmdPTYClose  = "pty.close"
)

// Event names.
const (
	EventTaskOutput  = "task.output"
	EventTaskExit    = "task.exit"
	EventFacts       = "facts"
	EventNodeStatus  = "node.status"
	EventOutputAck   = "task.output.ack"
	EventTaskExitAck = "task.exit.ack"
	// EventPTYExited and EventPTYList are optional terminal events (doc/design/pty.md "Protocol additions").
	EventPTYExited = "pty.exited"
	EventPTYList   = "pty.list"
)

// Privilege event name (doc/design/protocol.md "Privilege messages"). crhs never queries the
// trust summary: crha pushes it after hello and on every change.
const (
	EventTrustSummary = "trust.summary"
)

// commandNames and eventNames are every required command and event name: the set every peer must
// implement and therefore the set a handshake requires.
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
		EventTrustSummary,
	}
)

// optionalCommandNames and optionalEventNames are the names a peer may offer in addition to the
// required ones. A sender uses one only when both sides offered it; the handshake intersects the
// sets (doc/design/protocol.md "Version negotiation").
var (
	optionalCommandNames = []string{
		CmdPTYOpen,
		CmdPTYResize,
		CmdPTYClose,
	}
	optionalEventNames = []string{
		EventPTYExited,
		EventPTYList,
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
	CmdPTYOpen: {
		request:  func() any { return new(PTYOpen) },
		response: func() any { return new(Empty) },
	},
	CmdPTYResize: {
		request:  func() any { return new(PTYResize) },
		response: func() any { return new(Empty) },
	},
	CmdPTYClose: {
		request:  func() any { return new(PTYClose) },
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
	EventTaskOutput:   func() any { return new(TaskOutput) },
	EventTaskExit:     func() any { return new(TaskExit) },
	EventFacts:        func() any { return new(Facts) },
	EventNodeStatus:   func() any { return new(NodeStatus) },
	EventOutputAck:    func() any { return new(OutputAck) },
	EventTaskExitAck:  func() any { return new(TaskExitAck) },
	EventTrustSummary: func() any { return new(TrustReport) },
	EventPTYExited:    func() any { return new(PTYExited) },
	EventPTYList:      func() any { return new(PTYList) },
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

// RequiredNames returns every required command and event name, sorted. It is the list a handshake
// must contain; a handshake whose intersection lacks one is rejected (doc/design/protocol.md
// "Version negotiation").
func RequiredNames() []string {
	names := append(slices.Clone(commandNames), eventNames...)
	slices.Sort(names)
	return names
}

// RequiredSet returns RequiredNames as a Set.
func RequiredSet() Set { return NewSet(RequiredNames()...) }

// OptionalNames returns every optional command and event name this implementation knows, sorted. It
// is the names a peer may offer in addition to the required ones, not a list of what a particular
// node implements.
func OptionalNames() []string {
	names := append(slices.Clone(optionalCommandNames), optionalEventNames...)
	slices.Sort(names)
	return names
}

// ImplementedOptionalNames returns the optional names crha implements and therefore offers in the
// handshake. crha speaks the six terminal names; a node that did not implement terminals must not
// list them, so this list is exactly what the non-privileged mode can serve.
func ImplementedOptionalNames() []string {
	return OptionalNames()
}

// OfferedNames returns the handshake's commands field: every required name plus every optional name
// crha implements, sorted. A peer missing a required name is refused, while an optional name is used
// only when both sides offer it (doc/design/protocol.md "Version negotiation").
func OfferedNames() []string {
	names := append(RequiredNames(), ImplementedOptionalNames()...)
	slices.Sort(names)
	return names
}

// OfferedSet returns OfferedNames as a Set.
func OfferedSet() Set { return NewSet(OfferedNames()...) }

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
