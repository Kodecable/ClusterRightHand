package agent

import (
	"context"
	"errors"
	"reflect"
	"testing"
	"time"

	"github.com/Kodecable/ClusterRightHand/client/internal/noise"
	"github.com/Kodecable/ClusterRightHand/client/internal/protocol"
	"github.com/fxamacker/cbor/v2"
)

// metricsReply is what one metrics.collect request returned.
type metricsReply struct {
	snapshot protocol.MetricsSnapshot
	err      error
}

// requestMetrics sends one metrics.collect over p and reports its answer.
func requestMetrics(ctx context.Context, p *protocol.Peer) metricsReply {
	var snapshot protocol.MetricsSnapshot
	err := p.Request(ctx, protocol.CmdMetricsCollect, protocol.Empty{}, &snapshot)
	return metricsReply{snapshot: snapshot, err: err}
}

func TestMetricsCollect(t *testing.T) {
	serverKey, err := noise.GenerateKeypair()
	if err != nil {
		t.Fatal(err)
	}
	want := protocol.MetricsSnapshot{
		BootID:    ptr("6f1e2d3c-4b5a-4978-8a9b-0c1d2e3f4a5b"),
		UptimeSec: ptr(protocol.Uint(12345)),
		CPU: &protocol.MetricsCPU{
			Total: protocol.MetricsCPUTotal{Busy: 7, Total: 10},
			Cores: []protocol.MetricsCore{{Index: 0, Busy: 7, Total: 10}},
		},
		Loads:      &protocol.MetricsLoads{L1: 150, L5: 100, L15: 50},
		Memory:     &protocol.MetricsMemory{TotalBytes: 1, AvailableBytes: 2, CachedBytes: 3, FreeBytes: 4},
		Swap:       &protocol.MetricsSwap{TotalBytes: 5, FreeBytes: 6},
		Disks:      []protocol.MetricsDisk{{Name: "root", Path: "/", TotalBytes: 100, UsedBytes: 40}},
		Interfaces: []protocol.MetricsInterface{{Name: "eth0", RXBytes: 1, TXBytes: 2, RXPackets: 3, TXPackets: 4}},
	}
	replies := make(chan metricsReply, 1)
	calls := make(chan struct{}, 1)
	srv := startFake(t, serverKey, fakeConfig{
		commands: protocol.OfferedNames(),
		setup:    ignoreFacts,
		run: func(ctx context.Context, p *protocol.Peer) {
			replies <- requestMetrics(ctx, p)
		},
	})
	a := newTestAgent(t, Options{
		Metrics: func() protocol.MetricsSnapshot {
			calls <- struct{}{}
			return want
		},
	})
	conn := dialTo(t, srv, serverKey)
	startSession(t, a, conn)

	reply := waitCh(t, replies, "metrics.collect response")
	if reply.err != nil {
		t.Fatalf("metrics.collect: %v", reply.err)
	}
	if !reflect.DeepEqual(reply.snapshot, want) {
		t.Fatalf("snapshot = %#v, want %#v", reply.snapshot, want)
	}
	select {
	case <-calls:
	case <-time.After(time.Second):
		t.Fatal("the metrics reader was not called")
	}
}

// TestMetricsCollectNotNegotiated covers the optional name: a minor-1 crhs does not offer
// metrics.collect, so crha answers a request for it (which a correct crhs never sends) with
// unsupported_command.
func TestMetricsCollectNotNegotiated(t *testing.T) {
	serverKey, err := noise.GenerateKeypair()
	if err != nil {
		t.Fatal(err)
	}
	replies := make(chan error, 1)
	srv := startFake(t, serverKey, fakeConfig{
		commands:  protocol.RequiredNames(), // a crhs of protocol minor 1
		peerNames: []string{protocol.CmdMetricsCollect},
		setup:     ignoreFacts,
		run: func(ctx context.Context, p *protocol.Peer) {
			var empty protocol.Empty
			replies <- p.Request(ctx, protocol.CmdMetricsCollect, protocol.Empty{}, &empty)
		},
	})
	a := newTestAgent(t, Options{Metrics: func() protocol.MetricsSnapshot { return protocol.MetricsSnapshot{} }})
	conn := dialTo(t, srv, serverKey)
	startSession(t, a, conn)

	var remote *protocol.RemoteError
	if err := waitCh(t, replies, "metrics.collect response"); !errors.As(err, &remote) ||
		remote.Code != protocol.CodeUnsupportedCommand {
		t.Fatalf("metrics.collect = %v, want unsupported_command", err)
	}
}

// TestMetricsCollectRestricted covers the gating: a restricted (pending) connection does not serve
// metrics.collect, even though the name is negotiated (doc/design/protocol.md "Restricted
// connections").
func TestMetricsCollectRestricted(t *testing.T) {
	serverKey, err := noise.GenerateKeypair()
	if err != nil {
		t.Fatal(err)
	}
	replies := make(chan error, 1)
	srv := startFake(t, serverKey, fakeConfig{
		nodeState: protocol.NodePending,
		commands:  protocol.OfferedNames(),
		setup:     ignoreFacts,
		run: func(ctx context.Context, p *protocol.Peer) {
			var empty protocol.Empty
			replies <- p.Request(ctx, protocol.CmdMetricsCollect, protocol.Empty{}, &empty)
		},
	})
	a := newTestAgent(t, Options{Metrics: func() protocol.MetricsSnapshot { return protocol.MetricsSnapshot{} }})
	conn := dialTo(t, srv, serverKey)
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() {
		_ = a.pendingSession(ctx, conn)
		close(done)
	}()
	t.Cleanup(func() {
		cancel()
		_ = conn.Close("done")
		select {
		case <-done:
		case <-time.After(10 * time.Second):
			t.Error("pending session did not stop")
		}
	})

	var remote *protocol.RemoteError
	if err := waitCh(t, replies, "metrics.collect response"); !errors.As(err, &remote) ||
		remote.Code != protocol.CodeUnsupportedCommand {
		t.Fatalf("metrics.collect on a restricted connection = %v, want unsupported_command", err)
	}
}

// ignoreFacts consumes the events every session sends that this test does not inspect: facts and,
// when the terminal names are negotiated, pty.list.
func ignoreFacts(p *protocol.Peer) {
	p.HandleEvent(protocol.EventFacts, func(cbor.RawMessage) error { return nil })
	p.HandleEvent(protocol.EventPTYList, func(cbor.RawMessage) error { return nil })
}

// ptr is a test helper for optional protocol fields.
func ptr[T any](value T) *T { return &value }
