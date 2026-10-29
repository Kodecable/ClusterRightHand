package authz

import (
	"strings"
	"testing"

	"github.com/Kodecable/ClusterRightHand/client/internal/protocol"
)

func rule(method protocol.Method, match protocol.GuardMatch, pattern string) protocol.GuardRule {
	return protocol.GuardRule{Method: method, Match: match, Pattern: pattern}
}

func TestGuardAllowPrefixAndRegex(t *testing.T) {
	entry := &Entry{Allow: []protocol.GuardRule{
		rule(protocol.MethodExec, protocol.GuardMatchPrefix, "systemctl restart "),
		rule(protocol.MethodExec, protocol.GuardMatchRegex, "apt-get (update|upgrade -y)"),
		rule(protocol.MethodExec, protocol.GuardMatchRegex, "multi.*line"),
		rule(protocol.MethodFileWrite, protocol.GuardMatchPrefix, "/etc/nginx/"),
	}}
	tests := []struct {
		name    string
		method  string
		target  string
		allowed bool
	}{
		{"prefix hit", "exec", "systemctl restart nginx", true},
		{"prefix miss", "exec", "systemctl stop nginx", false},
		{"prefix is escaped", "exec", "systemctl restartXnginx", false},
		{"regex full hit", "exec", "apt-get update", true},
		{"regex full miss with extra args", "exec", "apt-get update --fix-missing", false},
		{"regex is anchored", "exec", "sudo apt-get update", false},
		{"regex dot matches newline", "exec", "multi\nline", true},
		{"write allows read", "file.read", "/etc/nginx/nginx.conf", true},
		{"write allows write", "file.write", "/etc/nginx/nginx.conf", true},
		{"write prefix miss", "file.write", "/etc/crha/privileged.toml", false},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			if got := guardAllows(entry, test.method, test.target); got != test.allowed {
				t.Fatalf("guardAllows(%q, %q) = %v, want %v", test.method, test.target, got, test.allowed)
			}
		})
	}
}

func TestGuardDeny(t *testing.T) {
	entry := &Entry{
		Allow: []protocol.GuardRule{
			rule(protocol.MethodFileWrite, protocol.GuardMatchPrefix, "/etc/"),
		},
		Deny: []protocol.GuardRule{
			rule(protocol.MethodFileRead, protocol.GuardMatchRegex, "/etc/(shadow|gshadow|sudoers.*)"),
			rule(protocol.MethodFileWrite, protocol.GuardMatchPrefix, "/etc/crha/"),
		},
	}
	tests := []struct {
		name    string
		method  string
		target  string
		allowed bool
	}{
		{"deny read", "file.read", "/etc/shadow", false},
		{"deny write", "file.write", "/etc/crha/privileged.toml", false},
		// A file.write deny rule does not hide reads (D67).
		{"write deny does not read", "file.read", "/etc/crha/privileged.toml", true},
		{"write allow covers read", "file.read", "/etc/hosts", true},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			if got := guardAllows(entry, test.method, test.target); got != test.allowed {
				t.Fatalf("guardAllows(%q, %q) = %v, want %v", test.method, test.target, got, test.allowed)
			}
		})
	}
}

func TestGuardAny(t *testing.T) {
	entry := &Entry{Allow: []protocol.GuardRule{
		rule(protocol.MethodFileRead, protocol.GuardMatchAny, ""),
	}}
	if !guardAllows(entry, "file.read", "/any/path") {
		t.Fatal("match any did not allow")
	}
	if guardAllows(entry, "file.write", "/any/path") {
		t.Fatal("file.read any rule allowed a write")
	}
}

func TestGuardFailsClosed(t *testing.T) {
	tests := []struct {
		name string
		rule protocol.GuardRule
	}{
		{"bad regex", rule(protocol.MethodExec, protocol.GuardMatchRegex, "(")},
		{"unknown method", protocol.GuardRule{Method: "file.chmod", Match: protocol.GuardMatchAny}},
		{"unknown match", protocol.GuardRule{Method: protocol.MethodExec, Match: "glob", Pattern: "*"}},
		{"any with pattern", rule(protocol.MethodExec, protocol.GuardMatchAny, "x")},
		{"pattern too long", rule(protocol.MethodExec, protocol.GuardMatchRegex, strings.Repeat("a", MaxPatternBytes+1))},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			set := compileRules([]protocol.GuardRule{test.rule})
			if set.err == nil {
				t.Fatal("invalid rule compiled")
			}
			if !set.denies("exec", "anything") {
				t.Fatal("invalid deny rule does not fail closed")
			}
			if set.allows("exec", "anything") {
				t.Fatal("invalid allow rule allowed a target")
			}
			// An invalid allow rule must not widen an entry that has one.
			if guardAllows(&Entry{Allow: []protocol.GuardRule{test.rule}}, "exec", "anything") {
				t.Fatal("entry with an invalid allow rule allowed a target")
			}
		})
	}
}

func TestValidateRules(t *testing.T) {
	valid := []protocol.GuardRule{
		rule(protocol.MethodExec, protocol.GuardMatchPrefix, "systemctl restart "),
		rule(protocol.MethodFileRead, protocol.GuardMatchAny, ""),
	}
	if err := ValidateRules(valid); err != nil {
		t.Fatalf("valid rules rejected: %v", err)
	}
	invalid := []protocol.GuardRule{rule(protocol.MethodExec, protocol.GuardMatchRegex, "(")}
	if err := ValidateRules(invalid); err == nil {
		t.Fatal("invalid rules accepted")
	}
}

func TestGuardPatternLimit(t *testing.T) {
	pattern := strings.Repeat("a", MaxPatternBytes)
	if set := compileRules([]protocol.GuardRule{rule(protocol.MethodExec, protocol.GuardMatchRegex, pattern)}); set.err != nil {
		t.Fatalf("%d-byte pattern rejected: %v", MaxPatternBytes, set.err)
	}
}

func TestEnvAllowed(t *testing.T) {
	execSpec := &protocol.TaskSpec{Kind: protocol.TaskSpecExec, Exec: &protocol.ExecSpec{
		Command: protocol.Command{Kind: protocol.CommandArgv, Argv: []string{"/bin/true"}},
		Env:     map[string]string{"DEBIAN_FRONTEND": "noninteractive", "LANG": "C.UTF-8"},
	}}
	if !envAllowed(execSpec, []string{"DEBIAN_FRONTEND", "LANG"}) {
		t.Fatal("allowed environment rejected")
	}
	if envAllowed(execSpec, []string{"DEBIAN_FRONTEND"}) {
		t.Fatal("disallowed environment accepted")
	}
	if envAllowed(execSpec, nil) {
		t.Fatal("empty env_allow accepted a task environment")
	}
	read := &protocol.TaskSpec{Kind: protocol.TaskSpecFileRead, FileRead: &protocol.FileReadSpec{Path: "/etc/hosts"}}
	if !envAllowed(read, nil) {
		t.Fatal("file task without environment rejected")
	}
	broken := &protocol.TaskSpec{Kind: protocol.TaskSpecExec}
	if envAllowed(broken, []string{"LANG"}) {
		t.Fatal("exec spec without a body accepted")
	}
}
