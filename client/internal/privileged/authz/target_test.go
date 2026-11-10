package authz

import (
	"testing"

	"github.com/Kodecable/ClusterRightHand/client/internal/protocol"
)

func TestQuoteArg(t *testing.T) {
	tests := []struct {
		arg  string
		want string
	}{
		{"", "''"},
		{"simple", "simple"},
		{"a-b_c.d/e:f,g+h@i%j=k", "a-b_c.d/e:f,g+h@i%j=k"},
		{"a b", "'a b'"},
		{"it's", `'it'\''s'`},
		{"line\nbreak", "'line\nbreak'"},
		{"é", "'é'"},
		{"$(id)", "'$(id)'"},
	}
	for _, test := range tests {
		if got := quoteArg(test.arg); got != test.want {
			t.Errorf("quoteArg(%q) = %q, want %q", test.arg, got, test.want)
		}
	}
}

func TestTargetErrors(t *testing.T) {
	tests := []struct {
		name string
		spec *protocol.TaskSpec
	}{
		{"nil", nil},
		{"exec without body", &protocol.TaskSpec{Kind: protocol.TaskSpecExec}},
		{"exec empty argv", &protocol.TaskSpec{Kind: protocol.TaskSpecExec, Exec: &protocol.ExecSpec{
			Command: protocol.Command{Kind: protocol.CommandArgv, Argv: []string{}},
		}}},
		{"file.read without body", &protocol.TaskSpec{Kind: protocol.TaskSpecFileRead}},
		{"unknown kind", &protocol.TaskSpec{Kind: "file.chmod"}},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			if _, _, err := Target(test.spec); err == nil {
				t.Fatal("invalid task spec produced a target")
			}
		})
	}
}

func TestTargetFileMethods(t *testing.T) {
	tests := []struct {
		spec   *protocol.TaskSpec
		method string
		target string
	}{
		{&protocol.TaskSpec{Kind: protocol.TaskSpecFileRead, FileRead: &protocol.FileReadSpec{Path: "/etc/hosts"}},
			"file.read", "/etc/hosts"},
		{&protocol.TaskSpec{Kind: protocol.TaskSpecFileStat, FileStat: &protocol.FileStatSpec{Path: "/etc"}},
			"file.read", "/etc"},
		{&protocol.TaskSpec{Kind: protocol.TaskSpecFileList, FileList: &protocol.FileListSpec{Path: "/etc/nginx"}},
			"file.read", "/etc/nginx"},
		{&protocol.TaskSpec{Kind: protocol.TaskSpecFileWrite, FileWrite: &protocol.FileWriteSpec{Path: "/etc/hosts"}},
			"file.write", "/etc/hosts"},
		{&protocol.TaskSpec{Kind: protocol.TaskSpecFileEdit, FileEdit: &protocol.FileEditSpec{Path: "/etc/hosts"}},
			"file.write", "/etc/hosts"},
	}
	for _, test := range tests {
		method, target, err := Target(test.spec)
		if err != nil {
			t.Fatalf("%s: %v", test.spec.Kind, err)
		}
		if method != test.method || target != test.target {
			t.Errorf("%s: got (%q, %q), want (%q, %q)", test.spec.Kind, method, target, test.method, test.target)
		}
	}
}

func TestCheckPath(t *testing.T) {
	tests := []struct {
		path string
		ok   bool
	}{
		{"/", true},
		{"/etc/hosts", true},
		{"/etc/nginx/nginx.conf", true},
		{"", false},
		{".", false},
		{"etc/hosts", false},
		{"/etc/../shadow", false},
		{"/etc/./hosts", false},
		{"/etc//hosts", false},
		{"/etc/nginx/", false},
	}
	for _, test := range tests {
		err := CheckPath(test.path)
		if test.ok && err != nil {
			t.Errorf("CheckPath(%q) = %v, want nil", test.path, err)
		}
		if !test.ok && err == nil {
			t.Errorf("CheckPath(%q) accepted", test.path)
		}
	}
}

// TestTargetShellCommandRendersBinSh pins the authorization and display rendering of a `shell`
// command: it stays /bin/sh -c '<cmd>' whatever shell the node discovered for execution
// (doc/design/execution.md "The exec environment").
func TestTargetShellCommandRendersBinSh(t *testing.T) {
	spec := &protocol.TaskSpec{Kind: protocol.TaskSpecExec, Exec: &protocol.ExecSpec{
		Command: protocol.Command{Kind: protocol.CommandShell, Shell: "systemctl restart nginx"},
	}}
	method, target, err := Target(spec)
	if err != nil {
		t.Fatal(err)
	}
	if method != "exec" || target != "/bin/sh -c 'systemctl restart nginx'" {
		t.Fatalf("got (%q, %q), want (exec, /bin/sh -c 'systemctl restart nginx')", method, target)
	}
}
