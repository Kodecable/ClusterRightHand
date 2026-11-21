package upgrade

import (
	"fmt"

	"github.com/pelletier/go-toml/v2/unstable/edit"

	"github.com/Kodecable/ClusterRightHand/client/internal/tomledit"
)

// The configuration migrations of the self-upgrade (doc/design/distribution.md "On the node"). A
// migration is not a way of reading a file: it is a list of edits the new version applies to the
// document before its own, strict parser reads it. What a migration does not name stays as it was,
// byte for byte, comments and order included. Migrations make no promise about behavior: a release
// may change a default or drop a key, and its release notes say so. Their one requirement is that
// the new version can read the result without anyone's help. The edits go through tomledit, as crha
// enroll's do.

// Config files a migration edits.
const (
	FileCrha       = "crha.toml"
	FilePrivileged = "privileged.toml"
)

// Migration is the edits one version applies to one file of the versions before it.
type Migration struct {
	// Version is the first version that needs the edits: they run on an upgrade from an older version to
	// this one or a newer one.
	Version string
	File    string
	// Edits returns the edits for the document as it is; it may read it to decide.
	Edits func(doc *edit.Document) []tomledit.Edit
}

// migrations is empty: no format has changed since self-upgrade exists.
var migrations []Migration

// migrateFile applies the migrations that an upgrade from `from` to `to` needs to one file. It returns
// the new content, unchanged bytes when nothing applies, and a description of each edit for the
// upgrade log.
func migrateFile(list []Migration, file, from, to string, data []byte) ([]byte, []string, error) {
	var applicable []Migration
	for _, m := range list {
		if m.File == file && compareVersions(from, m.Version) < 0 && compareVersions(m.Version, to) <= 0 {
			applicable = append(applicable, m)
		}
	}
	if len(applicable) == 0 {
		return data, nil, nil
	}
	var done []string
	for _, m := range applicable {
		// A migration may read the document as the migrations before it left it, to decide.
		doc, err := edit.Parse(data)
		if err != nil {
			return nil, nil, fmt.Errorf("%s: %w", file, err)
		}
		out, applied, err := tomledit.Apply(data, m.Edits(doc))
		if err != nil {
			return nil, nil, fmt.Errorf("%s: migration to %s: %w", file, m.Version, err)
		}
		for _, e := range applied {
			done = append(done, fmt.Sprintf("%s: %s (from %s)", file, e, m.Version))
		}
		data = out
	}
	return data, done, nil
}
