package protocol

import (
	"bytes"
	"encoding/binary"
	"errors"
	"fmt"
	"math/big"
	"reflect"
	"sort"
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

// ErrorMessage prepares a sender-chosen Error.message for the wire: it sanitizes s like
// CleanText and then truncates it to MaxErrorMessageBytes, never splitting a rune. A message
// that embedded a path or argv quoted with %q can be megabytes long, and an error frame
// carrying it would exceed MaxFrameBytes; the receiver does not check the length, so every
// Error.message this package builds must go through ErrorMessage.
func ErrorMessage(s string) string {
	s = CleanText(s)
	if len(s) <= MaxErrorMessageBytes {
		return s
	}
	cut := MaxErrorMessageBytes
	for cut > 0 && !utf8.RuneStart(s[cut]) {
		cut--
	}
	return s[:cut]
}

// marshalerType is the CBOR interface a type implements when it encodes itself, such as the
// union types, whose MarshalCBOR encodes only the selected branch.
var marshalerType = reflect.TypeOf((*cbor.Marshaler)(nil)).Elem()

// maxTextDepth bounds validateTextValue's recursion. The wire schema nests far below it;
// the limit only prevents a cyclic caller-supplied value from overflowing the stack.
const maxTextDepth = 128

// validateTextValue reports an error if any Go string that will reach the wire from v is not
// valid UTF-8. It walks the same shape the CBOR encoder walks: exported struct fields, pointers,
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
	case reflect.Interface, reflect.Pointer:
		if v.IsNil() {
			return nil
		}
		return validateText(v.Elem(), depth+1)
	}
	// A value with its own encoder decides what reaches the wire: a union's MarshalCBOR, for
	// example, encodes one branch and ignores the fields of the other branches, so text they
	// carry must not be rejected. Validate the encoded form instead.
	if v.CanInterface() && v.Type().Implements(marshalerType) {
		return validateEncodedValue(v.Interface().(cbor.Marshaler))
	}
	switch v.Kind() {
	case reflect.String:
		if !utf8.ValidString(v.String()) {
			return fmt.Errorf("invalid UTF-8 text of %d bytes", len(v.String()))
		}
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
			if err := validateMapKey(iter.Key()); err != nil {
				return err
			}
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

// errMapKeyType is the profile's map key restriction: CBOR-CORE-INT-v1 allows only text
// (major 3) and integer (major 0/1) map keys.
var errMapKeyType = errors.New("map key must be text or integer")

// validateMapKey rejects a Go map key whose encoded form would not be CBOR text or an
// integer. Plain strings and integer kinds are accepted; a self-encoding key such as
// cbor.ByteString is judged by the major type of its encoding, so a named byte-string type
// cannot sneak through because its Go kind is string.
func validateMapKey(v reflect.Value) error {
	if v.Kind() == reflect.Interface {
		if v.IsNil() {
			return errMapKeyType
		}
		v = v.Elem()
	}
	if v.Kind() == reflect.Pointer && v.IsNil() {
		return errMapKeyType
	}
	if v.CanInterface() && v.Type().Implements(marshalerType) {
		data, err := v.Interface().(cbor.Marshaler).MarshalCBOR()
		if err != nil {
			return err
		}
		if len(data) == 0 {
			return errMapKeyType
		}
		switch data[0] >> 5 {
		case 0, 1, 3:
			return nil
		}
		return errMapKeyType
	}
	switch v.Kind() {
	case reflect.String,
		reflect.Int, reflect.Int8, reflect.Int16, reflect.Int32, reflect.Int64,
		reflect.Uint, reflect.Uint8, reflect.Uint16, reflect.Uint32, reflect.Uint64:
		return nil
	}
	return errMapKeyType
}

// validateEncodedValue checks the CBOR a self-encoding value produced against the profile.
// The encoder accepts invalid UTF-8, and a custom MarshalCBOR could encode anything,
// including a map with a forbidden key type; decoding the encoded form with the profile
// catches both before the value reaches the wire.
func validateEncodedValue(m cbor.Marshaler) error {
	data, err := m.MarshalCBOR()
	if err != nil {
		return err
	}
	if _, err := decodeAny(data); err != nil {
		return fmt.Errorf("invalid encoded value: %w", err)
	}
	return nil
}

// Marshal encodes v with the protocol's deterministic encoder. It rejects any text value
// that is not valid UTF-8 before encoding, as doc/protocol.md requires of the sender.
func Marshal(v any) ([]byte, error) {
	if err := validateTextValue(v); err != nil {
		return nil, encodeErrorf("protocol: encode: %w", err)
	}
	data, err := encMode.Marshal(v)
	if err != nil {
		return nil, encodeErrorf("protocol: encode: %w", err)
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
	if _, ok := v.(profileValue); ok {
		// decodeAny above already compared the generic CBOR value byte for byte. Facts keeps keys
		// this implementation does not know in that value but not in the struct, so re-encoding the
		// struct would differ from data (doc/protocol.md, Facts).
		return nil
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

// profileValue marks the body types whose strict decode compares the generic CBOR value rather than
// the schema-decoded struct: the two map structures, Facts and its Shells. Both may carry keys or
// null values the schema decode drops, so re-encoding the struct would differ from the input. Every
// other structure keeps the tuple rule and its schema comparison.
type profileValue interface{ isProfileValue() }

func (*Facts) isProfileValue()  {}
func (*Shells) isProfileValue() {}

// profileMapEntry is one key/value pair of a decoded profile map.
type profileMapEntry struct {
	key   any
	value any
}

// profileMap is how decodeAny represents a CBOR map. A Go map cannot hold every key the
// profile permits: an integer below math.MinInt64 decodes to *big.Int, which is not
// comparable and so cannot be a map key. Entries stay in a slice until re-encoding.
type profileMap []profileMapEntry

// MarshalCBOR encodes m in core deterministic map order. The duplicate check replaces the
// decoder's DupMapKey option, which cannot apply to a slice: without it a map with
// duplicate keys would survive the decode-and-re-encode comparison unchanged.
func (m profileMap) MarshalCBOR() ([]byte, error) {
	type entry struct{ key, value []byte }
	entries := make([]entry, 0, len(m))
	for _, pair := range m {
		key, err := encMode.Marshal(pair.key)
		if err != nil {
			return nil, err
		}
		if err := checkMapKeyType(key); err != nil {
			return nil, err
		}
		value, err := encMode.Marshal(pair.value)
		if err != nil {
			return nil, err
		}
		entries = append(entries, entry{key: key, value: value})
	}
	sort.Slice(entries, func(i, j int) bool { return bytes.Compare(entries[i].key, entries[j].key) < 0 })
	out := appendMapHead(nil, uint64(len(entries)))
	for i, entry := range entries {
		if i > 0 && bytes.Equal(entries[i-1].key, entry.key) {
			return nil, errors.New("duplicate map key")
		}
		out = append(out, entry.key...)
		out = append(out, entry.value...)
	}
	return out, nil
}

// appendMapHead appends the definite-length map header for n pairs.
func appendMapHead(dst []byte, n uint64) []byte {
	switch {
	case n < 24:
		return append(dst, 0xa0|byte(n))
	case n <= 0xff:
		return append(dst, 0xb8, byte(n))
	case n <= 0xffff:
		return binary.BigEndian.AppendUint16(append(dst, 0xb9), uint16(n))
	case n <= 0xffffffff:
		return binary.BigEndian.AppendUint32(append(dst, 0xba), uint32(n))
	default:
		return binary.BigEndian.AppendUint64(append(dst, 0xbb), n)
	}
}

// decodeAny decodes one value according to the CBOR profile and verifies that
// re-encoding it reproduces the input exactly. It is the profile-level codec used by
// the golden vector tests and as Unmarshal's first stage.
func decodeAny(data []byte) (any, error) {
	var raw cbor.RawMessage
	rest, err := decMode.UnmarshalFirst(data, &raw)
	if err != nil {
		return nil, err
	}
	v, err := decodeProfileValue(raw)
	if err != nil {
		return nil, err
	}
	if len(rest) != 0 {
		return nil, fmt.Errorf("%d bytes of extraneous data", len(rest))
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

// decodeProfileValue decodes one well-formed CBOR item into the profile's Go
// representation. Arrays and maps are decoded item by item so every map key can be
// inspected before it becomes a Go value; scalar values are left to decMode.
func decodeProfileValue(raw []byte) (any, error) {
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
			v, err := decodeProfileValue(elem)
			if err != nil {
				return nil, err
			}
			values = append(values, v)
		}
		return values, nil
	case 5: // map
		return decodeProfileMap(raw)
	default:
		var v any
		if err := decMode.Unmarshal(raw, &v); err != nil {
			return nil, err
		}
		return v, nil
	}
}

// decodeProfileMap decodes a CBOR map after checking that every key is a text string or
// an integer. The check runs on the raw key item, so a byte-string, array, map, bool or
// null key gets errMapKeyType instead of a decoder type or hashability error.
func decodeProfileMap(raw []byte) (profileMap, error) {
	n, headerLen, err := profileMapHead(raw)
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
		key, err := decodeProfileValue(rawKey)
		if err != nil {
			return nil, err
		}
		value, err := decodeProfileValue(rawValue)
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

// profileMapHead parses the definite-length map header at the start of raw.
func profileMapHead(raw []byte) (n uint64, headerLen int, err error) {
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
		return uint64(binary.BigEndian.Uint16(raw[1:3])), 3, nil
	case ai == 26:
		if len(raw) < 5 {
			return 0, 0, errors.New("truncated map header")
		}
		return uint64(binary.BigEndian.Uint32(raw[1:5])), 5, nil
	case ai == 27:
		if len(raw) < 9 {
			return 0, 0, errors.New("truncated map header")
		}
		return binary.BigEndian.Uint64(raw[1:9]), 9, nil
	default:
		return 0, 0, errors.New("map must have a definite length")
	}
}

// checkMapKeyType enforces the profile's map key restriction on the raw encoding of a key:
// only text strings (major 3) and integers (major 0/1) are allowed.
func checkMapKeyType(raw []byte) error {
	if len(raw) == 0 {
		return errMapKeyType
	}
	switch raw[0] >> 5 {
	case 0, 1, 3:
		return nil
	default:
		return errMapKeyType
	}
}

// validateProfileValue rejects CBOR values the profile does not allow but the decoder
// would otherwise accept: floats (finite ones) and custom simple values. It also repeats
// the map key check on decoded values.
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
	case profileMap:
		for _, pair := range v {
			if !profileMapKey(pair.key) {
				return errMapKeyType
			}
			if err := validateProfileValue(pair.value); err != nil {
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

// profileMapKey reports whether a decoded key has one of the Go forms of a text or
// integer CBOR key.
func profileMapKey(key any) bool {
	switch key.(type) {
	case string, uint64, int64, *big.Int, big.Int:
		return true
	default:
		return false
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

func encodeErrorf(format string, args ...any) error {
	return &EncodeError{Err: fmt.Errorf(format, args...)}
}

// EncodeError is a local failure to encode a value or frame for the wire: invalid UTF-8
// text, a body that does not match its schema, or a frame over MaxFrameBytes. The frame was
// not sent, and unlike a ProtocolError it does not mean the connection is broken.
type EncodeError struct{ Err error }

func (e *EncodeError) Error() string { return e.Err.Error() }

func (e *EncodeError) Unwrap() error { return e.Err }
