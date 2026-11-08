package protocol

import (
	"bytes"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"math/big"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"

	"github.com/fxamacker/cbor/v2"
)

// This file keeps the previous multi-pass profile decoder as a test oracle. decodeAny is
// now a single pass, so comparing it with the old implementation over every frame fixture,
// golden vector and malformed input is what proves the two accept the same values with the
// same Go representation and reject the same inputs.

func decodeAnyLegacy(data []byte) (any, error) {
	var raw cbor.RawMessage
	rest, err := decMode.UnmarshalFirst(data, &raw)
	if err != nil {
		return nil, err
	}
	v, err := decodeProfileValueLegacy(raw)
	if err != nil {
		return nil, err
	}
	if len(rest) != 0 {
		return nil, fmt.Errorf("%d bytes of extraneous data", len(rest))
	}
	if err := validateProfileValueLegacy(v); err != nil {
		return nil, err
	}
	encoded, err := encMode.Marshal(v)
	if err != nil {
		return nil, fmt.Errorf("re-encode: %w", err)
	}
	if !bytes.Equal(encoded, data) {
		return nil, fmt.Errorf("non-canonical encoding: re-encoded as %x", encoded)
	}
	return v, nil
}

func decodeProfileValueLegacy(raw []byte) (any, error) {
	if len(raw) == 0 {
		return nil, errors.New("empty CBOR value")
	}
	switch raw[0] >> 5 {
	case 4: // array
		var elems []cbor.RawMessage
		if err := decMode.Unmarshal(raw, &elems); err != nil {
			return nil, err
		}
		values := make([]any, 0, len(elems))
		for _, elem := range elems {
			v, err := decodeProfileValueLegacy(elem)
			if err != nil {
				return nil, err
			}
			values = append(values, v)
		}
		return values, nil
	case 5: // map
		return decodeProfileMapLegacy(raw)
	default:
		var v any
		if err := decMode.Unmarshal(raw, &v); err != nil {
			return nil, err
		}
		return v, nil
	}
}

func decodeProfileMapLegacy(raw []byte) (profileMap, error) {
	n, headerLen, err := profileMapHeadLegacy(raw)
	if err != nil {
		return nil, err
	}
	if n > uint64(len(raw))/2 {
		return nil, fmt.Errorf("map declares %d pairs but the input is %d bytes", n, len(raw))
	}
	entries := make(profileMap, 0, int(n))
	rest := raw[headerLen:]
	for len(rest) > 0 {
		var rawKey, rawValue cbor.RawMessage
		if rest, err = decMode.UnmarshalFirst(rest, &rawKey); err != nil {
			return nil, err
		}
		if err := checkMapKeyType(rawKey); err != nil {
			return nil, err
		}
		if rest, err = decMode.UnmarshalFirst(rest, &rawValue); err != nil {
			return nil, err
		}
		key, err := decodeProfileValueLegacy(rawKey)
		if err != nil {
			return nil, err
		}
		value, err := decodeProfileValueLegacy(rawValue)
		if err != nil {
			return nil, err
		}
		entries = append(entries, profileMapEntry{key: key, value: value})
	}
	if uint64(len(entries)) != n {
		return nil, fmt.Errorf("map declares %d pairs but holds %d", n, len(entries))
	}
	return entries, nil
}

func profileMapHeadLegacy(raw []byte) (n uint64, headerLen int, err error) {
	switch ai := raw[0] & 0x1f; {
	case ai < 24:
		return uint64(ai), 1, nil
	case ai == 24:
		if len(raw) < 2 {
			return 0, 0, errors.New("truncated map header")
		}
		return uint64(raw[1]), 2, nil
	case ai == 25:
		if len(raw) < 3 {
			return 0, 0, errors.New("truncated map header")
		}
		return uint64(raw[1])<<8 | uint64(raw[2]), 3, nil
	case ai == 26:
		if len(raw) < 5 {
			return 0, 0, errors.New("truncated map header")
		}
		return uint64(raw[1])<<24 | uint64(raw[2])<<16 | uint64(raw[3])<<8 | uint64(raw[4]), 5, nil
	case ai == 27:
		if len(raw) < 9 {
			return 0, 0, errors.New("truncated map header")
		}
		var value uint64
		for _, b := range raw[1:9] {
			value = value<<8 | uint64(b)
		}
		return value, 9, nil
	default:
		return 0, 0, errors.New("map must have a definite length")
	}
}

func validateProfileValueLegacy(v any) error {
	switch v := v.(type) {
	case nil, bool, uint64, int64, string, []byte, *big.Int, big.Int:
		return nil
	case float32, float64:
		return errors.New("floats are not allowed")
	case []any:
		for _, elem := range v {
			if err := validateProfileValueLegacy(elem); err != nil {
				return err
			}
		}
		return nil
	case profileMap:
		for _, pair := range v {
			if !profileMapKeyLegacy(pair.key) {
				return errMapKeyType
			}
			if err := validateProfileValueLegacy(pair.value); err != nil {
				return err
			}
		}
		return nil
	case cbor.SimpleValue:
		return fmt.Errorf("simple value %d is not allowed", v)
	default:
		return fmt.Errorf("unexpected CBOR value of type %T", v)
	}
}

func profileMapKeyLegacy(key any) bool {
	switch key.(type) {
	case string, uint64, int64, *big.Int, big.Int:
		return true
	default:
		return false
	}
}

// TestDecodeAnyMatchesLegacy runs every positive and negative frame fixture and every
// golden profile vector through both decoders. Acceptance, rejection and the decoded Go
// value must agree; error texts are not part of the wire contract.
func TestDecodeAnyMatchesLegacy(t *testing.T) {
	type fixture struct {
		Positive []struct {
			ID  string `json:"id"`
			Hex string `json:"hex"`
		} `json:"positive"`
		Negative []struct {
			ID  string `json:"id"`
			Hex string `json:"hex"`
		} `json:"negative"`
	}
	var frames fixture
	frameData, err := os.ReadFile(filepath.Join("..", "..", "..", "test", "interop", "crh_frames.json"))
	if err != nil {
		t.Fatalf("read frames fixture: %v", err)
	}
	if err := json.Unmarshal(frameData, &frames); err != nil {
		t.Fatalf("parse frames fixture: %v", err)
	}
	var vectors goldenVectors
	vectorData, err := os.ReadFile(filepath.Join("..", "..", "..", "test", "interop", "cbor_core_golden_vectors.json"))
	if err != nil {
		t.Fatalf("read golden vectors: %v", err)
	}
	if err := json.Unmarshal(vectorData, &vectors); err != nil {
		t.Fatalf("parse golden vectors: %v", err)
	}

	check := func(t *testing.T, name, rawHex string) {
		t.Helper()
		raw, err := hex.DecodeString(rawHex)
		if err != nil {
			t.Fatalf("%s: bad hex: %v", name, err)
		}
		got, gotErr := decodeAny(raw)
		want, wantErr := decodeAnyLegacy(raw)
		if (gotErr == nil) != (wantErr == nil) {
			t.Fatalf("%s: new decode error = %v, legacy decode error = %v", name, gotErr, wantErr)
		}
		if gotErr == nil && !reflect.DeepEqual(got, want) {
			t.Fatalf("%s: decoded value mismatch:\n new %#v\n old %#v", name, got, want)
		}
	}

	for _, entry := range frames.Positive {
		t.Run("frames/positive/"+entry.ID, func(t *testing.T) { check(t, entry.ID, entry.Hex) })
	}
	for _, entry := range frames.Negative {
		t.Run("frames/negative/"+entry.ID, func(t *testing.T) { check(t, entry.ID, entry.Hex) })
	}
	for _, entry := range vectors.Positive {
		t.Run("vectors/positive/"+entry.ID, func(t *testing.T) { check(t, entry.ID, entry.Hex) })
	}
	for _, entry := range vectors.Negative {
		t.Run("vectors/negative/"+entry.ID, func(t *testing.T) { check(t, entry.ID, entry.Hex) })
	}

	// Malformed inputs the fixtures do not carry: each must be rejected by both decoders.
	malformed := []struct{ name, hex string }{
		{"empty", ""},
		{"truncated uint", "18"},
		{"truncated array", "82"},
		{"truncated map", "a16161"},
		{"truncated bytes", "43 00 01"},
		{"truncated text", "63 61 62"},
		{"extraneous data", "00 00"},
		{"non-minimal uint", "18 00"},
		{"non-minimal uint16", "19 00 ff"},
		{"non-minimal uint32", "1a 00 00 ff ff"},
		{"non-minimal uint64", "1b 00 00 00 00 ff ff ff ff"},
		{"non-minimal negative", "38 00"},
		{"non-minimal text length", "78 01 61 78"},
		{"non-minimal array length", "98 01 01"},
		{"non-minimal map length", "b8 01 61 61 01"},
		{"indefinite array", "9f 01 ff"},
		{"indefinite map", "bf 61 61 01 ff"},
		{"break", "ff"},
		{"tag", "c0 00"},
		{"self-describe tag", "d9 d9 f7 00"},
		{"bignum tag", "c2 42 01 00"},
		{"float16", "f9 3c 00"},
		{"float32", "fa 3f 80 00 00"},
		{"float64", "fb 3f f0 00 00 00 00 00 00"},
		{"NaN", "f9 7e 00"},
		{"infinity", "f9 7c 00"},
		{"undefined", "f7"},
		{"simple value", "e0"},
		{"two-byte simple value", "f8 ff"},
		{"non-minimal false", "f8 14"},
		{"invalid utf8", "61 ff"},
		{"bytes map key", "a1 41 00 01"},
		{"array map key", "a1 81 00 01"},
		{"map map key", "a1 a1 61 61 01 02"},
		{"bool map key", "a1 f5 01"},
		{"null map key", "a1 f6 01"},
		{"duplicate map key", "a2 61 61 01 61 61 02"},
		{"unsorted map keys", "a2 61 62 01 61 61 02"},
		{"too deeply nested", strings.Repeat("81", 65) + "01"},
	}
	for _, test := range malformed {
		t.Run("malformed/"+test.name, func(t *testing.T) {
			raw, err := hex.DecodeString(strings.ReplaceAll(test.hex, " ", ""))
			if err != nil {
				t.Fatalf("bad hex: %v", err)
			}
			if got, err := decodeAny(raw); err == nil {
				t.Fatalf("single-pass decode accepted %x: %#v", raw, got)
			}
			if _, err := decodeAnyLegacy(raw); err == nil {
				t.Fatalf("oracle accepted %x", raw)
			}
		})
	}
}

// TestDecodeAnyContainerLimits covers the container caps decMode enforced before the
// decoded value was built: exactly the cap is accepted, one more is rejected.
func TestDecodeAnyContainerLimits(t *testing.T) {
	check := func(t *testing.T, name string, raw []byte, wantOK bool) {
		t.Helper()
		got, err := decodeAny(raw)
		if (err == nil) != wantOK {
			t.Fatalf("%s: decodeAny error = %v, want accepted = %v", name, err, wantOK)
		}
		if _, legacyErr := decodeAnyLegacy(raw); (legacyErr == nil) != wantOK {
			t.Fatalf("%s: legacy error = %v, want accepted = %v", name, legacyErr, wantOK)
		}
		if wantOK && got == nil {
			t.Fatalf("%s: accepted with a nil value", name)
		}
	}

	array := func(n int) []byte {
		raw, err := encMode.Marshal(make([]uint64, n))
		if err != nil {
			t.Fatalf("marshal %d-element array: %v", n, err)
		}
		return raw
	}
	check(t, "array at the limit", array(maxProfileArrayElements), true)
	check(t, "array over the limit", array(maxProfileArrayElements+1), false)

	mapping := func(n int) []byte {
		pairs := make(map[uint64]uint64, n)
		for i := range n {
			pairs[uint64(i)] = 0
		}
		raw, err := encMode.Marshal(pairs)
		if err != nil {
			t.Fatalf("marshal %d-pair map: %v", n, err)
		}
		return raw
	}
	check(t, "map at the limit", mapping(maxProfileMapPairs), true)
	check(t, "map over the limit", mapping(maxProfileMapPairs+1), false)
}

// TestDecodeAnyRepresentativeValues pins the Go representation for each kind of value the
// profile can carry, independently of the legacy oracle.
func TestDecodeAnyRepresentativeValues(t *testing.T) {
	bigNegative, _ := new(big.Int).SetString("-18446744073709551616", 10)
	tests := []struct {
		name string
		hex  string
		want any
	}{
		{"uint", "00", uint64(0)},
		{"max uint64", "1bffffffffffffffff", uint64(^uint64(0))},
		{"negative", "20", int64(-1)},
		{"min int64", "3b7fffffffffffffff", int64(-1 << 63)},
		{"below min int64", "3bffffffffffffffff", bigNegative},
		{"false", "f4", false},
		{"true", "f5", true},
		{"null", "f6", nil},
		{"text", "61 61", "a"},
		{"bytes", "42 00 ff", []byte{0x00, 0xff}},
		{"array", "82 01 61 61", []any{uint64(1), "a"}},
		{"map", "a2 61 61 01 61 62 02", profileMap{{key: "a", value: uint64(1)}, {key: "b", value: uint64(2)}}},
		{"nested", "81 a1 01 82 02 03", []any{profileMap{{key: uint64(1), value: []any{uint64(2), uint64(3)}}}}},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			raw, err := hex.DecodeString(strings.ReplaceAll(test.hex, " ", ""))
			if err != nil {
				t.Fatalf("bad hex: %v", err)
			}
			got, err := decodeAny(raw)
			if err != nil {
				t.Fatalf("decode: %v", err)
			}
			if !reflect.DeepEqual(got, test.want) {
				t.Fatalf("got %#v, want %#v", got, test.want)
			}
		})
	}
}
