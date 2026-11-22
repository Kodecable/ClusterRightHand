//go:build !linux

package logging

import "errors"

// fdStat is unavailable outside Linux, where the systemd journal does not exist: the detector
// never matches.
func fdStat(int) (FdStat, error) {
	return FdStat{}, errors.New("logging: stat of a file descriptor is unsupported on this OS")
}
