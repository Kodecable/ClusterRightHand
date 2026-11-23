package pty

import "github.com/Kodecable/crosspty"

// Backend is the process side of one terminal: the operations the manager sends to the process.
// Output and the exit code come from a local crosspty process or, for a relayed terminal, from the
// privileged side's events, which reach the terminal through Feed and End rather than through a
// reader (doc/design/pty.md "Privilege"). There are two backends: the local crosspty process crha
// starts itself, and a relay that forwards input, resize and close to the privileged mode's daemon.
type Backend interface {
	// Write sends input to the process.
	Write(p []byte) (int, error)
	// Resize changes the terminal's size.
	Resize(rows, cols uint16) error
	// Close ends the terminal's process group. It is idempotent and may be called after the
	// process ended.
	Close() error
}

// localBackend is a crosspty process started by this crha process.
type localBackend struct{ proc crosspty.Pty }

func (b localBackend) Write(p []byte) (int, error) { return b.proc.Write(p) }

func (b localBackend) Resize(rows, cols uint16) error {
	return b.proc.Resize(crosspty.TermSize{Rows: rows, Cols: cols})
}

func (b localBackend) Close() error { return b.proc.Close() }
