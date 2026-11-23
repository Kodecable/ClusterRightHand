package wire

import "github.com/Kodecable/ClusterRightHand/client/internal/protocol"

// The optional crh-priv terminal names (doc/design/pty.md "Protocol additions"): a privileged
// terminal runs in the privileged mode, which relays its bytes to the unprivileged mode. Their
// bodies are not the crhs <-> crha ones: pty.open carries the authorization and no metadata or
// scrollback, and pty.exited carries no reason (the unprivileged mode decides whether the terminal
// ended or lost its privileged mode). Like every optional crh-priv name they are negotiated by
// intersection; they are not advertised yet, because there is no runtime.
const (
	CmdPTYOpen     = "pty.open"
	CmdPTYInput    = "pty.input"
	CmdPTYResize   = "pty.resize"
	CmdPTYClose    = "pty.close"
	EventPTYOutput = "pty.output"
	EventPTYExited = "pty.exited"
)

// PrivPTYOpen is the crh-priv pty.open request body: the terminal id, the argv (empty for the
// privileged identity's login shell), the size to start with and the authorization, exactly as
// task.start carries it. The terminal's size changes with pty.resize and its metadata stays crhs's.
type PrivPTYOpen struct {
	_              struct{} `cbor:",toarray"`
	PTYID          string
	Argv           []string
	Rows           protocol.Uint
	Cols           protocol.Uint
	Attempt        protocol.Uint
	Authorizations [][]byte
	Cosign         *[]byte
}

// PrivPTYInput is the crh-priv pty.input request body: the bytes a person or agent typed.
type PrivPTYInput struct {
	_     struct{} `cbor:",toarray"`
	PTYID string
	Data  []byte
}

// PrivPTYResize is the crh-priv pty.resize request body: the terminal's new size.
type PrivPTYResize struct {
	_     struct{} `cbor:",toarray"`
	PTYID string
	Rows  protocol.Uint
	Cols  protocol.Uint
}

// PrivPTYClose is the crh-priv pty.close request body: the terminal to close.
type PrivPTYClose struct {
	_     struct{} `cbor:",toarray"`
	PTYID string
}

// PrivPTYOutput is the crh-priv pty.output event body: the bytes the process wrote.
type PrivPTYOutput struct {
	_     struct{} `cbor:",toarray"`
	PTYID string
	Data  []byte
}

// PrivPTYExited is the crh-priv pty.exited event body: the exit code is signed, so a killed process
// can report -1. It has no reason; the unprivileged mode reports the crhs-facing pty.exited.
type PrivPTYExited struct {
	_        struct{} `cbor:",toarray"`
	PTYID    string
	ExitCode protocol.Int
}
