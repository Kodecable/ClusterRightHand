// Package marker holds the two log lines a crha upgrade waits for in the journal
// (doc/design/distribution.md "On the node"):
//
//   - the hand-over line, which the old crha logs when crhs acknowledges the result of a node.upgrade
//     task. The new version's installer matches it, so its text is a contract between versions: it is
//     part of each protocol major's frozen upgrade path and must never change.
//   - the readiness line, which a newly started crha logs once it is connected to crhs and its
//     privileged side works. It is written and matched by the same binary, so its format may change.
//
// Both lines are human-readable sentences; a match looks for the sentence inside the journal's
// MESSAGE, whatever the log handler wraps around it.
package marker

import (
	"fmt"
	"strings"
)

// handOverPrefix is frozen: older and newer crha versions must agree on it byte for byte.
const handOverPrefix = "crha upgrade handed over: crhs confirmed task "

// HandOver is the hand-over line for the node.upgrade task taskID.
func HandOver(taskID string) string {
	return handOverPrefix + taskID
}

// IsHandOver reports whether a journal message carries the hand-over line of taskID. The task id ends
// the sentence, so a longer id that starts with taskID does not match.
func IsHandOver(message, taskID string) bool {
	line := HandOver(taskID)
	at := strings.Index(message, line)
	if at < 0 {
		return false
	}
	rest := message[at+len(line):]
	return rest == "" || !isIDByte(rest[0])
}

func isIDByte(c byte) bool {
	return c >= '0' && c <= '9' || c >= 'a' && c <= 'z' || c >= 'A' && c <= 'Z' || c == '-' || c == '_'
}

const readyPrefix = "crha ready: connected to crhs, privileged mode ok"

// Ready is the readiness line of crha version.
func Ready(version string) string {
	return fmt.Sprintf("%s (version %s)", readyPrefix, version)
}

// IsReady reports whether a journal message is the readiness line of version.
func IsReady(message, version string) bool {
	return strings.Contains(message, Ready(version))
}
