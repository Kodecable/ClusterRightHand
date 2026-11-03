//go:build !pprof

package cli

import "testing"

// TestNoDebugFlagsInNormalBuild covers the other half of the pprof contract: a build without the tag
// has no debug hook at all, so no debug flag can appear on the long-running commands.
func TestNoDebugFlagsInNormalBuild(t *testing.T) {
	if debugFlags != nil {
		t.Fatal("debugFlags is set in a normal build")
	}
	root := NewRootCmd()
	for _, args := range [][]string{{"run"}, {"privileged", "run"}} {
		cmd, _, err := root.Find(args)
		if err != nil {
			t.Fatalf("find %v: %v", args, err)
		}
		if flag := cmd.Flags().Lookup("pprof-listen"); flag != nil {
			t.Fatalf("%v has --pprof-listen in a normal build", args)
		}
	}
}
