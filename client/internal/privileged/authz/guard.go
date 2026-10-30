package authz

import (
	"errors"
	"fmt"
	"regexp"

	"github.com/Kodecable/ClusterRightHand/client/internal/protocol"
)

// MaxPatternBytes bounds a guard rule's regex pattern (doc/privilege.md#防护规则).
const MaxPatternBytes = 1000

// compiledRule is one GuardRule ready to match targets.
type compiledRule struct {
	method protocol.Method
	any    bool
	re     *regexp.Regexp
}

// ruleSet is a compiled allow or deny list. err records the first rule that does not
// compile; the set then fails closed: deny matches, allow does not.
type ruleSet struct {
	rules []compiledRule
	err   error
}

// ValidateRules compiles a guard rule list and returns the first error. A configuration
// loader uses it to reject a broken privileged.toml up front; Decide fails closed if an
// invalid rule reaches it anyway.
func ValidateRules(rules []protocol.GuardRule) error { return compileRules(rules).err }

// compileRules compiles a guard rule list. Rules never partly apply: one invalid rule
// invalidates the whole list.
func compileRules(rules []protocol.GuardRule) ruleSet {
	out := ruleSet{rules: make([]compiledRule, 0, len(rules))}
	for _, rule := range rules {
		compiled, err := compileRule(rule)
		if err != nil {
			out.err = err
			out.rules = nil
			return out
		}
		out.rules = append(out.rules, compiled)
	}
	return out
}

func compileRule(rule protocol.GuardRule) (compiledRule, error) {
	switch rule.Method {
	case protocol.MethodExec, protocol.MethodFileRead, protocol.MethodFileWrite:
	default:
		return compiledRule{}, fmt.Errorf("authz: guard rule has unknown method %q", string(rule.Method))
	}
	if len(rule.Pattern) > MaxPatternBytes {
		return compiledRule{}, fmt.Errorf("authz: guard rule pattern is %d bytes, at most %d allowed",
			len(rule.Pattern), MaxPatternBytes)
	}
	switch rule.Match {
	case protocol.GuardMatchAny:
		if rule.Pattern != "" {
			return compiledRule{}, errors.New(`authz: guard rule with match "any" has a non-empty pattern`)
		}
		return compiledRule{method: rule.Method, any: true}, nil
	case protocol.GuardMatchPrefix:
		// (?s) keeps "." matching a target that contains a newline.
		re, err := regexp.Compile("(?s)^" + regexp.QuoteMeta(rule.Pattern) + ".*$")
		if err != nil {
			return compiledRule{}, fmt.Errorf("authz: compile prefix rule: %w", err)
		}
		return compiledRule{method: rule.Method, re: re}, nil
	case protocol.GuardMatchRegex:
		// Compile the pattern on its own first. A pattern like "a)|(b" is unbalanced and breaks
		// out of the implicit full match: compiled as "(?s)^(?:a)|(b)$" it would match "a" and
		// anything ending in "b" instead of nothing. It is a configuration error, not a rule.
		if _, err := regexp.Compile(rule.Pattern); err != nil {
			return compiledRule{}, fmt.Errorf("authz: compile regex rule: %w", err)
		}
		re, err := regexp.Compile("(?s)^(?:" + rule.Pattern + ")$")
		if err != nil {
			return compiledRule{}, fmt.Errorf("authz: compile regex rule: %w", err)
		}
		return compiledRule{method: rule.Method, re: re}, nil
	default:
		return compiledRule{}, fmt.Errorf("authz: guard rule has unknown match %q", string(rule.Match))
	}
}

// matches applies one rule to an operation. allowFileWriteCoversRead is true only for
// allow rules: a file.write allow rule also grants reading, while a deny rule stays
// method-exact (D67).
func (r compiledRule) matches(method, target string, allowFileWriteCoversRead bool) bool {
	if string(r.method) != method {
		if !(allowFileWriteCoversRead && r.method == protocol.MethodFileWrite && method == string(protocol.MethodFileRead)) {
			return false
		}
	}
	if r.any {
		return true
	}
	return r.re.MatchString(target)
}

// denies reports whether any deny rule matches. A rule set that failed to compile denies
// everything, so a broken configuration cannot widen access.
func (s ruleSet) denies(method, target string) bool {
	if s.err != nil {
		return true
	}
	for _, rule := range s.rules {
		if rule.matches(method, target, false) {
			return true
		}
	}
	return false
}

// allows reports whether any allow rule matches. An empty list places no restriction on
// the target; a list that failed to compile allows nothing.
func (s ruleSet) allows(method, target string) bool {
	if s.err != nil {
		return false
	}
	for _, rule := range s.rules {
		if rule.matches(method, target, true) {
			return true
		}
	}
	return false
}

// guardAllows applies a trust entry's deny and allow lists in the documented order: any
// deny hit rejects, and a non-empty allow list must contain a hit.
func guardAllows(entry *Entry, method, target string) bool {
	deny := compileRules(entry.Deny)
	if deny.denies(method, target) {
		return false
	}
	allow := compileRules(entry.Allow)
	if len(entry.Allow) == 0 {
		return true
	}
	return allow.allows(method, target)
}

// envAllowed reports whether every environment variable the task carries is listed in the
// trust entry's env_allow. File tasks carry no environment.
func envAllowed(spec *protocol.TaskSpec, envAllow []string) bool {
	if spec == nil || spec.Kind != protocol.TaskSpecExec {
		return true
	}
	if spec.Exec == nil {
		return false
	}
	allowed := make(map[string]struct{}, len(envAllow))
	for _, name := range envAllow {
		allowed[name] = struct{}{}
	}
	for name := range spec.Exec.Env {
		if _, ok := allowed[name]; !ok {
			return false
		}
	}
	return true
}
