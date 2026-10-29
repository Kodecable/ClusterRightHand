package protocol

import (
	"bytes"
	"encoding/binary"
	"errors"
	"fmt"
	"math/big"
	"reflect"
	"strings"
	"unicode/utf8"

	"github.com/fxamacker/cbor/v2"
)

// HashSize is the length of an InputRef SHA-256 digest.
const HashSize = 32

var (
	encMode = mustEncMode()
	decMode = mustDecMode()
)

// mustEncMode builds the CBOR-CORE-INT-v1 encoder: RFC 8949 §4.2.1 core deterministic
// encoding (bytewise lexicographic map keys, not length-first), no tags, no indefinite
// lengths, and nil slices/maps as empty containers (the wire schema has no optional
// collections, only nullable pointers).
func mustEncMode() cbor.EncMode {
	opts := cbor.CoreDetEncOptions()
	opts.IndefLength = cbor.IndefLengthForbidden
	opts.TagsMd = cbor.TagsForbidden
	opts.NilContainers = cbor.NilContainerAsEmpty
	em, err := opts.EncMode()
	if err != nil {
		panic("protocol: build CBOR encoder: " + err.Error())
	}
	return em
}

// mustDecMode builds the strict decoder used for every protocol value. The profile
// rejects duplicate map keys, indefinite lengths, tags (including bignum tags), floats'
// non-finite values, invalid UTF-8, undefined and custom simple values, and trailing
// bytes. Finite floats are rejected separately because fxamacker has no "no float"
// option; see validateProfileValue.
func mustDecMode() cbor.DecMode {
	reject := make([]func(*cbor.SimpleValueRegistry) error, 0, 253)
	for sv := 0; sv <= 255; sv++ {
		switch {
		case sv >= 24 && sv <= 31: // reserved, not well-formed
			continue
		case sv == 20 || sv == 21 || sv == 22: // false, true, null
			continue
		}
		reject = append(reject, cbor.WithRejectedSimpleValue(cbor.SimpleValue(sv)))
	}
	simpleValues, err := cbor.NewSimpleValueRegistryFromDefaults(reject...)
	if err != nil {
		panic("protocol: build CBOR simple value registry: " + err.Error())
	}
	opts := cbor.DecOptions{
		DupMapKey:       cbor.DupMapKeyEnforcedAPF,
		IndefLength:     cbor.IndefLengthForbidden,
		TagsMd:          cbor.TagsForbidden,
		UTF8:            cbor.UTF8RejectInvalid,
		BignumTag:       cbor.BignumTagForbidden,
		IntDec:          cbor.IntDecConvertNone,
		BigIntDec:       cbor.BigIntDecodePointer,
		NaN:             cbor.NaNDecodeForbidden,
		Inf:             cbor.InfDecodeForbidden,
		SimpleValues:    simpleValues,
		MaxNestedLevels: 64,
	}
	dm, err := opts.DecMode()
	if err != nil {
		panic("protocol: build CBOR decoder: " + err.Error())
	}
	return dm
}

// CleanText replaces every invalid UTF-8 byte in s with the Unicode replacement
// character U+FFFD. Callers use it to sanitize external text (/etc/os-release fields,
// group names, OS error messages that contain a path, and so on) before putting it in a
// wire struct: the encoder rejects invalid UTF-8, and a frame carrying it would make the
// receiver close the connection.
func CleanText(s string) string { return strings.ToValidUTF8(s, "�") }

// maxTextDepth bounds validateTextValue's recursion. The wire schema nests far below it;
// the limit only prevents a cyclic caller-supplied value from overflowing the stack.
const maxTextDepth = 128

// validateTextValue reports an error if any Go string reachable from v is not valid
// UTF-8. It walks the same shape the CBOR encoder walks: exported struct fields, pointers,
// interfaces, arrays, slices and maps (keys and values). Byte slices and byte arrays are
// wire "bytes" values and may contain arbitrary bytes.
func validateTextValue(v any) error {
	return validateText(reflect.ValueOf(v), 0)
}

func validateText(v reflect.Value, depth int) error {
	if !v.IsValid() {
		return nil
	}
	if depth > maxTextDepth {
		return errors.New("value nests too deeply")
	}
	switch v.Kind() {
	case reflect.String:
		if !utf8.ValidString(v.String()) {
			return fmt.Errorf("invalid UTF-8 text %q", v.String())
		}
	case reflect.Interface, reflect.Pointer:
		if v.IsNil() {
			return nil
		}
		return validateText(v.Elem(), depth+1)
	case reflect.Struct:
		typ := v.Type()
		for i := 0; i < v.NumField(); i++ {
			if typ.Field(i).PkgPath != "" {
				continue // unexported fields are not encoded
			}
			if err := validateText(v.Field(i), depth+1); err != nil {
				return err
			}
		}
	case reflect.Array, reflect.Slice:
		if v.Type().Elem().Kind() == reflect.Uint8 {
			return nil
		}
		for i := 0; i < v.Len(); i++ {
			if err := validateText(v.Index(i), depth+1); err != nil {
				return err
			}
		}
	case reflect.Map:
		iter := v.MapRange()
		for iter.Next() {
			if err := validateText(iter.Key(), depth+1); err != nil {
				return err
			}
			if err := validateText(iter.Value(), depth+1); err != nil {
				return err
			}
		}
	}
	return nil
}

// Marshal encodes v with the protocol's deterministic encoder. It rejects any text value
// that is not valid UTF-8 before encoding, as doc/protocol.md requires of the sender.
func Marshal(v any) ([]byte, error) {
	if err := validateTextValue(v); err != nil {
		return nil, fmt.Errorf("protocol: encode: %w", err)
	}
	data, err := encMode.Marshal(v)
	if err != nil {
		return nil, fmt.Errorf("protocol: encode: %w", err)
	}
	return data, nil
}

// Unmarshal strictly decodes one protocol value into v. It applies the CBOR profile,
// checks the schema while decoding, and finally re-encodes the decoded value and
// compares it byte-for-byte with data. Any failure is a *ProtocolError.
func Unmarshal(data []byte, v any) error {
	if _, err := decodeAny(data); err != nil {
		return &ProtocolError{Err: fmt.Errorf("decode: %w", err)}
	}
	if err := decMode.Unmarshal(data, v); err != nil {
		return &ProtocolError{Err: fmt.Errorf("decode: %w", err)}
	}
	encoded, err := Marshal(v)
	if err != nil {
		return &ProtocolError{Err: fmt.Errorf("re-encode: %w", err)}
	}
	if !bytes.Equal(encoded, data) {
		return &ProtocolError{Err: fmt.Errorf("non-canonical encoding: re-encoded as %x", encoded)}
	}
	return nil
}

// decodeAny decodes one value according to the CBOR profile and verifies that
// re-encoding it reproduces the input exactly. It is the profile-level codec used by
// the golden vector tests and as Unmarshal's first stage.
func decodeAny(data []byte) (any, error) {
	var v any
	if err := decMode.Unmarshal(data, &v); err != nil {
		return nil, err
	}
	if err := validateProfileValue(v); err != nil {
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

// validateProfileValue rejects CBOR values the profile does not allow but the decoder
// would otherwise accept: floats (finite ones) and custom simple values.
func validateProfileValue(v any) error {
	switch v := v.(type) {
	case nil, bool, uint64, int64, string, []byte, *big.Int, big.Int:
		return nil
	case float32, float64:
		return errors.New("floats are not allowed")
	case []any:
		for _, elem := range v {
			if err := validateProfileValue(elem); err != nil {
				return err
			}
		}
		return nil
	case map[any]any:
		for key, elem := range v {
			if err := validateProfileValue(key); err != nil {
				return err
			}
			if err := validateProfileValue(elem); err != nil {
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

// PeekMajor returns the first element (protocol_major) of a handshake payload without
// decoding the rest. A receiver that sees an unsupported major version must not try to
// parse the remaining fields, which may belong to a later version.
func PeekMajor(payload []byte) (Uint, error) {
	if len(payload) == 0 {
		return 0, errors.New("protocol: empty handshake payload")
	}
	head := payload[0]
	if head&0xe0 != 0x80 {
		return 0, errors.New("protocol: handshake payload is not an array")
	}
	var headerLen int
	var arrayLen uint64
	switch ai := head & 0x1f; {
	case ai < 24:
		headerLen = 1
		arrayLen = uint64(ai)
	case ai == 24:
		headerLen = 2
		if len(payload) < headerLen {
			return 0, errors.New("protocol: handshake payload has no protocol_major")
		}
		arrayLen = uint64(payload[1])
	case ai == 25:
		headerLen = 3
		if len(payload) < headerLen {
			return 0, errors.New("protocol: handshake payload has no protocol_major")
		}
		arrayLen = uint64(binary.BigEndian.Uint16(payload[1:3]))
	case ai == 26:
		headerLen = 5
		if len(payload) < headerLen {
			return 0, errors.New("protocol: handshake payload has no protocol_major")
		}
		arrayLen = uint64(binary.BigEndian.Uint32(payload[1:5]))
	case ai == 27:
		headerLen = 9
		if len(payload) < headerLen {
			return 0, errors.New("protocol: handshake payload has no protocol_major")
		}
		arrayLen = binary.BigEndian.Uint64(payload[1:9])
	default:
		return 0, errors.New("protocol: handshake payload is not a definite-length array")
	}
	if arrayLen == 0 || len(payload) <= headerLen {
		return 0, errors.New("protocol: handshake payload has no protocol_major")
	}
	var major Uint
	if _, err := decMode.UnmarshalFirst(payload[headerLen:], &major); err != nil {
		return 0, fmt.Errorf("protocol: decode protocol_major: %w", err)
	}
	return major, nil
}

// Uint is a protocol uint: an unsigned integer in [0, 2^53-1].
type Uint uint64

func (u Uint) MarshalCBOR() ([]byte, error) {
	if uint64(u) > MaxSafeInteger {
		return nil, fmt.Errorf("protocol: uint %d exceeds 2^53-1", uint64(u))
	}
	return encMode.Marshal(uint64(u))
}

func (u *Uint) UnmarshalCBOR(data []byte) error {
	var n uint64
	if err := decMode.Unmarshal(data, &n); err != nil {
		return err
	}
	if n > MaxSafeInteger {
		return fmt.Errorf("protocol: uint %d exceeds 2^53-1", n)
	}
	*u = Uint(n)
	return nil
}

// Int is a protocol int: a signed integer with |n| <= 2^53-1.
type Int int64

func (i Int) MarshalCBOR() ([]byte, error) {
	n := int64(i)
	if n > MaxSafeInteger || n < -MaxSafeInteger {
		return nil, fmt.Errorf("protocol: int %d exceeds 2^53-1 in magnitude", n)
	}
	return encMode.Marshal(n)
}

func (i *Int) UnmarshalCBOR(data []byte) error {
	var n int64
	if err := decMode.Unmarshal(data, &n); err != nil {
		return err
	}
	if n > MaxSafeInteger || n < -MaxSafeInteger {
		return fmt.Errorf("protocol: int %d exceeds 2^53-1 in magnitude", n)
	}
	*i = Int(n)
	return nil
}

// Hash is a SHA-256 digest carried as a CBOR byte string of exactly HashSize bytes.
type Hash [HashSize]byte

func (h Hash) MarshalCBOR() ([]byte, error) {
	return encMode.Marshal(h[:])
}

func (h *Hash) UnmarshalCBOR(data []byte) error {
	var b []byte
	if err := decMode.Unmarshal(data, &b); err != nil {
		return err
	}
	if len(b) != HashSize {
		return fmt.Errorf("protocol: sha256 digest is %d bytes, want %d", len(b), HashSize)
	}
	copy(h[:], b)
	return nil
}

// marshalEnum encodes a validated enum text value.
func marshalEnum[T ~string](kind string, v T, valid func(T) bool) ([]byte, error) {
	if err := validateTextValue(string(v)); err != nil {
		return nil, err
	}
	if !valid(v) {
		return nil, fmt.Errorf("protocol: unknown %s %q", kind, string(v))
	}
	return encMode.Marshal(string(v))
}

// unmarshalEnum decodes an enum text value and rejects unknown values.
func unmarshalEnum[T ~string](kind string, data []byte, dst *T, valid func(T) bool) error {
	var s string
	if err := decMode.Unmarshal(data, &s); err != nil {
		return err
	}
	v := T(s)
	if !valid(v) {
		return fmt.Errorf("protocol: unknown %s %q", kind, s)
	}
	*dst = v
	return nil
}

// ProtocolError is a violation of the wire format: malformed CBOR, a schema mismatch,
// an unknown response id, an unexpected event, and so on. The receiver must close the
// connection and must not send an error response.
type ProtocolError struct{ Err error }

func (e *ProtocolError) Error() string {
	if e.Err == nil {
		return "protocol error"
	}
	return "protocol error: " + e.Err.Error()
}

func (e *ProtocolError) Unwrap() error { return e.Err }

func protocolErrorf(format string, args ...any) error {
	return &ProtocolError{Err: fmt.Errorf(format, args...)}
}
