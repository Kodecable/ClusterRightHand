// Package yesno interprets the answers of the command-line confirmation prompts.
package yesno

import "strings"

// Parse reads one confirmation answer, using fallback when it is empty. The second result reports
// whether the answer was recognized; each command keeps its own message for an invalid one.
func Parse(answer string, fallback bool) (bool, bool) {
	switch strings.ToLower(strings.TrimSpace(answer)) {
	case "":
		return fallback, true
	case "y", "yes":
		return true, true
	case "n", "no":
		return false, true
	default:
		return false, false
	}
}
