// Package fsutil has the small filesystem durability helpers shared by the packages that publish
// state files.
package fsutil

import "os"

// SyncDir fsyncs dir so an entry renamed into it is durable.
func SyncDir(dir string) error {
	d, err := os.Open(dir)
	if err != nil {
		return err
	}
	defer d.Close()
	return d.Sync()
}
