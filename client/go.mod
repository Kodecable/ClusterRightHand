module github.com/Kodecable/ClusterRightHand/client

go 1.27.3

require (
	github.com/coder/websocket v1.8.15
	github.com/flynn/noise v1.1.0
	github.com/fxamacker/cbor/v2 v2.10.0
	// Pinned to an unreleased commit for unstable/edit (comment-preserving edits, upstream #1095), which
	// the self-upgrade's configuration migrations use. Move to the first release that contains it.
	github.com/pelletier/go-toml/v2 v2.4.4-0.20260718201843-686c980c4758
	github.com/spf13/cobra v1.10.2
	github.com/spf13/pflag v1.0.9
	golang.org/x/crypto v0.58.0
	golang.org/x/sys v0.49.0
)

require (
	github.com/inconshreveable/mousetrap v1.1.0 // indirect
	github.com/x448/float16 v0.8.4 // indirect
)
