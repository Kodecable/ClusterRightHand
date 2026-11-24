package protocol

import (
	"bytes"
	"math"
	"reflect"
	"testing"
)

// fixtureMetricsSnapshot is defined in fixture_test.go: one full sample of every optional field.

func TestMetricsSnapshotRoundTrip(t *testing.T) {
	want := fixtureMetricsSnapshot()
	encoded, err := Marshal(want)
	if err != nil {
		t.Fatalf("Marshal: %v", err)
	}
	var got MetricsSnapshot
	if err := Unmarshal(encoded, &got); err != nil {
		t.Fatalf("Unmarshal: %v", err)
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("round trip = %#v, want %#v", got, want)
	}
	reencoded, err := Marshal(got)
	if err != nil {
		t.Fatalf("re-Marshal: %v", err)
	}
	if !bytes.Equal(reencoded, encoded) {
		t.Fatalf("re-encoded as %x, want %x", reencoded, encoded)
	}
}

func TestMetricsSnapshotOptionalFields(t *testing.T) {
	empty, err := Marshal(MetricsSnapshot{})
	if err != nil {
		t.Fatalf("Marshal empty: %v", err)
	}
	if !bytes.Equal(empty, []byte{0xa0}) {
		t.Fatalf("empty snapshot = %x, want a0", empty)
	}
	var got MetricsSnapshot
	if err := Unmarshal([]byte{0xa0}, &got); err != nil {
		t.Fatalf("Unmarshal empty: %v", err)
	}
	if !reflect.DeepEqual(got, MetricsSnapshot{}) {
		t.Fatalf("decoded empty = %#v", got)
	}

	// An empty list is present, not absent, and comes back non-nil.
	raw, err := encMode.Marshal(map[string]any{"disks": []any{}, "interfaces": []any{}})
	if err != nil {
		t.Fatal(err)
	}
	if err := Unmarshal(raw, &got); err != nil {
		t.Fatalf("Unmarshal empty lists: %v", err)
	}
	if got.Disks == nil || got.Interfaces == nil || len(got.Disks) != 0 || len(got.Interfaces) != 0 {
		t.Fatalf("empty lists decoded as %#v", got)
	}

	// Unknown text keys are ignored, like Facts.
	raw, err = encMode.Marshal(map[string]any{"boot_id": "boot-1", "future_metric": uint64(1)})
	if err != nil {
		t.Fatal(err)
	}
	if err := Unmarshal(raw, &got); err != nil {
		t.Fatalf("Unmarshal unknown key: %v", err)
	}
	if got.BootID == nil || *got.BootID != "boot-1" || got.CPU != nil {
		t.Fatalf("decoded unknown key as %#v", got)
	}

	// A null known key is not the same as an absent one, and a non-text key fails the map.
	if err := Unmarshal([]byte{0xf6}, &got); err == nil {
		t.Fatal("accepted a null body instead of a map")
	}
	for _, value := range []map[string]any{
		{"boot_id": nil},
		{"uptime_sec": nil},
		{"cpu": nil},
		{"loads": nil},
		{"memory": nil},
		{"swap": nil},
		{"disks": nil},
		{"interfaces": nil},
	} {
		raw, err := encMode.Marshal(value)
		if err != nil {
			t.Fatal(err)
		}
		if err := Unmarshal(raw, &got); err == nil {
			t.Fatalf("accepted null in %v", value)
		}
	}
	if err := Unmarshal([]byte{0xa1, 0x01, 0x05}, &got); err == nil {
		t.Fatal("accepted an integer map key")
	}
}

func TestMetricsLimits(t *testing.T) {
	core := []any{Uint(0), Uint64(1), Uint64(2)}
	cores := make([]any, MaxMetricsCores+1)
	for i := range cores {
		cores[i] = core
	}
	total := []any{Uint64(1), Uint64(2)}
	tooManyCores, err := encMode.Marshal(map[string]any{"cpu": []any{total, cores}})
	if err != nil {
		t.Fatal(err)
	}
	var snapshot MetricsSnapshot
	if err := Unmarshal(tooManyCores, &snapshot); err == nil {
		t.Fatal("accepted more than MaxMetricsCores cores")
	}

	disk := []any{"ok", []any{"root", "/", Uint64(1), Uint64(2)}}
	disks := make([]any, MaxMetricsDisks+1)
	for i := range disks {
		disks[i] = disk
	}
	tooManyDisks, err := encMode.Marshal(map[string]any{"disks": disks})
	if err != nil {
		t.Fatal(err)
	}
	if err := Unmarshal(tooManyDisks, &snapshot); err == nil {
		t.Fatal("accepted more than MaxMetricsDisks disks")
	}

	iface := []any{"eth0", Uint64(1), Uint64(2), Uint64(3), Uint64(4)}
	interfaces := make([]any, MaxMetricsInterfaces+1)
	for i := range interfaces {
		interfaces[i] = iface
	}
	tooManyInterfaces, err := encMode.Marshal(map[string]any{"interfaces": interfaces})
	if err != nil {
		t.Fatal(err)
	}
	if err := Unmarshal(tooManyInterfaces, &snapshot); err == nil {
		t.Fatal("accepted more than MaxMetricsInterfaces interfaces")
	}

	// The encoder refuses the same counts rather than putting them on the wire.
	tooBig := MetricsCPU{Cores: make([]MetricsCore, MaxMetricsCores+1)}
	if _, err := Marshal(tooBig); err == nil {
		t.Fatal("encoded more than MaxMetricsCores cores")
	}
	if _, err := Marshal(MetricsSnapshot{Disks: make([]MetricsDisk, MaxMetricsDisks+1)}); err == nil {
		t.Fatal("encoded more than MaxMetricsDisks disks")
	}
	if _, err := Marshal(MetricsSnapshot{Interfaces: make([]MetricsInterface, MaxMetricsInterfaces+1)}); err == nil {
		t.Fatal("encoded more than MaxMetricsInterfaces interfaces")
	}
}

func TestMetricsDiskBranches(t *testing.T) {
	timeout := "statfs timed out"
	for _, disk := range []MetricsDisk{
		{Name: "root", Path: "/", TotalBytes: 10, UsedBytes: 4},
		{Name: "data", Path: "/data", Error: &timeout},
	} {
		encoded, err := Marshal(disk)
		if err != nil {
			t.Fatalf("Marshal %q: %v", disk.Name, err)
		}
		var got MetricsDisk
		if err := Unmarshal(encoded, &got); err != nil {
			t.Fatalf("Unmarshal %q: %v", disk.Name, err)
		}
		if !reflect.DeepEqual(got, disk) {
			t.Fatalf("round trip = %#v, want %#v", got, disk)
		}
	}
	// An unknown branch is a decode error, not an ignored entry.
	raw, err := encMode.Marshal([]any{"maybe", []any{"root", "/"}})
	if err != nil {
		t.Fatal(err)
	}
	var disk MetricsDisk
	if err := Unmarshal(raw, &disk); err == nil {
		t.Fatal("accepted an unknown metrics disk tag")
	}
}

func TestUint64(t *testing.T) {
	for _, want := range []Uint64{0, 1, Uint64(MaxSafeInteger), Uint64(MaxSafeInteger) + 1, math.MaxUint64} {
		encoded, err := Marshal(want)
		if err != nil {
			t.Fatalf("Marshal %d: %v", want, err)
		}
		var got Uint64
		if err := Unmarshal(encoded, &got); err != nil {
			t.Fatalf("Unmarshal %d: %v", want, err)
		}
		if got != want {
			t.Fatalf("round trip = %d, want %d", got, want)
		}
	}
	var got Uint64
	if err := Unmarshal(mustHex(t, "20"), &got); err == nil {
		t.Fatal("accepted a negative integer as Uint64")
	}
	// The protocol uint still refuses values above 2^53-1, which is why Uint64 exists.
	if err := Unmarshal(mustHex(t, "1b0020000000000000"), new(Uint)); err == nil {
		t.Fatal("Uint accepted 2^53")
	}
	var metricsUint Uint64
	if err := Unmarshal(mustHex(t, "4820ffffffffffffffff"), &metricsUint); err == nil {
		// 0x48 is a byte string, not an unsigned integer.
		t.Fatal("Uint64 accepted a byte string")
	}
}
