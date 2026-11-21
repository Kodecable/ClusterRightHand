package upgrade

import (
	"strings"
	"testing"

	toml "github.com/pelletier/go-toml/v2"
	"github.com/pelletier/go-toml/v2/unstable/edit"
)

const privSample = `node_id = "n"
# who approves locally
local_uids = [0]  # root only

[[trust]]
name  = "crhs"
allow = [
  { method = "exec", prefix = "systemctl restart " },
  # nginx only
  { method = "file.write", prefix = "/etc/nginx/" },
]
`

func edits(list ...Edit) func(*edit.Document) []Edit {
	return func(*edit.Document) []Edit { return list }
}

func TestMigrateRenameDeleteAndArrayEdits(t *testing.T) {
	list := []Migration{{Version: "1.3.0", File: FilePrivileged, Edits: edits(
		Edit{Op: EditRename, Path: []string{"local_uids"}, To: "approver_uids"},
		Edit{Op: EditSet, Path: []string{"trust", "0", "allow", "0", "prefix"}, Value: "systemctl reload "},
		// The comment above the deleted element goes with it.
		Edit{Op: EditDelete, Path: []string{"trust", "0", "allow", "1"}},
		Edit{Op: EditDelete, Path: []string{"absent"}},
	)}}
	out, done, err := migrateFile(list, FilePrivileged, "1.2.0", "1.3.0", []byte(privSample))
	if err != nil {
		t.Fatal(err)
	}
	text := string(out)
	for _, want := range []string{"# who approves locally\napprover_uids = [0]", "# root only", "systemctl reload "} {
		if !strings.Contains(text, want) {
			t.Fatalf("result lacks %q:\n%s", want, text)
		}
	}
	if strings.Contains(text, "local_uids") || strings.Contains(text, "/etc/nginx/") || strings.Contains(text, "# nginx only") {
		t.Fatalf("result:\n%s", text)
	}
	// The absent key is not an edit that happened.
	if len(done) != 3 {
		t.Fatalf("logged %q", done)
	}
	var m map[string]any
	if err := toml.Unmarshal(out, &m); err != nil {
		t.Fatal(err)
	}
}

func TestMigrateRunsOnlyTheMigrationsOfTheRange(t *testing.T) {
	list := []Migration{
		{Version: "1.2.0", File: FileCrha, Edits: edits(Edit{Op: EditSet, Path: []string{"a"}, Value: 1})},
		{Version: "1.3.0-rc.1", File: FileCrha, Edits: edits(Edit{Op: EditSet, Path: []string{"b"}, Value: 2})},
		{Version: "1.3.0", File: FilePrivileged, Edits: edits(Edit{Op: EditSet, Path: []string{"c"}, Value: 3})},
		{Version: "1.4.0", File: FileCrha, Edits: edits(Edit{Op: EditSet, Path: []string{"d"}, Value: 4})},
	}
	out, done, err := migrateFile(list, FileCrha, "1.2.0", "1.3.0", []byte("x = 0\n"))
	if err != nil {
		t.Fatal(err)
	}
	if string(out) != "x = 0\nb = 2\n" || len(done) != 1 {
		t.Fatalf("out %q, done %q", out, done)
	}
	// Nothing applies: the bytes are returned as they are.
	same := []byte("x   =   0   # spaced\n")
	out, done, err = migrateFile(list, FileCrha, "1.4.0", "1.5.0", same)
	if err != nil || string(out) != string(same) || done != nil {
		t.Fatalf("out %q, done %q, %v", out, done, err)
	}
}

func TestMigrateRefusesARenameOntoAnExistingKey(t *testing.T) {
	list := []Migration{{Version: "1.3.0", File: FileCrha, Edits: edits(
		Edit{Op: EditRename, Path: []string{"a"}, To: "b"},
	)}}
	if _, _, err := migrateFile(list, FileCrha, "1.2.0", "1.3.0", []byte("a = 1\nb = 2\n")); err == nil {
		t.Fatal("renamed onto an existing key")
	}
}

func TestCheckEditCatchesAnEditThatDoesMore(t *testing.T) {
	before := []byte("a = 1\nb = 2\n")
	after := []byte("a = 5\n")
	if err := checkEdit(before, after, Edit{Op: EditSet, Path: []string{"a"}, Value: 5}); err == nil {
		t.Fatal("an edit that also deleted b passed the check")
	}
	if err := checkEdit(before, []byte("a = 5\nb = 2\n"), Edit{Op: EditSet, Path: []string{"a"}, Value: 5}); err != nil {
		t.Fatal(err)
	}
}

func TestCompareVersions(t *testing.T) {
	ordered := []string{"1.0.0-alpha", "1.0.0-alpha.1", "1.0.0-alpha.beta", "1.0.0-beta.2", "1.0.0-beta.11", "1.0.0-rc.1", "1.0.0", "1.2.0", "1.10.0"}
	for i := 0; i+1 < len(ordered); i++ {
		if compareVersions(ordered[i], ordered[i+1]) >= 0 || compareVersions(ordered[i+1], ordered[i]) <= 0 {
			t.Fatalf("%s vs %s", ordered[i], ordered[i+1])
		}
	}
	if IsReleaseVersion("v1.2.0-3-gabc") || IsReleaseVersion("dev") || !IsReleaseVersion("1.2.0-rc.1") {
		t.Fatal("IsReleaseVersion")
	}
}
