package cli

import (
	"bufio"
	"context"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"strings"

	"github.com/spf13/cobra"

	"github.com/Kodecable/ClusterRightHand/client/internal/config"
	"github.com/Kodecable/ClusterRightHand/client/internal/enroll"
	"github.com/Kodecable/ClusterRightHand/client/internal/execenv"
	"github.com/Kodecable/ClusterRightHand/client/internal/identity"
	"github.com/Kodecable/ClusterRightHand/client/internal/setup"
	"github.com/Kodecable/ClusterRightHand/client/internal/version"
)

func newEnrollCmd() *cobra.Command {
	var configPath, answersPath, saveAnswersPath string
	cmd := &cobra.Command{
		Use:   "enroll",
		Short: "Set up and enroll this node",
		Long: `Set up this node and enroll it with crhs: create the crha user and directories, write
crha.toml, enroll, write privileged.toml for forward mode and the systemd units. Run as root.

The questions are answered on the terminal. --answers <file> answers them ahead with one JSON
object; --save-answers <file> writes the answers without the token. Without a terminal every
question must be answered by the file. An interrupted run can simply be repeated: each step that
is already done is skipped.`,
		Args: cobra.NoArgs,
		RunE: func(cmd *cobra.Command, _ []string) error {
			return setup.Run(cmd.Context(), setup.Options{
				ConfigPath:      configPath,
				AnswersPath:     answersPath,
				SaveAnswersPath: saveAnswersPath,
				Input:           cmd.InOrStdin(),
				Output:          cmd.OutOrStdout(),
				PromptOutput:    cmd.ErrOrStderr(),
			})
		},
	}
	cmd.Flags().StringVar(&configPath, "config", setup.DefaultConfigPath, "path to the config file")
	cmd.Flags().StringVar(&answersPath, "answers", "", "JSON file that answers the questions ahead")
	cmd.Flags().StringVar(&saveAnswersPath, "save-answers", "", "write the answers without the token to this file")
	return cmd
}

func newRegisterCmd() *cobra.Command {
	var configPath string
	var replace bool
	cmd := &cobra.Command{
		Use:   "register",
		Short: "Enroll this node using an existing configuration",
		Long: `Enroll this node using the server and paths of an existing crha.toml. The enrollment token is
read from standard input (one line), or prompted for without echo on a terminal. This is the step
underneath crha enroll, for a manual layout and for tests: it creates no user, file or unit.
--replace re-enrolls a node that already has keys: identity.key and server.pub are moved aside as
*.old and restored if enrollment fails.`,
		Args: cobra.NoArgs,
		RunE: func(cmd *cobra.Command, _ []string) error {
			return register(cmd.Context(), cmd.OutOrStdout(), cmd.InOrStdin(), cmd.ErrOrStderr(), configPath, replace)
		},
	}
	cmd.Flags().StringVar(&configPath, "config", "", "path to the config file (required)")
	_ = cmd.MarkFlagRequired("config")
	cmd.Flags().BoolVar(&replace, "replace", false, "replace an existing identity key and server key (re-enrollment)")
	return cmd
}

// register is `crha register`: load the configuration, read the token and run the shared enrollment.
func register(ctx context.Context, out io.Writer, in io.Reader, promptOut io.Writer, configPath string, replace bool) error {
	cfg, err := config.Load(configPath)
	if err != nil {
		if errors.Is(err, fs.ErrNotExist) {
			return fmt.Errorf("config %s does not exist", configPath)
		}
		return err
	}
	token, err := readEnrollmentToken(in, promptOut)
	if err != nil {
		return err
	}
	env, err := resolveEnv(execenv.Options{})
	if err != nil {
		return err
	}
	result, err := enroll.Run(ctx, cfg, token, enroll.Options{Replace: replace, Env: env})
	if err != nil {
		return err
	}
	fmt.Fprintf(out, "enrolled as node %s, waiting for approval\nnode key fingerprint: %s\n", result.NodeID, result.Fingerprint)
	return nil
}

// readEnrollmentToken reads one line from stdin, or prompts without echo when stdin is a terminal.
func readEnrollmentToken(in io.Reader, promptOut io.Writer) (string, error) {
	var line string
	var err error
	if f, ok := in.(*os.File); ok && setup.IsTerminal(f) {
		fmt.Fprint(promptOut, "Enrollment token: ")
		line, err = setup.ReadPassword(f)
	} else {
		line, err = bufio.NewReader(in).ReadString('\n')
	}
	if err != nil && !errors.Is(err, io.EOF) {
		return "", err
	}
	token := strings.TrimSpace(line)
	if token == "" {
		return "", errors.New("no enrollment token on standard input")
	}
	return token, nil
}

func newStatusCmd() *cobra.Command {
	var configPath string
	cmd := &cobra.Command{
		Use:   "status",
		Short: "Show this node's identity and configuration",
		Args:  cobra.NoArgs,
		RunE: func(cmd *cobra.Command, _ []string) error {
			cfg, err := config.Load(configPath)
			if err != nil {
				return err
			}
			out := cmd.OutOrStdout()
			fmt.Fprintf(out, "server:          %s\n", cfg.AgentURL())
			if key, err := identity.LoadKeypair(cfg.IdentityKeyPath()); err == nil {
				fmt.Fprintf(out, "node key:        %s\n", identity.Fingerprint(key.Public))
			} else {
				fmt.Fprintf(out, "node key:        not enrolled (%v)\n", err)
			}
			if key, err := identity.LoadServerKey(cfg.ServerKeyPath()); err == nil {
				fmt.Fprintf(out, "server key:      %s\n", identity.Fingerprint(key))
			}
			fmt.Fprintf(out, "privileged mode: %s\n", cfg.Privilege.Mode)
			return nil
		},
	}
	cmd.Flags().StringVar(&configPath, "config", "", "path to the config file (required)")
	_ = cmd.MarkFlagRequired("config")
	return cmd
}

// errPackageManaged refuses a self-upgrade when the system package manager owns the binary.
var errPackageManaged = errors.New("crha is managed by the system package manager; upgrade it with apt or dnf")

func newUpgradeCmd() *cobra.Command {
	var apply string
	cmd := &cobra.Command{
		Use:   "upgrade",
		Short: "Apply a crha binary upgrade",
		Args:  cobra.NoArgs,
		RunE: func(cmd *cobra.Command, _ []string) error {
			if version.PackageManaged {
				return errPackageManaged
			}
			return notImplemented(cmd, nil)
		},
	}
	cmd.Flags().StringVar(&apply, "apply", "", "path to the new crha binary")
	_ = cmd.MarkFlagRequired("apply")
	return cmd
}
