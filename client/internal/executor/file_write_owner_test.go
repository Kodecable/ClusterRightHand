package executor

import (
	"os"
	"os/user"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"testing"
)

// An overwrite that names only the owner must keep the target's group. The temporary file is created
// with the process's primary group, so passing -1 to Chown would silently change the group instead.
func TestFileWriteOverwriteKeepsOmittedGroup(t *testing.T) {
	cur, err := user.Current()
	if err != nil || cur.Username == "" {
		t.Skip("no current user")
	}
	groupIDs, err := cur.GroupIds()
	if err != nil {
		t.Skip("no supplementary groups")
	}
	targetGID := -1
	for _, raw := range groupIDs {
		id, err := strconv.Atoi(raw)
		if err != nil || id == os.Getgid() {
			continue
		}
		targetGID = id
		break
	}
	if targetGID < 0 {
		t.Skip("no supplementary group to distinguish")
	}

	p := filepath.Join(t.TempDir(), "f")
	writeFile(t, p, "old", 0o644)
	if err := os.Chown(p, -1, targetGID); err != nil {
		t.Skipf("cannot set a supplementary group: %v", err)
	}
	spec := writeSpec(p, "new")
	spec.Overwrite = true
	spec.Owner = cur.Username
	if _, err := run(t, spec, strings.NewReader("new")); err != nil {
		t.Fatal(err)
	}
	if got := readFileStr(t, p); got != "new" {
		t.Fatalf("content = %q", got)
	}
	var st syscall.Stat_t
	if err := syscall.Stat(p, &st); err != nil {
		t.Fatal(err)
	}
	if int(st.Gid) != targetGID {
		t.Fatalf("group = %d, want the target's %d", st.Gid, targetGID)
	}
}
