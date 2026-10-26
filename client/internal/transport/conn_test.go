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
	"github.com/Kodecable/ClusterRightHand/client/internal/proto/crhv1"
	"github.com/coder/websocket"
	"google.golang.org/protobuf/proto"
)

// fakeServer mimics crhs's side of the handshake and echoes Ping as Pong.
func fakeServer(t *testing.T, server noise.Keypair, allowed []byte, tamperChallenge bool) *httptest.Server {
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
		var init crhv1.HandshakeInit
		if proto.Unmarshal(payload, &init) != nil || init.CrhaVersion != "test" {
			ws.Close(websocket.StatusPolicyViolation, "bad init")
			return
		}
		resp, _ := proto.Marshal(&crhv1.HandshakeResponse{
			ConnectionId: "c1", ServerTimeUnixMs: time.Now().UnixMilli(), NodeState: crhv1.NodeState_NODE_STATE_ACTIVE,
		})
		m2, session, _ := res.WriteResponse(resp)
		_ = ws.Write(ctx, websocket.MessageBinary, m2)
		for {
			_, ct, err := ws.Read(ctx)
			if err != nil {
				return
			}
			pt, err := session.Decrypt(ct)
			if err != nil {
				return
			}
			var env crhv1.Envelope
			_ = proto.Unmarshal(pt, &env)
			if p := env.GetPing(); p != nil {
				out, _ := proto.Marshal(&crhv1.Envelope{Body: &crhv1.Envelope_Pong{Pong: &crhv1.Pong{Seq: p.Seq}}})
				ct, _ := session.Encrypt(out)
				_ = ws.Write(ctx, websocket.MessageBinary, ct)
			}
		}
	}))
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

func TestDialAndPing(t *testing.T) {
	client, server := keys(t)
	srv := fakeServer(t, server, client.Public, false)
	defer srv.Close()
	ctx := context.Background()
	c, err := Dial(ctx, DialOptions{URL: wsURL(srv), Identity: client, ServerPublic: server.Public, Init: &crhv1.HandshakeInit{CrhaVersion: "test"}})
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close("done")
	if c.Response.ConnectionId != "c1" || c.ClockOffset > time.Second || c.ClockOffset < -time.Second {
		t.Fatalf("response = %v, offset = %v", c.Response, c.ClockOffset)
	}
	for seq := uint64(1); seq <= 3; seq++ {
		if err := c.Send(ctx, &crhv1.Envelope{Body: &crhv1.Envelope_Ping{Ping: &crhv1.Ping{Seq: seq}}}); err != nil {
			t.Fatal(err)
		}
		env, err := c.Recv(ctx)
		if err != nil || env.GetPong().GetSeq() != seq {
			t.Fatalf("recv = %v, %v", env, err)
		}
	}
	big := &crhv1.Envelope{Body: &crhv1.Envelope_TaskOutput{TaskOutput: &crhv1.TaskOutput{Data: make([]byte, MaxEnvelopeLen)}}}
	if err := c.Send(ctx, big); err == nil {
		t.Fatal("oversized envelope sent")
	}
}

func TestDialRejected(t *testing.T) {
	client, server := keys(t)
	other, _ := keys(t)
	srv := fakeServer(t, server, other.Public, false)
	defer srv.Close()
	_, err := Dial(context.Background(), DialOptions{URL: wsURL(srv), Identity: client, ServerPublic: server.Public, Init: &crhv1.HandshakeInit{CrhaVersion: "test"}})
	var he *HandshakeError
	if !errors.As(err, &he) || !strings.Contains(err.Error(), "unknown node") {
		t.Fatalf("err = %v", err)
	}
}

func TestDialChallengeMismatch(t *testing.T) {
	client, server := keys(t)
	srv := fakeServer(t, server, client.Public, true)
	defer srv.Close()
	_, err := Dial(context.Background(), DialOptions{URL: wsURL(srv), Identity: client, ServerPublic: server.Public, Init: &crhv1.HandshakeInit{CrhaVersion: "test"}})
	if err == nil {
		t.Fatal("handshake succeeded with a different challenge")
	}
}

func TestDialWrongServerKey(t *testing.T) {
	client, server := keys(t)
	_, impostor := keys(t)
	srv := fakeServer(t, impostor, client.Public, false)
	defer srv.Close()
	if _, err := Dial(context.Background(), DialOptions{URL: wsURL(srv), Identity: client, ServerPublic: server.Public, Init: &crhv1.HandshakeInit{CrhaVersion: "test"}}); err == nil {
		t.Fatal("connected to a server with the wrong key")
	}
}
