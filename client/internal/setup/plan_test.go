package setup

import (
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/Kodecable/ClusterRightHand/client/internal/config"
	"github.com/Kodecable/ClusterRightHand/client/internal/tomledit"
	"github.com/Kodecable/ClusterRightHand/client/internal/units"
)

func planRoot(t *testing.T, files map[string]string) string {
	t.Helper()
	root := t.TempDir()
	for path, content := range files {
		full := filepath.Join(root, path)
		if err := os.MkdirAll(filepath.Dir(full), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(full, []byte(content), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	return root
}

const planConfig = "server = \"https://crh.example.com\"\nstate_dir = \"/var/lib/crha\"\n\n[privileged]\nmode = \"ignore\"\n"

func ignorePlan(t *testing.T, root string, cfg Content) (*Plan, error) {
	t.Helper()
	return BuildPlan(PlanInput{
		Root: root, ConfigPath: DefaultConfigPath, Executable: "/usr/local/bin/crha",
		Mode: config.ModeIgnore, Version: "1.0.0", Config: cfg,
	})
}

func TestPlanKeepsAHandWrittenPrivilegedUnitAndDropsAManagedOne(t *testing.T) {
	handWritten := "[Service]\nExecStart=/opt/crha privileged run\n"
	root := planRoot(t, map[string]string{DefaultConfigPath: planConfig, filepath.Join(units.Dir, units.Privileged): handWritten})
	plan, err := ignorePlan(t, root, Content{})
	if err != nil {
		t.Fatal(err)
	}
	if f := plan.File(filepath.Join(units.Dir, units.Privileged)); f.Changed() {
		t.Fatal("a unit crha did not write would be removed")
	}
	managed := units.RenderPrivileged("/usr/local/bin/crha", PrivilegedConfigPath, "1.0.0")
	root = planRoot(t, map[string]string{DefaultConfigPath: planConfig, filepath.Join(units.Dir, units.Privileged): managed})
	if plan, err = ignorePlan(t, root, Content{}); err != nil {
		t.Fatal(err)
	}
	if f := plan.File(filepath.Join(units.Dir, units.Privileged)); f.After != nil {
		t.Fatal("the managed privileged unit stays outside forward mode")
	}
}

func TestPlanSelfTestRefusesWhatThisVersionCannotRead(t *testing.T) {
	root := planRoot(t, map[string]string{DefaultConfigPath: planConfig})
	broken := Content{Edit: func(data []byte) ([]byte, []string, error) {
		return append(data, "unknown_key = 1\n"...), nil, nil
	}}
	if _, err := ignorePlan(t, root, broken); err == nil || !strings.Contains(err.Error(), "self-test") {
		t.Fatalf("err %v", err)
	}
	failing := Content{Edit: func([]byte) ([]byte, []string, error) { return nil, nil, errors.New("no") }}
	if _, err := ignorePlan(t, root, failing); err == nil {
		t.Fatal("a failing edit was planned")
	}
}

func TestPlanAmendTryLeavesThePlanAsItWas(t *testing.T) {
	root := planRoot(t, map[string]string{DefaultConfigPath: planConfig})
	plan, err := ignorePlan(t, root, Content{})
	if err != nil {
		t.Fatal(err)
	}
	tls := editing(change{edit: tomledit.Edit{Op: tomledit.Set, Path: []string{"tls_verify"}, Value: "none"}, line: "tls_verify"})
	if err := plan.Amend(DefaultConfigPath, tls, true); err != nil {
		t.Fatal(err)
	}
	if plan.File(DefaultConfigPath).Changed() {
		t.Fatal("a tried amendment changed the plan")
	}
	if err := plan.Amend(DefaultConfigPath, tls, false); err != nil {
		t.Fatal(err)
	}
	if f := plan.File(DefaultConfigPath); !f.Changed() || len(f.Changes) != 1 {
		t.Fatalf("amended: %+v", f.Changes)
	}
}
