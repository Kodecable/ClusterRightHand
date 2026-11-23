package wire

import "github.com/Kodecable/ClusterRightHand/client/internal/protocol"

// The optional crh-priv terminal names (doc/design/pty.md "Privilege"): a privileged terminal runs
// in the privileged mode, which relays its bytes to the unprivileged mode. Only pty.input and
// pty.output are crh-priv's own: terminal bytes travel on the crhs <-> crha data connection, so the
// privileged side never sees them. The other four reuse the crhs <-> crha names and bodies exactly;
// the terminal's scrollback in pty.open belongs to the unprivileged mode, and the
// privileged side ignores it. Both the forward and the native role offer the names, negotiated by
// intersection like every optional crh-priv name: a helper from before privileged terminals simply
// lacks them.
const (
	CmdPTYOpen     = protocol.CmdPTYOpen
	CmdPTYInput    = "pty.input"
	CmdPTYResize   = protocol.CmdPTYResize
	CmdPTYClose    = protocol.CmdPTYClose
	EventPTYOutput = "pty.output"
	EventPTYExited = protocol.EventPTYExited
)

// PrivPTYInput is the crh-priv pty.input request body: the bytes a person or agent typed.
type PrivPTYInput struct {
	_     struct{} `cbor:",toarray"`
	PTYID string
	Data  []byte
}

// PrivPTYOutput is the crh-priv pty.output event body: the bytes the process wrote.
type PrivPTYOutput struct {
	_     struct{} `cbor:",toarray"`
	PTYID string
	Data  []byte
}
