package yesno

import "testing"

// TestParse covers the answers every confirmation prompt accepts, the default of an empty answer and
// the unrecognized answer the caller reports itself.
func TestParse(t *testing.T) {
	for _, tc := range []struct {
		answer   string
		fallback bool
		value    bool
		ok       bool
	}{
		{"", true, true, true},
		{"", false, false, true},
		{"y", false, true, true},
		{" YES ", false, true, true},
		{"n", true, false, true},
		{"No\n", true, false, true},
		{"maybe", true, false, false},
	} {
		value, ok := Parse(tc.answer, tc.fallback)
		if value != tc.value || ok != tc.ok {
			t.Errorf("Parse(%q, %v) = %v, %v; want %v, %v", tc.answer, tc.fallback, value, ok, tc.value, tc.ok)
		}
	}
}
