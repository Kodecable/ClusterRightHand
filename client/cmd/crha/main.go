package main

import (
	"fmt"
	"os"

	"github.com/Kodecable/ClusterRightHand/client/internal/cli"
)

func main() {
	if err := cli.NewRootCmd().Execute(); err != nil {
		fmt.Fprintln(os.Stderr, "crha:", err)
		os.Exit(1)
	}
}
