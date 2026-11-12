package setup

import (
	"bufio"
	"fmt"
	"io"
	"os"
	"strings"

	"golang.org/x/sys/unix"
)

// IsTerminal reports whether f is a terminal.
func IsTerminal(f *os.File) bool {
	_, err := unix.IoctlGetTermios(int(f.Fd()), unix.TCGETS)
	return err == nil
}

// IsTerminalReader reports whether r is an *os.File attached to a terminal.
func IsTerminalReader(r io.Reader) bool {
	f, ok := r.(*os.File)
	return ok && IsTerminal(f)
}

// ReadPassword reads one line from f with the terminal's echo turned off. It does not print a prompt.
func ReadPassword(f *os.File) (string, error) {
	return readPassword(f, bufio.NewReader(f))
}

func readPassword(f *os.File, reader *bufio.Reader) (string, error) {
	fd := int(f.Fd())
	termios, err := unix.IoctlGetTermios(fd, unix.TCGETS)
	if err != nil {
		return "", err
	}
	restore := *termios
	termios.Lflag &^= unix.ECHO
	termios.Lflag |= unix.ECHONL
	if err := unix.IoctlSetTermios(fd, unix.TCSETS, termios); err != nil {
		return "", err
	}
	defer func() { _ = unix.IoctlSetTermios(fd, unix.TCSETS, &restore) }()
	line, err := reader.ReadString('\n')
	if err != nil && err != io.EOF {
		return "", err
	}
	return strings.TrimSpace(line), nil
}

// prompter asks the enrollment questions on a terminal.
type prompter struct {
	reader *bufio.Reader
	input  io.Reader
	out    io.Writer
}

func newPrompter(input io.Reader, out io.Writer) *prompter {
	return &prompter{reader: bufio.NewReader(input), input: input, out: out}
}

func (p *prompter) ask(prompt string) (string, error) {
	fmt.Fprint(p.out, prompt)
	line, err := p.reader.ReadString('\n')
	if err != nil && err != io.EOF {
		return "", err
	}
	if err == io.EOF && line == "" {
		return "", io.EOF
	}
	return strings.TrimSpace(line), nil
}

func (p *prompter) askSecret(prompt string) (string, error) {
	fmt.Fprint(p.out, prompt)
	if f, ok := p.input.(*os.File); ok && IsTerminal(f) {
		return readPassword(f, p.reader)
	}
	return p.ask("")
}
