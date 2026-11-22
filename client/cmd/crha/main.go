package main

import (
	"os"

	"github.com/Kodecable/ClusterRightHand/client/internal/cli"
	"github.com/Kodecable/ClusterRightHand/client/internal/logging"
)

func main() {
	if err := cli.NewRootCmd().Execute(); err != nil {
		// The failure line keeps its bare human text on a terminal and carries journald's error
		// priority when stderr is the journal's stream.
		logging.PrintError(os.Stderr, "crha: "+err.Error())
		os.Exit(1)
	}
}
