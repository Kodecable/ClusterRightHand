package wire

import (
	"bytes"
	"context"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"net"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"

	"github.com/Kodecable/ClusterRightHand/client/internal/protocol"
)

// hasAllNames reports whether commands lists every name role's handshake requires.
func hasAllNames(commands []string, role Role) bool {
	set := protocol.NewSet(commands...)
	for _, name := range requiredNamesFor(role) {
		if !set.Has(name) {
			return false
		}
	}
	return true
}

// privVector is one crh-priv entry of test/interop/m4_vectors.json.
type privVector struct {
	id   string
	hex  string
	body []byte // without the 4-byte length prefix
}

// readPrivVectors reads the crh-priv golden data and checks every 4-byte length prefix against the
// frame it precedes. The fixture was produced by the TypeScript reference implementation.
func readPrivVectors(t *testing.T) []privVector {
	t.Helper()
	path := filepath.Join("..", "..", "..", "..", "test", "interop", "m4_vectors.json")
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read %s: %v", path, err)
	}
	var fixture struct {
		Priv []struct {
			ID          string `json:"id"`
			Description string `json:"description"`
			Hex         string `json:"hex"`
		} `json:"priv"`
	}
	if err := json.Unmarshal(data, &fixture); err != nil {
		t.Fatalf("parse %s: %v", path, err)
	}
	vectors := make([]privVector, 0, len(fixture.Priv))
	for _, entry := range fixture.Priv {
		raw, err := hex.DecodeString(entry.Hex)
		if err != nil {
			t.Fatalf("%s: hex: %v", entry.ID, err)
		}
		if len(raw) < 4 {
			t.Fatalf("%s is %d bytes, want a 4-byte length prefix", entry.ID, len(raw))
		}
		if size := binary.BigEndian.Uint32(raw); int(size) != len(raw)-4 {
			t.Fatalf("%s: length prefix says %d, body is %d bytes", entry.ID, size, len(raw)-4)
		}
		vectors = append(vectors, privVector{id: entry.ID, hex: entry.Hex, body: raw[4:]})
	}
	return vectors
}

// TestVectors decodes every crh-priv fixture entry and re-encodes it to the same bytes.
func TestVectors(t *testing.T) {
	vectors := readPrivVectors(t)
	seen := map[string]bool{}
	for _, entry := range vectors {
		seen[entry.id] = true
		t.Run(entry.id, func(t *testing.T) {
			raw, err := hex.DecodeString(entry.hex)
			if err != nil {
				t.Fatalf("hex: %v", err)
			}
			body := entry.body

			var encoded []byte
			switch entry.id {
			case "priv.hello":
				var hello PrivHello
				if err := protocol.Unmarshal(body, &hello); err != nil {
					t.Fatalf("decode: %v", err)
				}
				want := PrivHello{
					PrivMajor: PrivMajor, PrivMinor: PrivMinor,
					Commands: []string{
						"task.start", "task.input", "task.cancel", "task.query",
						"task.output", "task.exit", "trust.query", "trust.summary", "transfer.data",
					},
					CRHAVersion: "0.4.0",
					Role:        RoleForward,
				}
				if !reflect.DeepEqual(hello, want) {
					t.Fatalf("decoded as %+v, want %+v", hello, want)
				}
				if encoded, err = protocol.Marshal(hello); err != nil {
					t.Fatalf("encode: %v", err)
				}
			case "priv.welcome":
				var welcome PrivWelcome
				if err := protocol.Unmarshal(body, &welcome); err != nil {
					t.Fatalf("decode: %v", err)
				}
				want := PrivWelcome{
					PrivMajor: PrivMajor, PrivMinor: PrivMinor,
					Commands: []string{
						"task.start", "task.input", "task.cancel", "task.query",
						"task.output", "task.exit", "trust.query", "trust.summary", "transfer.data",
					},
					CRHAVersion: "0.4.0",
				}
				if !reflect.DeepEqual(welcome, want) {
					t.Fatalf("decoded as %+v, want %+v", welcome, want)
				}
				if encoded, err = protocol.Marshal(welcome); err != nil {
					t.Fatalf("encode: %v", err)
				}
			case "priv.task.start":
				frame, err := protocol.DecodeFrame(body)
				if err != nil {
					t.Fatalf("decode frame: %v", err)
				}
				if frame.Kind != protocol.FrameRequest || frame.ID != 1 || frame.Name != protocol.CmdTaskStart {
					t.Fatalf("frame = kind %d id %d name %q", frame.Kind, frame.ID, frame.Name)
				}
				var ts protocol.TaskStart
				if err := protocol.Unmarshal(frame.Body, &ts); err != nil {
					t.Fatalf("decode task.start: %v", err)
				}
				if ts.TaskID != "0192f000-0000-7000-8000-000000000001" || ts.Attempt != 1 || !ts.Privileged {
					t.Fatalf("task.start = %+v", ts)
				}
				if len(ts.Authorizations) != 1 || ts.TimeoutMS != 60000 || ts.KillGraceMS != 5000 {
					t.Fatalf("task.start = %+v", ts)
				}
				if ts.Spec.Kind != protocol.TaskSpecExec || ts.Spec.Exec == nil ||
					!reflect.DeepEqual(ts.Spec.Exec.Command.Argv, []string{"systemctl", "restart", "nginx"}) {
					t.Fatalf("task.start spec = %+v", ts.Spec)
				}
				if encoded, err = protocol.EncodeRequest(frame.ID, frame.Name, ts); err != nil {
					t.Fatalf("encode: %v", err)
				}
			default:
				t.Fatalf("no expectation for %s", entry.id)
			}
			if !bytes.Equal(encoded, body) {
				t.Fatalf("re-encoded as %x, want %x", encoded, body)
			}
			var prefixed bytes.Buffer
			if err := WriteFrame(&prefixed, body); err != nil {
				t.Fatalf("write frame: %v", err)
			}
			if !bytes.Equal(prefixed.Bytes(), raw) {
				t.Fatalf("length-prefixed frame is %x, want %x", prefixed.Bytes(), raw)
			}
		})
	}
	for _, id := range []string{"priv.hello", "priv.welcome", "priv.task.start"} {
		if !seen[id] {
			t.Errorf("%s is missing from the fixture", id)
		}
	}
}

// TestHandshakeFromVectors completes both handshake sides with the fixture's hello and welcome, so
// the Go handshake interoperates with the frames the TypeScript reference produced.
func TestHandshakeFromVectors(t *testing.T) {
	vectors := map[string][]byte{}
	for _, v := range readPrivVectors(t) {
		vectors[v.id] = v.body
	}

	// The fixture hello (role forward) is served by a forward role server.
	client, server := net.Pipe()
	defer client.Close()
	defer server.Close()
	type serverResult struct {
		hello *PrivHello
		set   protocol.Set
		err   error
	}
	results := make(chan serverResult, 1)
	go func() {
		hello, set, err := ServerHandshake(server, server, ServerOptions{Role: RoleForward, CRHAVersion: "0.4.0"})
		results <- serverResult{hello, set, err}
	}()
	if err := WriteFrame(client, vectors["priv.hello"]); err != nil {
		t.Fatal(err)
	}
	welcomeFrame, err := ReadFrame(client)
	if err != nil {
		t.Fatal(err)
	}
	var welcome PrivWelcome
	if err := protocol.Unmarshal(welcomeFrame, &welcome); err != nil {
		t.Fatalf("welcome: %v", err)
	}
	res := <-results
	if res.err != nil {
		t.Fatalf("server: %v", res.err)
	}
	if res.hello.Role != RoleForward || !hasAllNames(res.hello.Commands, RoleForward) {
		t.Fatalf("hello = %+v", res.hello)
	}
	if want := []string{
		"task.cancel", "task.exit", "task.input", "task.output", "task.query", "task.start",
		"transfer.data", "trust.query", "trust.summary",
	}; !reflect.DeepEqual(res.set.Names(), want) {
		t.Fatalf("negotiated %v, want %v", res.set.Names(), want)
	}

	// The fixture welcome answers a client handshake.
	client2, server2 := net.Pipe()
	defer client2.Close()
	defer server2.Close()
	type clientResult struct {
		welcome    *PrivWelcome
		negotiated protocol.Set
		err        error
	}
	clientResults := make(chan clientResult, 1)
	go func() {
		welcome, negotiated, err := ClientHandshake(client2, client2, ClientOptions{Role: RoleForward, CRHAVersion: "0.4.0"})
		clientResults <- clientResult{welcome, negotiated, err}
	}()
	helloFrame, err := ReadFrame(server2)
	if err != nil {
		t.Fatal(err)
	}
	var hello PrivHello
	if err := protocol.Unmarshal(helloFrame, &hello); err != nil {
		t.Fatalf("hello: %v", err)
	}
	if hello.Role != RoleForward || hello.PrivMajor != PrivMajor || !reflect.DeepEqual(hello.Commands, NamesFor(RoleForward)) {
		t.Fatalf("client hello = %+v", hello)
	}
	if err := WriteFrame(server2, vectors["priv.welcome"]); err != nil {
		t.Fatal(err)
	}
	cres := <-clientResults
	if cres.err != nil {
		t.Fatalf("client: %v", cres.err)
	}
	wantNegotiated := []string{
		"task.cancel", "task.exit", "task.input", "task.output", "task.query", "task.start",
		"transfer.data", "trust.query", "trust.summary",
	}
	if cres.welcome.CRHAVersion != "0.4.0" || !reflect.DeepEqual(cres.negotiated.Names(), wantNegotiated) {
		t.Fatalf("welcome = %+v negotiated %v", cres.welcome, cres.negotiated.Names())
	}
}

func TestFrameRoundtrip(t *testing.T) {
	frame := []byte{0x84, 0x00, 0x01, 0x60}
	var buf bytes.Buffer
	if err := WriteFrame(&buf, frame); err != nil {
		t.Fatal(err)
	}
	if got := buf.Bytes(); !bytes.Equal(got, []byte{0, 0, 0, 4, 0x84, 0x00, 0x01, 0x60}) {
		t.Fatalf("wire bytes %x", got)
	}
	got, err := ReadFrame(&buf)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(got, frame) {
		t.Fatalf("read %x, want %x", got, frame)
	}
	if _, err := ReadFrame(&buf); !errors.Is(err, io.EOF) {
		t.Fatalf("end of stream: %v, want io.EOF", err)
	}
}

func TestFrameErrors(t *testing.T) {
	oversize := make([]byte, 4)
	binary.BigEndian.PutUint32(oversize, MaxFrameBytes+1)
	tests := []struct {
		name    string
		in      []byte
		wantEOF bool
	}{
		{"zero length", []byte{0, 0, 0, 0}, false},
		{"oversize length", oversize, false},
		{"truncated length", []byte{0, 0}, false},
		{"truncated body", []byte{0, 0, 0, 5, 0x84, 0x00}, false},
		{"no length", nil, true},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			_, err := ReadFrame(bytes.NewReader(tc.in))
			if tc.wantEOF {
				if !errors.Is(err, io.EOF) {
					t.Fatalf("got %v, want io.EOF", err)
				}
				return
			}
			var protocolErr *ProtocolError
			if !errors.As(err, &protocolErr) {
				t.Fatalf("got %v, want a *ProtocolError", err)
			}
		})
	}

	var buf bytes.Buffer
	if err := WriteFrame(&buf, nil); err == nil {
		t.Fatal("wrote an empty frame")
	}
	if err := WriteFrame(&buf, make([]byte, MaxFrameBytes+1)); err == nil {
		t.Fatal("wrote an oversized frame")
	}
}

func TestRoleEnum(t *testing.T) {
	for _, role := range []Role{RoleForward, RoleNative, RoleLocal} {
		data, err := protocol.Marshal(role)
		if err != nil {
			t.Fatalf("%q: %v", role, err)
		}
		var got Role
		if err := protocol.Unmarshal(data, &got); err != nil || got != role {
			t.Fatalf("%q: got %q, %v", role, got, err)
		}
	}
	if _, err := protocol.Marshal(Role("root")); err == nil {
		t.Fatal("encoded an unknown role")
	}
	if err := protocol.Unmarshal([]byte{0x64, 'r', 'o', 'o', 't'}, new(Role)); err == nil {
		t.Fatal("decoded an unknown role")
	}
}

func TestHandshake(t *testing.T) {
	client, server := net.Pipe()
	defer client.Close()
	defer server.Close()

	type serverResult struct {
		hello *PrivHello
		set   protocol.Set
		err   error
	}
	results := make(chan serverResult, 1)
	go func() {
		hello, set, err := ServerHandshake(server, server, ServerOptions{Role: RoleNative, CRHAVersion: "0.4.0-test"})
		results <- serverResult{hello, set, err}
	}()

	welcome, negotiated, err := ClientHandshake(client, client, ClientOptions{Role: RoleNative, CRHAVersion: "0.4.0-test"})
	if err != nil {
		t.Fatalf("client: %v", err)
	}
	if welcome.PrivMajor != PrivMajor || welcome.PrivMinor != PrivMinor || welcome.CRHAVersion != "0.4.0-test" {
		t.Fatalf("welcome = %+v", welcome)
	}
	if want := []string{"task.cancel", "task.exit", "task.input", "task.output", "task.query", "task.start", "transfer.data"}; !reflect.DeepEqual(negotiated.Names(), want) {
		t.Fatalf("negotiated %v, want %v", negotiated.Names(), want)
	}
	res := <-results
	if res.err != nil {
		t.Fatalf("server: %v", res.err)
	}
	if res.hello.Role != RoleNative || res.hello.CRHAVersion != "0.4.0-test" {
		t.Fatalf("hello = %+v", res.hello)
	}
	if !reflect.DeepEqual(res.set.Names(), negotiated.Names()) {
		t.Fatalf("server negotiated %v, client %v", res.set.Names(), negotiated.Names())
	}
}

func TestServerHandshakeRejections(t *testing.T) {
	hello := func(mutate func(*PrivHello)) []byte {
		h := PrivHello{
			PrivMajor: PrivMajor, PrivMinor: PrivMinor, Commands: Names(),
			CRHAVersion: "0.4.0-test", Role: RoleNative,
		}
		if mutate != nil {
			mutate(&h)
		}
		data, err := protocol.Marshal(h)
		if err != nil {
			t.Fatalf("encode hello: %v", err)
		}
		return data
	}
	tests := []struct {
		name  string
		frame []byte
		opts  ServerOptions
		want  string
	}{
		{"role refused", hello(func(h *PrivHello) { h.Role = RoleForward }), ServerOptions{Role: RoleNative, CRHAVersion: "0.4.0-test"}, "not allowed"},
		{"major mismatch", hello(func(h *PrivHello) { h.PrivMajor = PrivMajor + 1 }), ServerOptions{Role: RoleNative, CRHAVersion: "0.4.0-test"}, "priv_major"},
		{"version mismatch", hello(func(h *PrivHello) { h.CRHAVersion = "0.3.0" }), ServerOptions{Role: RoleNative, CRHAVersion: "0.4.0-test"}, "crha version"},
		{"missing commands", hello(func(h *PrivHello) { h.Commands = []string{protocol.CmdTaskStart} }), ServerOptions{Role: RoleNative, CRHAVersion: "0.4.0-test"}, "does not implement"},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			client, server := net.Pipe()
			defer client.Close()
			defer server.Close()
			go func() { _ = WriteFrame(client, tc.frame) }()
			if _, _, err := ServerHandshake(server, server, tc.opts); err == nil || !strings.Contains(err.Error(), tc.want) {
				t.Fatalf("got %v, want an error containing %q", err, tc.want)
			}
		})
	}
}

func TestClientHandshakeRejections(t *testing.T) {
	welcome := func(mutate func(*PrivWelcome)) []byte {
		w := PrivWelcome{PrivMajor: PrivMajor, PrivMinor: PrivMinor, Commands: Names(), CRHAVersion: "0.4.0-test"}
		if mutate != nil {
			mutate(&w)
		}
		data, err := protocol.Marshal(w)
		if err != nil {
			t.Fatalf("encode welcome: %v", err)
		}
		return data
	}
	tests := []struct {
		name  string
		frame []byte
		want  string
	}{
		{"major mismatch", welcome(func(w *PrivWelcome) { w.PrivMajor = PrivMajor + 1 }), "priv_major"},
		{"version mismatch", welcome(func(w *PrivWelcome) { w.CRHAVersion = "0.3.0" }), "crha version"},
		{"missing commands", welcome(func(w *PrivWelcome) { w.Commands = nil }), "does not implement"},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			client, server := net.Pipe()
			defer client.Close()
			defer server.Close()
			go func() {
				if _, err := ReadFrame(server); err != nil {
					return
				}
				_ = WriteFrame(server, tc.frame)
			}()
			_, _, err := ClientHandshake(client, client, ClientOptions{Role: RoleNative, CRHAVersion: "0.4.0-test"})
			if err == nil || !strings.Contains(err.Error(), tc.want) {
				t.Fatalf("got %v, want an error containing %q", err, tc.want)
			}
		})
	}
}

// TestHandshakeDifferentMinorAccepted covers the additive minor: a peer that only differs in
// priv_minor still connects, and the command intersection decides the feature set.
func TestHandshakeDifferentMinorAccepted(t *testing.T) {
	t.Run("server side", func(t *testing.T) {
		client, server := net.Pipe()
		defer client.Close()
		defer server.Close()
		go func() {
			hello := PrivHello{
				PrivMajor: PrivMajor, PrivMinor: PrivMinor + 1, Commands: Names(),
				CRHAVersion: "0.4.0-test", Role: RoleNative,
			}
			data, err := protocol.Marshal(hello)
			if err != nil {
				return
			}
			if WriteFrame(client, data) != nil {
				return
			}
			_, _ = ReadFrame(client) // drain the welcome
		}()
		if _, _, err := ServerHandshake(server, server, ServerOptions{Role: RoleNative, CRHAVersion: "0.4.0-test"}); err != nil {
			t.Fatalf("ServerHandshake: %v", err)
		}
	})
	t.Run("client side", func(t *testing.T) {
		client, server := net.Pipe()
		defer client.Close()
		defer server.Close()
		go func() {
			if _, err := ReadFrame(server); err != nil {
				return
			}
			welcome := PrivWelcome{
				PrivMajor: PrivMajor, PrivMinor: PrivMinor + 1, Commands: Names(), CRHAVersion: "0.4.0-test",
			}
			data, err := protocol.Marshal(welcome)
			if err != nil {
				return
			}
			_ = WriteFrame(server, data)
		}()
		if _, _, err := ClientHandshake(client, client, ClientOptions{Role: RoleNative, CRHAVersion: "0.4.0-test"}); err != nil {
			t.Fatalf("ClientHandshake: %v", err)
		}
	})
}

// TestRoleNames covers the per-role command sets: native keeps the 1.0 task set, forward adds
// the forward-only names and local adds its approval names.
func TestRoleNames(t *testing.T) {
	core := []string{"task.cancel", "task.exit", "task.input", "task.output", "task.query", "task.start", "transfer.data"}
	if got := Names(); !reflect.DeepEqual(got, core) {
		t.Fatalf("Names() = %v, want %v", got, core)
	}
	if got := NamesFor(RoleNative); !reflect.DeepEqual(got, core) {
		t.Fatalf("native names = %v", got)
	}
	cases := []struct {
		role Role
		want []string
	}{
		{RoleForward, []string{
			"local.decision", "local.request", "local.withdraw",
			"task.cancel", "task.exit", "task.input", "task.output", "task.query", "task.start",
			"transfer.data", "trust.query", "trust.summary",
		}},
		{RoleLocal, []string{"local.approve", "local.deny", "pending.list"}},
	}
	for _, tc := range cases {
		if got := NamesFor(tc.role); !reflect.DeepEqual(got, tc.want) {
			t.Fatalf("%s names = %v, want %v", tc.role, got, tc.want)
		}
	}
}

// TestLocalHandshake completes a local-role handshake and checks that the role's private
// command schemas are registered on both peers.
func TestLocalHandshake(t *testing.T) {
	client, server := net.Pipe()
	defer client.Close()
	defer server.Close()
	type result struct {
		hello *PrivHello
		set   protocol.Set
		err   error
	}
	results := make(chan result, 1)
	go func() {
		hello, set, err := ServerHandshake(server, server, ServerOptions{Roles: []Role{RoleForward, RoleLocal}, CRHAVersion: "0.4.0-test"})
		results <- result{hello, set, err}
	}()
	_, negotiated, err := ClientHandshake(client, client, ClientOptions{Role: RoleLocal, CRHAVersion: "0.4.0-test"})
	if err != nil {
		t.Fatalf("client: %v", err)
	}
	if got := negotiated.Names(); !reflect.DeepEqual(got, NamesFor(RoleLocal)) {
		t.Fatalf("negotiated %v", got)
	}
	res := <-results
	if res.err != nil {
		t.Fatalf("server: %v", res.err)
	}
	if res.hello.Role != RoleLocal || !reflect.DeepEqual(res.set.Names(), NamesFor(RoleLocal)) {
		t.Fatalf("server hello %+v set %v", res.hello, res.set.Names())
	}
	// NewStreamFor must register the private schemas; a request with a wrong body is
	// rejected locally by Peer.Request before anything is written.
	stream := NewStreamFor(client, client, negotiated, RoleLocal)
	var empty protocol.Empty
	err = stream.Peer().Request(context.Background(), CmdLocalApprove, protocol.Empty{}, &empty)
	if err == nil || !strings.Contains(err.Error(), "body") {
		t.Fatalf("local.approve with an empty body = %v, want a local schema rejection", err)
	}
}

// TestForwardHandshakeAdditions covers a full forward handshake with both peers advertising
// every forward name, so the extra names are negotiated too.
func TestForwardHandshakeAdditions(t *testing.T) {
	client, server := net.Pipe()
	defer client.Close()
	defer server.Close()
	type result struct {
		err error
	}
	results := make(chan result, 1)
	go func() {
		_, _, err := ServerHandshake(server, server, ServerOptions{Roles: []Role{RoleForward}, CRHAVersion: "0.4.0-test"})
		results <- result{err}
	}()
	_, negotiated, err := ClientHandshake(client, client, ClientOptions{Role: RoleForward, CRHAVersion: "0.4.0-test"})
	if err != nil {
		t.Fatalf("client: %v", err)
	}
	if got := negotiated.Names(); !reflect.DeepEqual(got, NamesFor(RoleForward)) {
		t.Fatalf("negotiated %v, want %v", got, NamesFor(RoleForward))
	}
	if res := <-results; res.err != nil {
		t.Fatalf("server: %v", res.err)
	}
}
