package protocol

import (
	"encoding/hex"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"unicode/utf8"

	"github.com/fxamacker/cbor/v2"
)

type goldenVectors struct {
	Profile  string `json:"profile"`
	Positive []struct {
		ID             string `json:"id"`
		Description    string `json:"description"`
		Diagnostic     string `json:"diagnostic"`
		Hex            string `json:"hex"`
		LengthFirstHex string `json:"length_first_hex"`
	} `json:"positive"`
	Negative []struct {
		ID           string `json:"id"`
		Hex          string `json:"hex"`
		RejectReason string `json:"reject_reason"`
	} `json:"negative"`
}

func mustHex(t *testing.T, s string) []byte {
	t.Helper()
	b, err := hex.DecodeString(s)
	if err != nil {
		t.Fatalf("bad test hex %q: %v", s, err)
	}
	return b
}

// TestProfileGoldenVectors runs test/interop/cbor_core_golden_vectors.json, the shared
// profile fixture.
func TestProfileGoldenVectors(t *testing.T) {
	path := filepath.Join("..", "..", "..", "test", "interop", "cbor_core_golden_vectors.json")
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read %s: %v", path, err)
	}
	var vectors goldenVectors
	if err := json.Unmarshal(data, &vectors); err != nil {
		t.Fatalf("parse %s: %v", path, err)
	}
	if vectors.Profile != "CBOR-CORE-INT-v1" {
		t.Fatalf("profile = %q, want CBOR-CORE-INT-v1", vectors.Profile)
	}

	for _, vector := range vectors.Positive {
		t.Run("positive/"+vector.ID, func(t *testing.T) {
			raw := mustHex(t, vector.Hex)
			value, err := decodeAny(raw)
			if err != nil {
				t.Fatalf("%s (%s): decode rejected: %v", vector.Diagnostic, vector.Description, err)
			}
			encoded, err := Marshal(value)
			if err != nil {
				t.Fatalf("re-encode: %v", err)
			}
			if got := hex.EncodeToString(encoded); got != vector.Hex {
				t.Fatalf("re-encoded as %s, want %s", got, vector.Hex)
			}
		})
	}

	for _, vector := range vectors.Negative {
		t.Run("negative/"+vector.ID, func(t *testing.T) {
			raw := mustHex(t, vector.Hex)
			_, err := decodeAny(raw)
			if err == nil && vector.ID == "unknown_field" {
				// This vector is not a profile violation: {99: 1} is canonical
				// CBOR. Its reject_reason explicitly scopes rejection to a schema
				// that knows fields 1..3, so exercise it at that layer instead.
				err = rejectsUnknownField(raw)
			}
			if err == nil {
				t.Fatalf("accepted: %s", vector.RejectReason)
			}
		})
	}
}

// rejectsUnknownField is the schema-level check for the golden vector
// "unknown_field": decode {99: 1} into a schema that knows fields 1..3.
func rejectsUnknownField(raw []byte) error {
	mode, err := cbor.DecOptions{
		ExtraReturnErrors: cbor.ExtraDecErrorUnknownField,
	}.DecMode()
	if err != nil {
		return err
	}
	var value struct {
		One   Uint `cbor:"1,keyasint"`
		Two   Uint `cbor:"2,keyasint"`
		Three Uint `cbor:"3,keyasint"`
	}
	return mode.Unmarshal(raw, &value)
}

// TestProfileRejections covers profile restrictions that are not in the golden fixture.
func TestProfileRejections(t *testing.T) {
	for _, test := range []struct {
		name string
		hex  string
	}{
		{"custom simple value 0", "e0"},
		{"custom simple value 255", "f8ff"},
		{"invalid two-byte simple value", "f800"},
		{"undefined", "f7"},
		{"NaN", "f97e00"},
		{"infinity", "f97c00"},
		{"bignum tag", "c24100"},
		{"self describe tag", "d9d9f700"},
		{"duplicate keys", "a201020103"},
		{"nonminimal text length", "78016178"},
	} {
		t.Run(test.name, func(t *testing.T) {
			if _, err := decodeAny(mustHex(t, test.hex)); err == nil {
				t.Fatalf("accepted %s", test.hex)
			}
		})
	}
}

// TestProfileMapKeys covers the CBOR-CORE-INT-v1 map key rule at the profile level: a key
// must be a text string or an integer, including the full uint64 and negative ranges.
func TestProfileMapKeys(t *testing.T) {
	for _, test := range []struct {
		name string
		hex  string
	}{
		{"text", "a1616101"},
		{"max uint64", "a11bffffffffffffffff01"},
		{"min int64", "a13b7fffffffffffffff01"},
		{"max negative", "a13bffffffffffffffff01"},
	} {
		t.Run(test.name, func(t *testing.T) {
			value, err := decodeAny(mustHex(t, test.hex))
			if err != nil {
				t.Fatalf("decode: %v", err)
			}
			encoded, err := Marshal(value)
			if err != nil {
				t.Fatalf("re-encode: %v", err)
			}
			if got := hex.EncodeToString(encoded); got != test.hex {
				t.Fatalf("re-encoded as %s, want %s", got, test.hex)
			}
		})
	}

	for _, test := range []struct {
		name string
		hex  string
	}{
		{"byte string", "a1410001"},
		{"array", "a1810001"},
		{"map", "a1a00001"},
		{"map with one key", "a1a1010001"},
		{"bool", "a1f501"},
		{"null", "a1f601"},
		{"nested byte string", "81a1410001"},
	} {
		t.Run(test.name, func(t *testing.T) {
			_, err := decodeAny(mustHex(t, test.hex))
			if err == nil {
				t.Fatalf("accepted a map with a %s key", test.name)
			}
			if !strings.Contains(err.Error(), "map key must be text or integer") {
				t.Fatalf("error = %v, want a map key type error", err)
			}
		})
	}
}

// TestProfileMapHeaders round-trips maps across the one-, two-, three- and five-byte
// header sizes of profileMap's own encoder.
func TestProfileMapHeaders(t *testing.T) {
	for _, n := range []int{0, 23, 24, 255, 256} {
		value := make(map[uint64]uint64, n)
		for i := 0; i < n; i++ {
			value[uint64(i)] = uint64(i)
		}
		data, err := Marshal(value)
		if err != nil {
			t.Fatalf("%d entries: Marshal: %v", n, err)
		}
		decoded, err := decodeAny(data)
		if err != nil {
			t.Fatalf("%d entries: decode: %v", n, err)
		}
		encoded, err := Marshal(decoded)
		if err != nil {
			t.Fatalf("%d entries: re-encode: %v", n, err)
		}
		if got, want := hex.EncodeToString(encoded), hex.EncodeToString(data); got != want {
			t.Fatalf("%d entries: re-encoded as %s, want %s", n, got, want)
		}
	}
}

// boolMapMarshaler is a self-encoding value whose encoded form has a forbidden map key,
// so Marshal must validate its output as well as plain Go maps.
type boolMapMarshaler struct{}

func (boolMapMarshaler) MarshalCBOR() ([]byte, error) {
	return encMode.Marshal(map[bool]uint64{true: 1})
}

// TestMarshalMapKeyTypes applies the same map key rule to the encode path, which must
// reject a map the profile decoder would refuse instead of emitting it.
func TestMarshalMapKeyTypes(t *testing.T) {
	for _, test := range []struct {
		name  string
		value any
		hex   string
	}{
		{"text", map[string]uint64{"a": 1}, "a1616101"},
		{"max uint64", map[uint64]uint64{^uint64(0): 1}, "a11bffffffffffffffff01"},
		{"min int64", map[int64]uint64{-1 << 63: 1}, "a13b7fffffffffffffff01"},
	} {
		t.Run(test.name, func(t *testing.T) {
			encoded, err := Marshal(test.value)
			if err != nil {
				t.Fatalf("Marshal: %v", err)
			}
			if got := hex.EncodeToString(encoded); got != test.hex {
				t.Fatalf("encoded as %s, want %s", got, test.hex)
			}
		})
	}

	for _, test := range []struct {
		name  string
		value any
	}{
		{"bool", map[bool]uint64{true: 1}},
		{"array", map[[1]uint64]uint64{{1}: 1}},
		{"byte string", map[cbor.ByteString]uint64{"\x00": 1}},
		{"nil", map[any]uint64{nil: 1}},
		{"nil pointer", map[*Uint]uint64{nil: 1}},
		{"nested bool", []any{map[bool]uint64{true: 1}}},
		{"custom marshaler", boolMapMarshaler{}},
	} {
		t.Run(test.name, func(t *testing.T) {
			_, err := Marshal(test.value)
			if err == nil {
				t.Fatalf("Marshal accepted a %s map key", test.name)
			}
			if !strings.Contains(err.Error(), "map key must be text or integer") {
				t.Fatalf("error = %v, want a map key type error", err)
			}
		})
	}
}

func TestCleanText(t *testing.T) {
	if got, want := CleanText("ok\xffbad"), "ok\uFFFDbad"; got != want {
		t.Fatalf("CleanText = %q, want %q", got, want)
	}
	if got := CleanText("already valid"); got != "already valid" {
		t.Fatalf("CleanText changed valid text to %q", got)
	}
}

func TestErrorMessage(t *testing.T) {
	if got, want := ErrorMessage("ok\xffbad"), "ok\uFFFDbad"; got != want {
		t.Fatalf("ErrorMessage = %q, want %q", got, want)
	}
	long := ErrorMessage(strings.Repeat("a", 4*MaxErrorMessageBytes))
	if len(long) != MaxErrorMessageBytes {
		t.Fatalf("ErrorMessage kept %d bytes, want %d", len(long), MaxErrorMessageBytes)
	}
	// A multi-byte rune straddling the limit is dropped, not split.
	straddle := strings.Repeat("a", MaxErrorMessageBytes-1) + "é" + strings.Repeat("a", 10)
	got := ErrorMessage(straddle)
	if len(got) != MaxErrorMessageBytes-1 {
		t.Fatalf("ErrorMessage kept %d bytes, want %d", len(got), MaxErrorMessageBytes-1)
	}
	if !utf8.ValidString(got) {
		t.Fatalf("ErrorMessage produced invalid UTF-8: %q", got)
	}
}

func TestMarshalRejectsInvalidUTF8(t *testing.T) {
	const bad = "bad\xff"
	tests := []struct {
		name  string
		value any
	}{
		{"nested field", TaskStart{
			TaskID: "t",
			Spec: TaskSpec{Kind: TaskSpecExec, Exec: &ExecSpec{
				Command: Command{Kind: CommandArgv, Argv: []string{"true"}},
				Env:     map[string]string{"A": "1"},
				Cwd:     bad,
			}},
			Output: OutputMode{Kind: OutputText},
		}},
		{"env key", ExecSpec{
			Command: Command{Kind: CommandArgv, Argv: []string{"true"}},
			Env:     map[string]string{bad: "value"},
		}},
		{"env value", ExecSpec{
			Command: Command{Kind: CommandArgv, Argv: []string{"true"}},
			Env:     map[string]string{"KEY": bad},
		}},
		{"string slice element", Facts{
			Hostname:        "node-1",
			PackageManagers: []string{"apt", bad},
		}},
		{"error message", Error{Code: "internal_error", Message: bad}},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			if _, err := Marshal(test.value); err == nil {
				t.Fatalf("Marshal accepted invalid UTF-8 in %s", test.name)
			}
		})
	}
}

func TestUintRange(t *testing.T) {
	t.Run("max", func(t *testing.T) {
		var u Uint
		if err := Unmarshal(mustHex(t, "1b001fffffffffffff"), &u); err != nil {
			t.Fatalf("Unmarshal: %v", err)
		}
		if u != MaxSafeInteger {
			t.Fatalf("u = %d, want %d", u, MaxSafeInteger)
		}
	})
	for _, test := range []struct {
		name string
		hex  string
	}{
		{"over 2^53-1", "1b0020000000000000"},
		{"max uint64", "1bffffffffffffffff"},
		{"negative", "20"},
		{"float", "f93c00"},
		{"text", "6161"},
	} {
		t.Run(test.name, func(t *testing.T) {
			var u Uint
			if err := Unmarshal(mustHex(t, test.hex), &u); err == nil {
				t.Fatalf("accepted %s as uint %d", test.hex, u)
			}
		})
	}
}

func TestIntRange(t *testing.T) {
	var i Int
	if err := Unmarshal(mustHex(t, "3b001ffffffffffffe"), &i); err != nil { // -(2^53-1)
		t.Fatalf("min: %v", err)
	}
	if i != Int(-MaxSafeInteger) {
		t.Fatalf("i = %d", i)
	}
	if err := Unmarshal(mustHex(t, "1b001fffffffffffff"), &i); err != nil {
		t.Fatalf("max: %v", err)
	}
	if i != MaxSafeInteger {
		t.Fatalf("i = %d", i)
	}
	for _, test := range []struct {
		name string
		hex  string
	}{
		{"over 2^53-1", "1b0020000000000000"},
		{"below -2^53-1", "3b0020000000000000"},
		{"max uint64", "1bffffffffffffffff"},
		{"float", "f93c00"},
	} {
		t.Run(test.name, func(t *testing.T) {
			var i Int
			if err := Unmarshal(mustHex(t, test.hex), &i); err == nil {
				t.Fatalf("accepted %s as int %d", test.hex, i)
			}
		})
	}
}

func TestHashSize(t *testing.T) {
	good := "82015820" + repeatHex("00", HashSize)
	var ref InputRef
	if err := Unmarshal(mustHex(t, good), &ref); err != nil {
		t.Fatalf("32-byte digest: %v", err)
	}
	encoded, err := Marshal(ref)
	if err != nil {
		t.Fatalf("Marshal: %v", err)
	}
	if got := hex.EncodeToString(encoded); got != good {
		t.Fatalf("re-encoded %s, want %s", got, good)
	}
	for _, size := range []int{0, 31, 33, 64} {
		t.Run(fmt.Sprintf("%d-bytes", size), func(t *testing.T) {
			raw, err := encMode.Marshal([]any{uint64(0), make([]byte, size)})
			if err != nil {
				t.Fatalf("Marshal: %v", err)
			}
			var ref InputRef
			if err := Unmarshal(raw, &ref); err == nil {
				t.Fatalf("accepted %d-byte digest", size)
			}
		})
	}
}

func repeatHex(s string, n int) string {
	out := ""
	for i := 0; i < n; i++ {
		out += s
	}
	return out
}

func TestPeekMajor(t *testing.T) {
	init := HandshakeInit{
		ProtocolMajor: ProtocolMajor,
		ProtocolMinor: ProtocolMinor,
		Commands:      []string{CmdHello},
		CRHAVersion:   "test",
		ClientTimeMS:  1,
	}
	raw, err := Marshal(init)
	if err != nil {
		t.Fatalf("Marshal: %v", err)
	}
	major, err := PeekMajor(raw)
	if err != nil {
		t.Fatalf("PeekMajor: %v", err)
	}
	if major != ProtocolMajor {
		t.Fatalf("major = %d, want %d", major, ProtocolMajor)
	}
	// A future major version may have a different payload shape after the first
	// element; PeekMajor must not decode it.
	future := append([]byte{0x86, 0x02, 0x00}, mustHex(t, "80")...)
	major, err = PeekMajor(future)
	if err != nil || major != 2 {
		t.Fatalf("future major = %d, err = %v", major, err)
	}
	for _, test := range []struct {
		name string
		hex  string
	}{
		{"empty", ""},
		{"not an array", "01"},
		{"indefinite array", "9f01ff"},
		{"no first element", "80"},
		{"truncated", "81"},
	} {
		t.Run(test.name, func(t *testing.T) {
			if _, err := PeekMajor(mustHex(t, test.hex)); err == nil {
				t.Fatalf("accepted %s", test.hex)
			}
		})
	}
}

func TestPeekMajorArrayHeaders(t *testing.T) {
	// Each payload declares a larger array than it contains: PeekMajor only reads the
	// array header and the first element, so the missing trailing elements do not matter.
	for _, test := range []struct {
		name string
		hex  string
	}{
		{"length 6", "86010000"},
		{"length 24", "9818010000"},
		{"length 300", "99012c010000"},
		{"length 70000", "9a00011170010000"},
		{"later element is a float", "8201f93e00"},
	} {
		t.Run(test.name, func(t *testing.T) {
			major, err := PeekMajor(mustHex(t, test.hex))
			if err != nil {
				t.Fatalf("PeekMajor: %v", err)
			}
			if major != ProtocolMajor {
				t.Fatalf("major = %d, want %d", major, ProtocolMajor)
			}
		})
	}

	for _, test := range []struct {
		name string
		hex  string
	}{
		{"empty input", ""},
		{"empty array", "80"},
		{"empty array with trailing bytes", "8001"},
		{"header-only 24-bit array", "9901"},
	} {
		t.Run(test.name, func(t *testing.T) {
			if _, err := PeekMajor(mustHex(t, test.hex)); err == nil {
				t.Fatalf("accepted %s", test.hex)
			}
		})
	}
}
