package main

import (
	"fmt"
	"os"

	"github.com/Kodecable/ClusterRightHand/client/internal/crhu"
)

func main() {
	if err := crhu.NewRootCmd().Execute(); err != nil {
		fmt.Fprintln(os.Stderr, "crhu:", err)
		os.Exit(1)
	}
}
