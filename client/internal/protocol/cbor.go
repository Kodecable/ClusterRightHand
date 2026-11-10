package protocol

import (
	"bytes"
	"encoding/binary"
	"errors"
	"fmt"
	"math"
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
// option; decodeAny checks them itself and UnmarshalBody's re-encode cannot produce one.
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
// that is not valid UTF-8 before encoding, as doc/design/protocol.md requires of the sender.
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

// Unmarshal strictly decodes one protocol value into v. It applies the CBOR profile, checks
// the schema while decoding, and finally re-encodes the decoded value and
// compares it byte-for-byte with data. Any failure is a *ProtocolError.
func Unmarshal(data []byte, v any) error {
	if _, err := decodeAny(data); err != nil {
		return &ProtocolError{Err: fmt.Errorf("decode: %w", err)}
	}
	return UnmarshalBody(data, v)
}

// UnmarshalBody is the schema stage of Unmarshal: it decodes data into v, which must be a protocol
// structure, and re-encodes it to compare with data byte for byte (except for the two profile maps,
// see profileValue). It skips the CBOR profile stage, so its caller must already know that data is
// one canonical CBOR value: a body the Peer took from a frame DecodeFrame validated, or one this
// package just encoded with Marshal. That is the body a request or event handler receives, and it is
// where most of the work of a large frame is saved; a body that does not match the schema is
// reported exactly as Unmarshal reports it.
func UnmarshalBody(data []byte, v any) error {
	if err := decMode.Unmarshal(data, v); err != nil {
		return &ProtocolError{Err: fmt.Errorf("decode: %w", err)}
	}
	if _, ok := v.(profileValue); ok {
		// The callers above checked the bytes against the profile byte for byte. Facts keeps keys
		// this implementation does not know in the generic value but not in the struct, so
		// re-encoding the struct would differ from data (doc/design/protocol.md, Facts).
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

// maxProfileNesting is the profile's maximum number of nested arrays and maps, the same
// limit the TS decoder enforces (MAX_NESTING in packages/protocol/src/cbor.ts).
const maxProfileNesting = 64

// The container limits are fxamacker's defaults, which the old decMode.UnmarshalFirst
// stage enforced before the value was decoded; the single pass enforces them as it reads.
const (
	maxProfileArrayElements = 131072
	maxProfileMapPairs      = 131072
)

// decodeAny decodes exactly one value according to the CBOR profile in a single pass.
// It is the profile-level codec used by the golden vector tests and as Unmarshal's first
// stage. Every canonical-encoding rule is checked while reading (shortest heads, sorted
// and duplicate-free map keys, no tags/indefinite forms/floats/simple values), so the
// input needs neither a second decode nor a re-encode comparison to be proven canonical.
func decodeAny(data []byte) (any, error) {
	if len(data) == 0 {
		return nil, errors.New("empty CBOR value")
	}
	d := profileDecoder{data: data}
	v, err := d.value(0)
	if err != nil {
		return nil, err
	}
	if d.off != len(data) {
		return nil, fmt.Errorf("%d bytes of extraneous data", len(data)-d.off)
	}
	return v, nil
}

// profileDecoder is a cursor over one CBOR value. It produces the same Go representation
// decodeAny always returned: uint64/int64 (or *big.Int below math.MinInt64), []byte,
// string, []any and profileMap.
type profileDecoder struct {
	data []byte
	off  int
}

// value decodes one item. depth is the number of arrays and maps already open.
func (d *profileDecoder) value(depth int) (any, error) {
	if d.off >= len(d.data) {
		return nil, errors.New("unexpected end of CBOR data")
	}
	head := d.data[d.off]
	ai := head & 0x1f
	switch head >> 5 {
	case 0: // uint
		n, err := d.argument(ai)
		if err != nil {
			return nil, err
		}
		return n, nil
	case 1: // negative integer
		n, err := d.argument(ai)
		if err != nil {
			return nil, err
		}
		if n > math.MaxInt64 {
			// Same form decMode's BigIntDecodePointer produces for values below MinInt64.
			bi := new(big.Int).SetUint64(n)
			bi.Add(bi, big.NewInt(1))
			bi.Neg(bi)
			return bi, nil
		}
		return int64(-1) ^ int64(n), nil
	case 2: // byte string
		n, err := d.argument(ai)
		if err != nil {
			return nil, err
		}
		return d.byteString(n)
	case 3: // text string
		n, err := d.argument(ai)
		if err != nil {
			return nil, err
		}
		return d.textString(n)
	case 4: // array
		n, err := d.argument(ai)
		if err != nil {
			return nil, err
		}
		if depth >= maxProfileNesting {
			return nil, fmt.Errorf("value nests more than %d levels deep", maxProfileNesting)
		}
		if n > maxProfileArrayElements {
			return nil, fmt.Errorf("array declares %d elements, more than the %d allowed", n, maxProfileArrayElements)
		}
		if n > uint64(len(d.data)-d.off) {
			return nil, fmt.Errorf("array declares %d elements but the input holds %d bytes", n, len(d.data)-d.off)
		}
		values := make([]any, 0, int(n))
		for range n {
			v, err := d.value(depth + 1)
			if err != nil {
				return nil, err
			}
			values = append(values, v)
		}
		return values, nil
	case 5: // map
		n, err := d.argument(ai)
		if err != nil {
			return nil, err
		}
		return d.mapValue(n, depth)
	case 6: // tag
		return nil, errors.New("tags are not allowed")
	default: // major 7: false, true, null, simple values and floats
		return d.simpleValue(ai)
	}
}

// argument reads the argument of a head with additional information ai. Definite lengths
// only, and the shortest form is required (RFC 8949 §4.2.1); the old re-encode comparison
// rejected a non-shortest head, this rejects it directly.
func (d *profileDecoder) argument(ai byte) (uint64, error) {
	if ai < 24 {
		d.off++
		return uint64(ai), nil
	}
	if ai > 27 {
		return 0, errors.New("indefinite or reserved length")
	}
	width := 1 << (ai - 24)
	start := d.off + 1
	end := start + width
	if end > len(d.data) {
		return 0, errors.New("unexpected end of CBOR data")
	}
	d.off = end
	var n uint64
	for _, b := range d.data[start:end] {
		n = n<<8 | uint64(b)
	}
	minimum := uint64(24)
	if width > 1 {
		minimum = uint64(1) << (4 * width)
	}
	if n < minimum {
		return 0, fmt.Errorf("non-canonical encoding: non-shortest argument %d in a %d-byte head", n, width)
	}
	return n, nil
}

// byteString copies n bytes after the head. The copy keeps the decoded value from aliasing
// the frame buffer, like decMode's decode into any did.
func (d *profileDecoder) byteString(n uint64) (any, error) {
	if n > uint64(len(d.data)-d.off) {
		return nil, errors.New("unexpected end of CBOR data")
	}
	b := make([]byte, n)
	copy(b, d.data[d.off:d.off+int(n)])
	d.off += int(n)
	return b, nil
}

// textString decodes n UTF-8 bytes after the head.
func (d *profileDecoder) textString(n uint64) (any, error) {
	if n > uint64(len(d.data)-d.off) {
		return nil, errors.New("unexpected end of CBOR data")
	}
	raw := d.data[d.off : d.off+int(n)]
	if !utf8.Valid(raw) {
		return nil, errors.New("text is not valid UTF-8")
	}
	d.off += int(n)
	return string(raw), nil
}

// mapValue decodes n pairs. Core deterministic encoding orders keys by their encoded bytes,
// so checking that order while reading proves the re-encoded map would equal the input;
// equal adjacent keys are the duplicate-key error the old re-encode caught.
func (d *profileDecoder) mapValue(n uint64, depth int) (profileMap, error) {
	if depth >= maxProfileNesting {
		return nil, fmt.Errorf("value nests more than %d levels deep", maxProfileNesting)
	}
	if n > maxProfileMapPairs {
		return nil, fmt.Errorf("map declares %d pairs, more than the %d allowed", n, maxProfileMapPairs)
	}
	if n > uint64(len(d.data)-d.off)/2 {
		return nil, fmt.Errorf("map declares %d pairs but the input is %d bytes", n, len(d.data))
	}
	entries := make(profileMap, 0, int(n))
	var previousKey []byte
	for range n {
		if d.off >= len(d.data) {
			return nil, errors.New("unexpected end of CBOR data")
		}
		// The key type check runs before decoding, as decodeProfileMap did: a byte string,
		// array, map, bool or null key gets errMapKeyType rather than a decoder error.
		switch d.data[d.off] >> 5 {
		case 0, 1, 3:
		default:
			return nil, errMapKeyType
		}
		keyStart := d.off
		key, err := d.value(depth + 1)
		if err != nil {
			return nil, err
		}
		rawKey := d.data[keyStart:d.off]
		if previousKey != nil {
			switch bytes.Compare(previousKey, rawKey) {
			case 0:
				return nil, errors.New("duplicate map key")
			case 1:
				return nil, errors.New("non-canonical encoding: map keys are not sorted")
			}
		}
		previousKey = rawKey
		value, err := d.value(depth + 1)
		if err != nil {
			return nil, err
		}
		entries = append(entries, profileMapEntry{key: key, value: value})
	}
	return entries, nil
}

// simpleValue decodes major type 7. The profile allows false, true and null only; floats
// and every other simple value are rejected.
func (d *profileDecoder) simpleValue(ai byte) (any, error) {
	switch ai {
	case 20: // false
		d.off++
		return false, nil
	case 21: // true
		d.off++
		return true, nil
	case 22: // null
		d.off++
		return nil, nil
	case 23:
		return nil, errors.New("undefined is not allowed")
	case 24:
		if d.off+2 > len(d.data) {
			return nil, errors.New("unexpected end of CBOR data")
		}
		value := d.data[d.off+1]
		d.off += 2
		return nil, fmt.Errorf("simple value %d is not allowed", value)
	case 25, 26, 27:
		return nil, errors.New("floats are not allowed")
	default:
		return nil, errors.New("invalid simple value")
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

// PeekMajor returns the first element (protocol_major) of a handshake payload without
// decoding the rest. A receiver that sees an unsupported major version must not try to
// parse the remaining fields, which may belong to a later version.
func PeekMajor(payload []byte) (Uint, error) {
	if len(payload) == 0 {
		return 0, errors.New("protocol: empty handshake payload")
	}
	if head := payload[0]; head&0xe0 != 0x80 {
		return 0, errors.New("protocol: handshake payload is not an array")
	}
	arrayLen, headerLen, err := peekHeader(payload, 4)
	if err != nil {
		return 0, fmt.Errorf("protocol: handshake payload: %w", err)
	}
	if arrayLen == 0 || len(payload) <= headerLen {
		return 0, errors.New("protocol: handshake payload has no protocol_major")
	}
	major, _, err := peekHeader(payload[headerLen:], 0)
	if err != nil {
		return 0, fmt.Errorf("protocol: decode protocol_major: %w", err)
	}
	if major > MaxSafeInteger {
		return 0, fmt.Errorf("protocol: protocol_major %d exceeds 2^53-1", major)
	}
	return Uint(major), nil
}

// peekHeader parses the header of the first CBOR item in b and returns its value (the length for an
// array, the number for a uint) and the header's encoded length. Only the definite-length forms are
// accepted, the value must use its shortest encoding (RFC 8949 §4.2.1, the CBOR profile), and a
// uint must fit the protocol's range. The TS decoder (peekProtocolMajor in packages/protocol) makes
// the same checks, so both sides reject the same handshake payloads.
func peekHeader(b []byte, major byte) (value uint64, headerLen int, err error) {
	if len(b) == 0 {
		return 0, 0, errors.New("missing header")
	}
	head := b[0]
	if head&0xe0 != major<<5 {
		if major == 4 {
			return 0, 0, errors.New("not an array")
		}
		return 0, 0, errors.New("not a uint")
	}
	var width int
	switch ai := head & 0x1f; {
	case ai < 24:
		return uint64(ai), 1, nil
	case ai == 24:
		width = 1
	case ai == 25:
		width = 2
	case ai == 26:
		width = 4
	case ai == 27:
		width = 8
	default:
		return 0, 0, errors.New("indefinite or reserved length")
	}
	headerLen = 1 + width
	if len(b) < headerLen {
		return 0, 0, errors.New("truncated header")
	}
	for _, c := range b[1:headerLen] {
		value = value<<8 | uint64(c)
	}
	// The shortest form is required: a value that fits a shorter form must use it. 23 and below
	// are encoded in the header itself, then 24, 2^8, 2^16 and 2^32 start the wider forms.
	minimum := uint64(24)
	if width > 1 {
		minimum = uint64(1) << (4 * width)
	}
	if value < minimum {
		return 0, 0, fmt.Errorf("non-shortest length %d in a %d-byte header", value, width)
	}
	if major == 0 && value > MaxSafeInteger {
		return 0, 0, fmt.Errorf("uint %d exceeds 2^53-1", value)
	}
	return value, headerLen, nil
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
