package upgrade

import (
	"bytes"
	"context"
	"crypto/sha256"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"

	"github.com/Kodecable/ClusterRightHand/client/internal/protocol"
)

type recordedRun struct {
	name string
	args []string
}

func receiveSetup(t *testing.T) (string, *[]recordedRun, ReceiveOptions) {
	t.Helper()
	dir := filepath.Join(t.TempDir(), "crha-upgrade")
	runs := &[]recordedRun{}
	return dir, runs, ReceiveOptions{
		Dir:           dir,
		SkipRootCheck: true,
		Run: func(_ context.Context, name string, args ...string) ([]byte, error) {
			*runs = append(*runs, recordedRun{name, args})
			return nil, nil
		},
	}
}

func specFor(binary []byte) *protocol.NodeUpgradeSpec {
	return &protocol.NodeUpgradeSpec{
		Version: "1.3.0", Arch: runtime.GOARCH, Size: protocol.Uint(len(binary)), SHA256: sha256.Sum256(binary),
	}
}

func TestReceiveWritesTheBinaryAndHandsOver(t *testing.T) {
	dir, runs, opts := receiveSetup(t)
	binary := []byte("\x7fELF new crha")
	var out bytes.Buffer
	if err := Receive(context.Background(), "task-1", specFor(binary), bytes.NewReader(binary), &out, opts); err != nil {
		t.Fatal(err)
	}
	target := filepath.Join(dir, "backups", "task-task-1", "crha")
	got, err := os.ReadFile(target)
	if err != nil || !bytes.Equal(got, binary) {
		t.Fatalf("binary = %q, %v", got, err)
	}
	for path, want := range map[string]os.FileMode{
		dir: 0o755, filepath.Join(dir, "backups"): 0o700, filepath.Join(dir, "backups", "task-task-1"): 0o700, target: 0o700,
	} {
		if info, err := os.Stat(path); err != nil || info.Mode().Perm() != want {
			t.Fatalf("%s: mode %v, %v; want %v", path, info.Mode().Perm(), err, want)
		}
	}
	if len(*runs) != 1 || (*runs)[0].name != "systemd-run" {
		t.Fatalf("runs = %+v", *runs)
	}
	args := strings.Join((*runs)[0].args, " ")
	for _, want := range []string{"--unit crha-upgrade-task-1", "--collect", target + " " + InstallCommand, "--to 1.3.0", "--task task-1"} {
		if !strings.Contains(args, want) {
			t.Fatalf("systemd-run %s lacks %q", args, want)
		}
	}
	if !strings.Contains(out.String(), "handed over") {
		t.Fatalf("output %q", out.String())
	}
}

func TestReceiveRefusesWhatWasNotAuthorized(t *testing.T) {
	binary := []byte("\x7fELF new crha")
	cases := map[string]struct {
		task  string
		spec  *protocol.NodeUpgradeSpec
		input []byte
		want  string
	}{
		"short":       {"t", specFor(binary), binary[:4], "received 4 bytes"},
		"long":        {"t", specFor(binary), append(append([]byte{}, binary...), 'x'), "received 14 bytes"},
		"other bytes": {"t", specFor(binary), []byte("\x7fELF old crha"), "received sha256"},
		"bad version": {"t", &protocol.NodeUpgradeSpec{Version: "../etc"}, nil, "not a version"},
		"bad task id": {"../x", specFor(binary), binary, "cannot name a unit"},
		"other arch":  {"t", func() *protocol.NodeUpgradeSpec { s := specFor(binary); s.Arch = "riscv64"; return s }(), binary, "this node runs"},
		"too large":   {"t", func() *protocol.NodeUpgradeSpec { s := specFor(binary); s.Size = MaxBinarySize + 1; return s }(), binary, "at most"},
	}
	for name, c := range cases {
		t.Run(name, func(t *testing.T) {
			dir, runs, opts := receiveSetup(t)
			err := Receive(context.Background(), c.task, c.spec, bytes.NewReader(c.input), &bytes.Buffer{}, opts)
			if err == nil || !strings.Contains(err.Error(), c.want) {
				t.Fatalf("err = %v, want %q", err, c.want)
			}
			if len(*runs) != 0 {
				t.Fatal("handed over a binary that was not authorized")
			}
			if _, err := os.Stat(filepath.Join(dir, "backups", "task-t", "crha")); err == nil {
				t.Fatal("the refused binary is in place")
			}
		})
	}
}

func TestReceiveRefusesALinkedDirectory(t *testing.T) {
	dir, _, opts := receiveSetup(t)
	elsewhere := t.TempDir()
	if err := os.Symlink(elsewhere, dir); err != nil {
		t.Fatal(err)
	}
	binary := []byte("x")
	err := Receive(context.Background(), "t", specFor(binary), bytes.NewReader(binary), &bytes.Buffer{}, opts)
	if err == nil || !strings.Contains(err.Error(), "not a directory") {
		t.Fatalf("err = %v", err)
	}
}
