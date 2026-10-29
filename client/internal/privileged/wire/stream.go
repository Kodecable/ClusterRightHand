package wire

import (
	"io"

	"github.com/Kodecable/ClusterRightHand/client/internal/protocol"
)

// Stream runs a protocol.Peer over one crh-priv stream: outgoing frames are length-prefixed and
// every incoming frame is read in turn and handed to Peer.Receive. It is the crh-priv counterpart
// of the Noise transport in client/internal/transport.
type Stream struct {
	r    io.Reader
	peer *protocol.Peer
}

// NewStream returns a Stream reading from r and writing to w, accepting only the negotiated command
// and event names. The caller owns r and w: closing them is not the Stream's job.
func NewStream(r io.Reader, w io.Writer, negotiated protocol.Set) *Stream {
	s := &Stream{r: r}
	s.peer = protocol.NewPeer(func(frame []byte) error { return WriteFrame(w, frame) }, negotiated)
	return s
}

// Peer returns the underlying protocol.Peer, for registering handlers and sending requests and
// events. Its send function writes length-prefixed frames.
func (s *Stream) Peer() *protocol.Peer { return s.peer }

// Receive reads one frame and processes it. It returns io.EOF when the peer closed the stream
// between frames.
func (s *Stream) Receive() error {
	frame, err := ReadFrame(s.r)
	if err != nil {
		return err
	}
	return s.peer.Receive(frame)
}

// Run receives frames until the stream fails or ends. A clean end returns io.EOF.
func (s *Stream) Run() error {
	for {
		if err := s.Receive(); err != nil {
			return err
		}
	}
}

// Close closes the peer, failing every pending request with an error wrapping protocol.ErrClosed.
func (s *Stream) Close(err error) { s.peer.Close(err) }
