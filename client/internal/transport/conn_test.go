package transport

import (
	"context"
	"crypto/rand"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/Kodecable/ClusterRightHand/client/internal/noise"
	"github.com/Kodecable/ClusterRightHand/client/internal/protocol"
	"github.com/coder/websocket"
	"github.com/fxamacker/cbor/v2"
)

// fakeServer mimics crhs's side of the handshake and answers ping requests.
func fakeServer(t *testing.T, server noise.Keypair, allowed []byte, tamperChallenge bool, response func() *protocol.HandshakeResponse) *httptest.Server {
	t.Helper()
	return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		ws, err := websocket.Accept(w, r, nil)
		if err != nil {
			return
		}
		defer ws.CloseNow()
		ctx := r.Context()
		challenge := make([]byte, noise.ChallengeLen)
		_, _ = rand.Read(challenge)
		_ = ws.Write(ctx, websocket.MessageBinary, challenge)
		if tamperChallenge {
			challenge[0] ^= 1
		}
		res, _ := noise.NewResponder(server, challenge)
		_, m1, err := ws.Read(ctx)
		if err != nil {
			return
		}
		payload, clientPub, err := res.ReadInit(m1)
		if err != nil || string(clientPub) != string(allowed) {
			ws.Close(websocket.StatusPolicyViolation, "unknown node")
			return
		}
		var init protocol.HandshakeInit
		if protocol.Unmarshal(payload, &init) != nil || init.CRHAVersion != "test" {
			ws.Close(websocket.StatusPolicyViolation, "bad init")
			return
		}
		resp := activeHandshake(protocol.RequiredNames())
		if response != nil {
			resp = response()
		}
		respPayload, err := protocol.Marshal(resp)
		if err != nil {
			return
		}
		m2, session, err := res.WriteResponse(respPayload)
		if err != nil {
			return
		}
		_ = ws.Write(ctx, websocket.MessageBinary, m2)
		peer := protocol.NewPeer(func(frame []byte) error {
			ct, err := session.Encrypt(frame)
			if err != nil {
				return err
			}
			return ws.Write(ctx, websocket.MessageBinary, ct)
		}, protocol.RequiredSet().Intersect(protocol.NewSet(init.Commands...)))
		peer.HandleRequest(protocol.CmdPing, func(_ context.Context, body cbor.RawMessage) (any, error) {
			var p protocol.Ping
			if err := protocol.Unmarshal(body, &p); err != nil {
				return nil, err
			}
			return p, nil
		})
		for {
			_, ct, err := ws.Read(ctx)
			if err != nil {
				return
			}
			pt, err := session.Decrypt(ct)
			if err != nil {
				return
			}
			if err := peer.Receive(pt); err != nil {
				return
			}
		}
	}))
}

// activeHandshake is a valid handshake response for a connected, active node.
func activeHandshake(commands []string) *protocol.HandshakeResponse {
	return &protocol.HandshakeResponse{
		ProtocolMajor: protocol.ProtocolMajor,
		ProtocolMinor: protocol.ProtocolMinor,
		Commands:      commands,
		ConnectionID:  "c1",
		ServerTimeMS:  protocol.Int(time.Now().UnixMilli()),
		NodeState:     protocol.NodeActive,
		NodeID:        "node-1",
	}
}

func keys(t *testing.T) (client, server noise.Keypair) {
	t.Helper()
	client, err := noise.GenerateKeypair()
	if err != nil {
		t.Fatal(err)
	}
	server, err = noise.GenerateKeypair()
	if err != nil {
		t.Fatal(err)
	}
	return client, server
}

func wsURL(s *httptest.Server) string { return "ws" + strings.TrimPrefix(s.URL, "http") + "/agent" }

func dial(t *testing.T, s *httptest.Server, client, server noise.Keypair) (*Conn, error) {
	t.Helper()
	return Dial(context.Background(), DialOptions{
		URL:          wsURL(s),
		Identity:     client,
		ServerPublic: server.Public,
		Init:         &protocol.HandshakeInit{CRHAVersion: "test"},
	})
}

func TestDialAndPing(t *testing.T) {
	client, server := keys(t)
	srv := fakeServer(t, server, client.Public, false, nil)
	defer srv.Close()
	ctx := context.Background()
	c, err := dial(t, srv, client, server)
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close("done")
	if c.Response.ConnectionID != "c1" || c.ClockOffset > time.Second || c.ClockOffset < -time.Second {
		t.Fatalf("response = %v, offset = %v", c.Response, c.ClockOffset)
	}
	for _, name := range protocol.RequiredNames() {
		if !c.Negotiated.Has(name) {
			t.Fatalf("negotiated set misses %q", name)
		}
	}
	for seq := protocol.Uint(1); seq <= 3; seq++ {
		frame, err := protocol.EncodeRequest(protocol.Uint(seq), protocol.CmdPing, protocol.Ping{Seq: seq})
		if err != nil {
			t.Fatal(err)
		}
		if err := c.Send(ctx, frame); err != nil {
			t.Fatal(err)
		}
		raw, err := c.Recv(ctx)
		if err != nil {
			t.Fatal(err)
		}
		f, err := protocol.DecodeFrame(raw)
		if err != nil {
			t.Fatal(err)
		}
		var pong protocol.Ping
		if f.Kind != protocol.FrameResponse || !f.OK || f.ID != seq || protocol.Unmarshal(f.Body, &pong) != nil || pong.Seq != seq {
			t.Fatalf("response = %#v, pong = %v", f, pong)
		}
	}
	if err := c.Send(ctx, make([]byte, MaxEnvelopeLen+1)); err == nil {
		t.Fatal("oversized frame sent")
	}
}

func TestDialRejected(t *testing.T) {
	client, server := keys(t)
	other, _ := keys(t)
	srv := fakeServer(t, server, other.Public, false, nil)
	defer srv.Close()
	_, err := dial(t, srv, client, server)
	var he *HandshakeError
	if !errors.As(err, &he) || !strings.Contains(err.Error(), "unknown node") {
		t.Fatalf("err = %v", err)
	}
}

func TestDialChallengeMismatch(t *testing.T) {
	client, server := keys(t)
	srv := fakeServer(t, server, client.Public, true, nil)
	defer srv.Close()
	if _, err := dial(t, srv, client, server); err == nil {
		t.Fatal("handshake succeeded with a different challenge")
	}
}

func TestDialWrongServerKey(t *testing.T) {
	client, server := keys(t)
	_, impostor := keys(t)
	srv := fakeServer(t, impostor, client.Public, false, nil)
	defer srv.Close()
	if _, err := dial(t, srv, client, server); err == nil {
		t.Fatal("connected to a server with the wrong key")
	}
}

func TestDialProtocolMajorMismatch(t *testing.T) {
	client, server := keys(t)
	srv := fakeServer(t, server, client.Public, false, func() *protocol.HandshakeResponse {
		resp := activeHandshake(protocol.RequiredNames())
		resp.ProtocolMajor = protocol.ProtocolMajor + 1
		return resp
	})
	defer srv.Close()
	_, err := dial(t, srv, client, server)
	var he *HandshakeError
	if !errors.As(err, &he) || !strings.Contains(err.Error(), "protocol_major mismatch") {
		t.Fatalf("err = %v", err)
	}
}

func TestDialDifferentMinorAccepted(t *testing.T) {
	client, server := keys(t)
	srv := fakeServer(t, server, client.Public, false, func() *protocol.HandshakeResponse {
		resp := activeHandshake(protocol.RequiredNames())
		resp.ProtocolMinor = protocol.ProtocolMinor + 1
		return resp
	})
	defer srv.Close()
	c, err := dial(t, srv, client, server)
	if err != nil {
		t.Fatalf("handshake with a different minor: %v", err)
	}
	defer c.Close("done")
}

func TestDialMissingRequiredCommand(t *testing.T) {
	client, server := keys(t)
	srv := fakeServer(t, server, client.Public, false, func() *protocol.HandshakeResponse {
		var commands []string
		for _, name := range protocol.RequiredNames() {
			if name != protocol.CmdTaskStart {
				commands = append(commands, name)
			}
		}
		return activeHandshake(commands)
	})
	defer srv.Close()
	_, err := dial(t, srv, client, server)
	var he *HandshakeError
	if !errors.As(err, &he) || !strings.Contains(err.Error(), "missing required command: "+protocol.CmdTaskStart) {
		t.Fatalf("err = %v", err)
	}
}

// blockingWS never completes a write until the write context expires.
type blockingWS struct{}

func (blockingWS) Read(context.Context) (websocket.MessageType, []byte, error) {
	return 0, nil, errors.New("unexpected read")
}

func (blockingWS) Write(ctx context.Context, _ websocket.MessageType, _ []byte) error {
	<-ctx.Done()
	return ctx.Err()
}

func (blockingWS) Close(websocket.StatusCode, string) error { return nil }
func (blockingWS) SetReadLimit(int64)                       {}

// testSession returns a completed Noise session; it never touches the network.
func testSession(t *testing.T) *noise.Session {
	t.Helper()
	client, server := keys(t)
	challenge := make([]byte, noise.ChallengeLen)
	_, _ = rand.Read(challenge)
	ini, err := noise.NewInitiator(client, server.Public, challenge)
	if err != nil {
		t.Fatal(err)
	}
	res, err := noise.NewResponder(server, challenge)
	if err != nil {
		t.Fatal(err)
	}
	m1, err := ini.WriteInit(nil)
	if err != nil {
		t.Fatal(err)
	}
	if _, _, err := res.ReadInit(m1); err != nil {
		t.Fatal(err)
	}
	m2, _, err := res.WriteResponse(nil)
	if err != nil {
		t.Fatal(err)
	}
	_, session, err := ini.ReadResponse(m2)
	if err != nil {
		t.Fatal(err)
	}
	return session
}

func TestSendWriteTimeout(t *testing.T) {
	old := writeTimeout
	writeTimeout = 100 * time.Millisecond
	defer func() { writeTimeout = old }()

	c := &Conn{ws: blockingWS{}, session: testSession(t)}
	start := time.Now()
	err := c.Send(context.Background(), []byte{0x80})
	if err == nil {
		t.Fatal("send to a blocked peer succeeded")
	}
	if !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("err = %v, want a deadline", err)
	}
	if elapsed := time.Since(start); elapsed > 5*time.Second {
		t.Fatalf("send took %v", elapsed)
	}
}

// TestDialData covers the data connection's own prologue and handshake payloads
// (doc/design/protocol.md "Data connections").
func TestDialData(t *testing.T) {
	serverKey, err := noise.GenerateKeypair()
	if err != nil {
		t.Fatal(err)
	}
	clientKey, err := noise.GenerateKeypair()
	if err != nil {
		t.Fatal(err)
	}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		ws, err := websocket.Accept(w, r, nil)
		if err != nil {
			return
		}
		defer ws.CloseNow()
		ctx := r.Context()
		challenge := make([]byte, noise.ChallengeLen)
		_, _ = rand.Read(challenge)
		_ = ws.Write(ctx, websocket.MessageBinary, challenge)
		res, _ := noise.NewDataResponder(serverKey, challenge)
		_, m1, err := ws.Read(ctx)
		if err != nil {
			return
		}
		payload, clientPub, err := res.ReadInit(m1)
		if err != nil || string(clientPub) != string(clientKey.Public) {
			ws.Close(websocket.StatusPolicyViolation, "unknown node")
			return
		}
		var init protocol.DataConnectionInit
		if protocol.Unmarshal(payload, &init) != nil || init.TaskID != "task-1" || init.TransferID != "tr-1" {
			ws.Close(websocket.StatusPolicyViolation, "bad init")
			return
		}
		respPayload, err := protocol.Marshal(protocol.DataConnectionResponse{ProtocolMajor: protocol.ProtocolMajor})
		if err != nil {
			return
		}
		m2, session, err := res.WriteResponse(respPayload)
		if err != nil {
			return
		}
		_ = ws.Write(ctx, websocket.MessageBinary, m2)
		_, ct, err := ws.Read(ctx)
		if err != nil {
			return
		}
		frame, err := session.Decrypt(ct)
		if err != nil {
			return
		}
		var got protocol.DataFrame
		if protocol.Unmarshal(frame, &got) != nil || got.Kind != protocol.DataFrameEnd {
			return
		}
		echo, _ := protocol.Marshal(protocol.DataFrame{Kind: protocol.DataFrameData, Bytes: []byte("ok")})
		ct, _ = session.Encrypt(echo)
		_ = ws.Write(ctx, websocket.MessageBinary, ct)
	}))
	defer srv.Close()

	conn, err := DialData(context.Background(), DataDialOptions{
		URL:          "ws" + strings.TrimPrefix(srv.URL, "http"),
		Identity:     clientKey,
		ServerPublic: serverKey.Public,
		TaskID:       "task-1",
		TransferID:   "tr-1",
	})
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close("done")
	end, err := protocol.Marshal(protocol.DataFrame{Kind: protocol.DataFrameEnd})
	if err != nil {
		t.Fatal(err)
	}
	if err := conn.Send(context.Background(), end); err != nil {
		t.Fatal(err)
	}
	raw, err := conn.Recv(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	var frame protocol.DataFrame
	if err := protocol.Unmarshal(raw, &frame); err != nil {
		t.Fatal(err)
	}
	if frame.Kind != protocol.DataFrameData || string(frame.Bytes) != "ok" {
		t.Fatalf("frame = %+v", frame)
	}
}
