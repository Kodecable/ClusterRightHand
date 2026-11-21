package backup

import (
	"errors"
	"os"
	"path/filepath"
	"syscall"
)

// LockName is the install lock, in the upgrade directory above Dir.
const LockName = "install.lock"

// ErrLocked says another process changes the fixed set now.
var ErrLocked = errors.New("another crha upgrade, rollback or enrollment is running")

// Lock takes the install lock in dir without waiting. Everything that changes the fixed set holds it: an
// upgrade, a rollback by hand and crha enroll, so none of them writes over another's files or stops the
// units another is starting. Only its holder writes the upgrade log.
func Lock(dir string) (func(), error) {
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return nil, err
	}
	f, err := os.OpenFile(filepath.Join(dir, LockName), os.O_RDWR|os.O_CREATE|syscall.O_NOFOLLOW, 0o600)
	if err != nil {
		return nil, err
	}
	if err := syscall.Flock(int(f.Fd()), syscall.LOCK_EX|syscall.LOCK_NB); err != nil {
		f.Close()
		if errors.Is(err, syscall.EWOULDBLOCK) {
			return nil, ErrLocked
		}
		return nil, err
	}
	return func() { _ = syscall.Flock(int(f.Fd()), syscall.LOCK_UN); f.Close() }, nil
}
