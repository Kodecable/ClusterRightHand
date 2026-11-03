package config

import (
	"crypto/ecdsa"
	"crypto/ed25519"
	"crypto/elliptic"
	"crypto/rand"
	"encoding/base64"
	"fmt"
	"os"
	"path/filepath"
	"reflect"
	"regexp"
	"strings"
	"syscall"
	"testing"

	"github.com/fxamacker/cbor/v2"
	"golang.org/x/crypto/ssh"

	"github.com/Kodecable/ClusterRightHand/client/internal/protocol"
)

// testSigner returns a fresh SSH key and its authorized_keys line with a comment.
func testSigner(t *testing.T) (ssh.Signer, string) {
	t.Helper()
	_, private, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	signer, err := ssh.NewSignerFromKey(private)
	if err != nil {
		t.Fatal(err)
	}
	line := strings.TrimSpace(string(ssh.MarshalAuthorizedKey(signer.PublicKey()))) + " test-key"
	return signer, line
}

// testSKLine returns an authorized_keys line of an sk-ssh-ed25519 key. The private half of
// such a key lives on a FIDO device, so the test carries a public key only.
func testSKLine() string {
	return "sk-ssh-ed25519@openssh.com AAAAGnNrLXNzaC1lZDI1NTE5QG9wZW5zc2guY29tAAAAIM8sfZQXlSIczYlblQ0YM2slDJSGZWrJsFVXSgsnFpHWAAAABHNzaDo= test-yubikey"
}

// testCOSEKey returns a WebAuthn ES256 credential: its COSE public key and credential id.
func testCOSEKey(t *testing.T) (string, string) {
	t.Helper()
	private, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	cose, err := cbor.Marshal(map[int64]any{
		1:  2,  // kty: EC2
		3:  -7, // alg: ES256
		-1: 1,  // crv: P-256
		-2: private.PublicKey.X.FillBytes(make([]byte, 32)),
		-3: private.PublicKey.Y.FillBytes(make([]byte, 32)),
	})
	if err != nil {
		t.Fatal(err)
	}
	credentialID := make([]byte, 16)
	if _, err := rand.Read(credentialID); err != nil {
		t.Fatal(err)
	}
	return base64.RawURLEncoding.EncodeToString(cose), base64.RawURLEncoding.EncodeToString(credentialID)
}

// fullTestConfig is a complete privileged.toml and the paths it configures.
type fullTestConfig struct {
	TOML     string
	Socket   string
	StateDir string
	LogPath  string
}

// fullConfig is the example of doc/privilege.md 信任配置 with test keys and temporary paths.
func fullConfig(t *testing.T) fullTestConfig {
	t.Helper()
	_, crhsLine := testSigner(t)
	cose, credentialID := testCOSEKey(t)
	dir := t.TempDir()
	files := fullTestConfig{
		Socket:   filepath.Join(dir, "privileged.sock"),
		StateDir: filepath.Join(dir, "state"),
		LogPath:  filepath.Join(dir, "privileged.jsonl"),
	}
	files.TOML = fmt.Sprintf(`
node_id          = "01JB0000000000000000000001"
groups           = ["web", "prod"]
unprivileged_uid = 998
clock_skew       = "90s"
socket           = %q
state_dir        = %q
log              = %q

[[trust]]
name          = "crhs"
role          = "crhs"
format        = "sshsig"
key           = %q
kinds         = ["execute", "cosign"]
require_exact = true
max_ttl       = "5m"
env_allow     = ["DEBIAN_FRONTEND"]
allow = [
  { method = "exec",       prefix = "systemctl restart " },
  { method = "exec",       regex  = 'apt-get (update|upgrade -y)' },
  { method = "file.write", prefix = "/etc/nginx/" },
  { method = "file.read" },
]
deny = [
  { method = "file.read",  regex  = '/etc/(shadow|gshadow|sudoers.*)' },
  { method = "file.write", prefix = "/etc/crha/" },
]

[[trust]]
name       = "ktren-yubikey"
role       = "user"
format     = "sshsig"
key        = %q
kinds      = ["execute"]
require_uv = true
max_ttl    = "24h"

[[trust]]
name          = "ktren-passkey"
role          = "user"
format        = "webauthn"
rp_id         = "crh.example.com"
origins       = ["https://crh.example.com"]
credential_id = %q
key           = "cose:%s"
require_uv    = true
kinds         = ["execute", "require-cosign"]

[[trust]]
name  = "local-admins"
role  = "local"
uids  = [0, 1000]
kinds = ["execute"]
`, files.Socket, files.StateDir, files.LogPath, crhsLine, testSKLine(), credentialID, cose)
	return files
}

// minimalConfig returns a valid configuration with one crhs entry that the mutation tests
// replace.
func minimalConfig(t *testing.T) string {
	t.Helper()
	_, line := testSigner(t)
	dir := t.TempDir()
	return fmt.Sprintf(`
node_id          = "01JB0000000000000000000001"
unprivileged_uid = 998
socket           = %q
state_dir        = %q
log              = %q

[[trust]]
name   = "crhs"
role   = "crhs"
format = "sshsig"
key    = %q
kinds  = ["execute"]
`, filepath.Join(dir, "privileged.sock"), filepath.Join(dir, "state"),
		filepath.Join(dir, "privileged.jsonl"), line)
}

// removeKey returns a test configuration without the line that assigns key.
func removeKey(toml, key string) string {
	re := regexp.MustCompile(`(?m)^` + regexp.QuoteMeta(key) + `\s*=.*\n?`)
	return re.ReplaceAllString(toml, "")
}

// setKey replaces the line that assigns key in a test configuration.
func setKey(toml, key, value string) string {
	re := regexp.MustCompile(`(?m)^` + regexp.QuoteMeta(key) + `\s*=.*$`)
	return re.ReplaceAllString(toml, key+" = "+value)
}

func TestParseFullConfig(t *testing.T) {
	files := fullConfig(t)
	cfg, err := Parse([]byte(files.TOML))
	if err != nil {
		t.Fatalf("Parse: %v", err)
	}
	if cfg.NodeID != "01JB0000000000000000000001" || cfg.UnprivilegedUID != 998 {
		t.Fatalf("node fields: %+v", cfg)
	}
	if !reflect.DeepEqual(cfg.Groups, []string{"web", "prod"}) {
		t.Fatalf("groups = %v", cfg.Groups)
	}
	if cfg.ClockSkew.String() != "1m30s" {
		t.Fatalf("clock skew = %v", cfg.ClockSkew)
	}
	if cfg.Socket != files.Socket || cfg.StateDir != files.StateDir || cfg.LogPath != files.LogPath {
		t.Fatalf("paths: socket %q state %q log %q", cfg.Socket, cfg.StateDir, cfg.LogPath)
	}
	if cfg.SocketGroup != DefaultSocketGroup {
		t.Fatalf("socket group = %q, want %q", cfg.SocketGroup, DefaultSocketGroup)
	}
	if len(cfg.Trust) != 4 {
		t.Fatalf("trust entries = %d, want 4", len(cfg.Trust))
	}

	crhs := cfg.Trust[0]
	if crhs.Role != protocol.TrustRoleCRHS || crhs.Format != FormatSSHSig {
		t.Fatalf("crhs entry: %+v", crhs)
	}
	if !reflect.DeepEqual(crhs.Kinds, []protocol.TrustKind{protocol.TrustKindExecute, protocol.TrustKindCosign}) {
		t.Fatalf("crhs kinds = %v", crhs.Kinds)
	}
	if !crhs.RequireExact || !crhs.RequireTask || crhs.RequireUV {
		t.Fatalf("crhs flags: %+v", crhs)
	}
	if crhs.MaxTTL == nil || crhs.MaxTTL.String() != "5m0s" {
		t.Fatalf("crhs max_ttl = %v", crhs.MaxTTL)
	}
	if len(crhs.Allow) != 4 || crhs.Allow[0] != (protocol.GuardRule{
		Method: protocol.MethodExec, Match: protocol.GuardMatchPrefix, Pattern: "systemctl restart ",
	}) {
		t.Fatalf("crhs allow = %v", crhs.Allow)
	}
	if crhs.Allow[3] != (protocol.GuardRule{Method: protocol.MethodFileRead, Match: protocol.GuardMatchAny}) {
		t.Fatalf("crhs allow[3] = %+v", crhs.Allow[3])
	}
	if len(crhs.Deny) != 2 || crhs.Deny[0].Match != protocol.GuardMatchRegex {
		t.Fatalf("crhs deny = %v", crhs.Deny)
	}
	if !reflect.DeepEqual(crhs.EnvAllow, []string{"DEBIAN_FRONTEND"}) {
		t.Fatalf("crhs env_allow = %v", crhs.EnvAllow)
	}
	if crhs.SSHKey == nil || !strings.HasSuffix(crhs.SSHKeyText, " test-key") {
		t.Fatalf("crhs key = %v %q", crhs.SSHKey, crhs.SSHKeyText)
	}

	user := cfg.Trust[1]
	if user.Role != protocol.TrustRoleUser || !user.RequireUV || user.RequireTask {
		t.Fatalf("user entry: %+v", user)
	}
	// A user entry cannot require task ids unless asked to; require_task defaults to false.
	webauthn := cfg.Trust[2]
	if webauthn.WebAuthn == nil || webauthn.WebAuthn.RPID != "crh.example.com" ||
		len(webauthn.WebAuthn.CredentialID) != 16 || len(webauthn.WebAuthn.COSEKey) == 0 {
		t.Fatalf("webauthn entry: %+v", webauthn.WebAuthn)
	}
	if !reflect.DeepEqual(webauthn.Kinds, []protocol.TrustKind{
		protocol.TrustKindExecute, protocol.TrustKindRequireCosign,
	}) {
		t.Fatalf("webauthn kinds = %v", webauthn.Kinds)
	}
	local := cfg.Trust[3]
	if local.Role != protocol.TrustRoleLocal || !reflect.DeepEqual(local.UIDs, []uint32{0, 1000}) {
		t.Fatalf("local entry: %+v", local)
	}
	if local.RequireTask {
		t.Fatal("local entry requires task ids")
	}
}

func TestSummary(t *testing.T) {
	cfg, err := Parse([]byte(fullConfig(t).TOML))
	if err != nil {
		t.Fatalf("Parse: %v", err)
	}
	summary := cfg.Summary()
	if summary == nil {
		t.Fatal("nil summary")
	}
	if summary.NodeID != cfg.NodeID || !reflect.DeepEqual(summary.Groups, []string{"web", "prod"}) {
		t.Fatalf("summary node = %q %v", summary.NodeID, summary.Groups)
	}
	if summary.ClockSkewMS != 90000 {
		t.Fatalf("clock_skew_ms = %d", summary.ClockSkewMS)
	}
	if summary.Identities.Unprivileged.UID != 998 {
		t.Fatalf("unprivileged identity = %+v", summary.Identities.Unprivileged)
	}
	if summary.Identities.Privileged.UID != protocol.Uint(os.Geteuid()) {
		t.Fatalf("privileged identity = %+v", summary.Identities.Privileged)
	}
	if len(summary.Trust) != 4 {
		t.Fatalf("trust = %d entries", len(summary.Trust))
	}

	crhs := summary.Trust[0]
	if crhs.Name != "crhs" || crhs.Source != protocol.TrustSourceLocal || crhs.Role != protocol.TrustRoleCRHS {
		t.Fatalf("crhs summary = %+v", crhs)
	}
	if crhs.Key.Kind != protocol.TrustKeySSHSig || crhs.Key.SSHSig == nil {
		t.Fatalf("crhs key = %+v", crhs.Key)
	}
	wantFP := ssh.FingerprintSHA256(cfg.Trust[0].SSHKey)
	if crhs.Key.SSHSig.Fingerprint != wantFP || !strings.HasPrefix(wantFP, "SHA256:") {
		t.Fatalf("fingerprint = %q, want %q", crhs.Key.SSHSig.Fingerprint, wantFP)
	}
	if crhs.Key.SSHSig.PublicKey != cfg.Trust[0].SSHKeyText {
		t.Fatalf("public key = %q", crhs.Key.SSHSig.PublicKey)
	}
	if crhs.MaxTTLMS == nil || *crhs.MaxTTLMS != 300000 {
		t.Fatalf("max_ttl_ms = %v", crhs.MaxTTLMS)
	}
	if !crhs.RequireExact || !crhs.RequireTask || crhs.RequireUV {
		t.Fatalf("crhs summary flags = %+v", crhs)
	}

	passkey := summary.Trust[2]
	if passkey.Key.Kind != protocol.TrustKeyWebAuthn || passkey.Key.WebAuthn == nil ||
		passkey.Key.WebAuthn.RPID != "crh.example.com" || !passkey.RequireUV {
		t.Fatalf("passkey summary = %+v", passkey)
	}

	local := summary.Trust[3]
	if local.Key.Kind != protocol.TrustKeyLocal || local.Key.Local == nil ||
		!reflect.DeepEqual(local.Key.Local.UIDs, []protocol.Uint{0, 1000}) {
		t.Fatalf("local summary = %+v", local)
	}
	// Every slice of the summary must be encodable: nil would become CBOR null and violate
	// the schema.
	if _, err := protocol.Marshal(summary); err != nil {
		t.Fatalf("encode summary: %v", err)
	}
	digest, err := protocol.TrustDigest(summary)
	if err != nil || digest == ([32]byte{}) {
		t.Fatalf("digest = %x, %v", digest, err)
	}
}

func TestEntries(t *testing.T) {
	cfg, err := Parse([]byte(fullConfig(t).TOML))
	if err != nil {
		t.Fatalf("Parse: %v", err)
	}
	entries := cfg.Entries()
	if len(entries) != 4 {
		t.Fatalf("entries = %d", len(entries))
	}
	if entries[1].Name != "ktren-yubikey" || !entries[1].RequireUV || entries[1].Role != protocol.TrustRoleUser {
		t.Fatalf("entry[1] = %+v", entries[1])
	}
	if !reflect.DeepEqual(entries[3].UIDs, []uint32{0, 1000}) {
		t.Fatalf("entry[3] uids = %v", entries[3].UIDs)
	}
	if entries[0].MaxTTL == nil || entries[0].MaxTTL.String() != "5m0s" {
		t.Fatalf("entry[0] max_ttl = %v", entries[0].MaxTTL)
	}
}

// TestLookups covers the trust entry lookups by key, credential and uid.
func TestLookups(t *testing.T) {
	cfg, err := Parse([]byte(fullConfig(t).TOML))
	if err != nil {
		t.Fatalf("Parse: %v", err)
	}
	if got := cfg.SSHEntry(cfg.Trust[0].SSHKey); got == nil || got.Name != "crhs" {
		t.Fatalf("SSHEntry(crhs key) = %v", got)
	}
	other, _ := testSigner(t)
	if got := cfg.SSHEntry(other.PublicKey()); got != nil {
		t.Fatalf("SSHEntry(other key) = %v", got)
	}
	if got := cfg.CredentialEntry(cfg.Trust[2].WebAuthn.CredentialID); got == nil || got.Name != "ktren-passkey" {
		t.Fatalf("CredentialEntry = %v", got)
	}
	if got := cfg.CredentialEntry([]byte("nope")); got != nil {
		t.Fatalf("CredentialEntry(unknown) = %v", got)
	}
	for _, uid := range []uint32{0, 1000} {
		if got := cfg.LocalEntry(uid); got == nil || got.Name != "local-admins" {
			t.Fatalf("LocalEntry(%d) = %v", uid, got)
		}
	}
	if got := cfg.LocalEntry(1001); got != nil {
		t.Fatalf("LocalEntry(1001) = %v", got)
	}
	if !cfg.HasLocalEntry() {
		t.Fatal("HasLocalEntry = false")
	}
	// Root is not implicitly trusted: a configuration without a local entry has none even
	// though root would be a natural default.
	noLocal, err := Parse([]byte(minimalConfig(t)))
	if err != nil {
		t.Fatalf("Parse: %v", err)
	}
	if got := noLocal.LocalEntry(0); got != nil || noLocal.HasLocalEntry() {
		t.Fatalf("minimal config has a local entry: %v", got)
	}
}

func TestParseRejects(t *testing.T) {
	base := minimalConfig(t)
	_, line := testSigner(t)
	cose, credentialID := testCOSEKey(t)
	tests := []struct {
		name string
		toml string
		want string
	}{
		{"unknown top-level key", "bogus = 1\n" + base, "unknown key: bogus"},
		{"missing node id", strings.Replace(base, `node_id          = "01JB0000000000000000000001"`, "", 1), "node_id: required"},
		{"star node id", strings.Replace(base, `"01JB0000000000000000000001"`, `"*"`, 1), "not a node id"},
		{"missing unprivileged uid",
			strings.Replace(base, "unprivileged_uid = 998", "", 1), "unprivileged_uid: required"},
		{"bad clock skew",
			strings.Replace(base, "unprivileged_uid = 998", "unprivileged_uid = 998\nclock_skew = \"soon\"", 1), "clock_skew"},
		{"missing socket", removeKey(base, "socket"), "socket: required"},
		{"missing state_dir", removeKey(base, "state_dir"), "state_dir: required"},
		{"missing log", removeKey(base, "log"), "log: required"},
		{"relative socket", setKey(base, "socket", `"run/x.sock"`), "must be absolute"},
		{"bad group name",
			strings.Replace(base, "unprivileged_uid = 998", "unprivileged_uid = 998\ngroups = [\"*\"]", 1), "group name"},
		{"unknown trust key", base + "bogus = true\n", "unknown key"},
		{"missing trust name", strings.Replace(base, `name   = "crhs"`, "", 1), "name: required"},
		{"unknown role", strings.Replace(base, `role   = "crhs"`, `role   = "admin"`, 1), "role:"},
		{"crhs with webauthn",
			strings.Replace(base, "format = \"sshsig\"", "format = \"webauthn\"", 1), "signs with \"sshsig\" only"},
		{"crhs without format", strings.Replace(base, "format = \"sshsig\"\n", "", 1), "signs with \"sshsig\" only"},
		{"crhs kinds require-cosign",
			strings.Replace(base, `kinds  = ["execute"]`, `kinds  = ["require-cosign"]`, 1), "crhs entry takes execute or cosign"},
		{"crhs require_task false",
			strings.Replace(base, "kinds  = [\"execute\"]", "kinds  = [\"execute\"]\nrequire_task = false", 1), "always require task_ids"},
		{"crhs require_uv",
			strings.Replace(base, "kinds  = [\"execute\"]", "kinds  = [\"execute\"]\nrequire_uv = true", 1), "only user entries can require user verification"},
		{"missing kinds", strings.Replace(base, `kinds  = ["execute"]`, "", 1), "kinds: required"},
		{"duplicate kinds",
			strings.Replace(base, `kinds  = ["execute"]`, `kinds  = ["execute", "execute"]`, 1), "duplicate"},
		{"bad max_ttl", strings.Replace(base, "kinds  = [\"execute\"]", "kinds  = [\"execute\"]\nmax_ttl = \"soon\"", 1), "max_ttl"},
		{"zero max_ttl", strings.Replace(base, "kinds  = [\"execute\"]", "kinds  = [\"execute\"]\nmax_ttl = \"0s\"", 1), "max_ttl"},
		{"rule without method",
			strings.Replace(base, "kinds  = [\"execute\"]", "kinds  = [\"execute\"]\nallow = [{ prefix = \"/etc/\" }]", 1), "method is required"},
		{"rule with prefix and regex",
			strings.Replace(base, "kinds  = [\"execute\"]", "kinds  = [\"execute\"]\nallow = [{ method = \"exec\", prefix = \"a\", regex = \"b\" }]", 1), "mutually exclusive"},
		{"rule with unknown method",
			strings.Replace(base, "kinds  = [\"execute\"]", "kinds  = [\"execute\"]\nallow = [{ method = \"syscall\" }]", 1), "unknown method"},
		{"rule with bad regex",
			strings.Replace(base, "kinds  = [\"execute\"]", "kinds  = [\"execute\"]\ndeny = [{ method = \"exec\", regex = \"a(\" }]", 1), "deny"},
		{"env_allow PATH",
			strings.Replace(base, "kinds  = [\"execute\"]", "kinds  = [\"execute\"]\nenv_allow = [\"PATH\"]", 1), "PATH is fixed"},
		{"env_allow invalid name",
			strings.Replace(base, "kinds  = [\"execute\"]", "kinds  = [\"execute\"]\nenv_allow = [\"A=B\"]", 1), "invalid variable name"},
		{"duplicate trust names", base + "\n[[trust]]\nname = \"crhs\"\nrole = \"local\"\nuids = [0]\nkinds = [\"execute\"]\n", "duplicate name"},
		{"local with format", localEntry(t, "format = \"sshsig\"\nuids = [0]\nkinds = [\"execute\"]"), "no format"},
		{"local without uids", localEntry(t, "kinds = [\"execute\"]"), "uids: required"},
		{"local with require_task", localEntry(t, "uids = [0]\nrequire_task = true\nkinds = [\"execute\"]"), "require_task"},
		{"local with key", localEntry(t, "uids = [0]\nkey = \"ssh-ed25519 AAAA\"\nkinds = [\"execute\"]"), "not by a key"},
		{"local kinds cosign", localEntry(t, "uids = [0]\nkinds = [\"cosign\"]"), "takes execute only"},
		{"user without format", userEntry(t, "", "kinds = [\"execute\"]"), "needs \"sshsig\" or \"webauthn\""},
		{"user kinds cosign", userEntry(t, "format = \"sshsig\"\nkey = "+quote(line), "kinds = [\"cosign\"]"), "user entry takes execute or require-cosign"},
		{"user sshsig without key", userEntry(t, "format = \"sshsig\"", "kinds = [\"execute\"]"), "key: required"},
		{"user sshsig with options",
			userEntry(t, "format = \"sshsig\"\nkey = "+quote("command=\"/bin/true\" "+line), "kinds = [\"execute\"]"), "options are not allowed"},
		{"user sshsig with two lines",
			userEntry(t, "format = \"sshsig\"\nkey = "+quote(line+"\n"+line), "kinds = [\"execute\"]"), "exactly one"},
		{"webauthn without rp_id",
			userEntry(t, fmt.Sprintf("format = \"webauthn\"\nkey = \"cose:%s\"\ncredential_id = %q\norigins = [\"https://crh.example.com\"]", cose, credentialID), "kinds = [\"execute\"]"), "rp_id: required"},
		{"webauthn without origins",
			userEntry(t, fmt.Sprintf("format = \"webauthn\"\nkey = \"cose:%s\"\ncredential_id = %q\nrp_id = \"crh.example.com\"", cose, credentialID), "kinds = [\"execute\"]"), "origins:"},
		{"webauthn without credential_id",
			userEntry(t, fmt.Sprintf("format = \"webauthn\"\nkey = \"cose:%s\"\nrp_id = \"crh.example.com\"\norigins = [\"https://crh.example.com\"]", cose), "kinds = [\"execute\"]"), "credential_id"},
		{"webauthn bad origin",
			userEntry(t, fmt.Sprintf("format = \"webauthn\"\nkey = \"cose:%s\"\ncredential_id = %q\nrp_id = \"crh.example.com\"\norigins = [\"crh.example.com\"]", cose, credentialID), "kinds = [\"execute\"]"), "origin"},
		{"webauthn without cose prefix",
			userEntry(t, fmt.Sprintf("format = \"webauthn\"\nkey = %q\ncredential_id = %q\nrp_id = \"crh.example.com\"\norigins = [\"https://crh.example.com\"]", cose, credentialID), "kinds = [\"execute\"]"), `"cose:"`},
		{"webauthn bad cose key",
			userEntry(t, fmt.Sprintf("format = \"webauthn\"\nkey = \"cose:%s\"\ncredential_id = %q\nrp_id = \"crh.example.com\"\norigins = [\"https://crh.example.com\"]",
				base64.RawURLEncoding.EncodeToString([]byte{0xff}), credentialID), "kinds = [\"execute\"]"), "key:"},
		{"webauthn with uids",
			userEntry(t, fmt.Sprintf("format = \"webauthn\"\nkey = \"cose:%s\"\ncredential_id = %q\nrp_id = \"crh.example.com\"\norigins = [\"https://crh.example.com\"]\nuids = [0]", cose, credentialID), "kinds = [\"execute\"]"), "uids"},
		{"sshsig with uids", userEntry(t, "format = \"sshsig\"\nkey = "+quote(line)+"\nuids = [0]", "kinds = [\"execute\"]"), "belong to other entry types"},
		{"require_uv on a non-sk key", userEntry(t, "format = \"sshsig\"\nkey = "+quote(line), "kinds = [\"execute\"]\nrequire_uv = true"), "cannot assert user verification"},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			_, err := Parse([]byte(test.toml))
			if err == nil {
				t.Fatalf("accepted: %s", test.name)
			}
			if test.want != "" && !strings.Contains(err.Error(), test.want) {
				t.Fatalf("error %q does not contain %q", err, test.want)
			}
		})
	}
}

func quote(s string) string {
	return fmt.Sprintf("%q", s)
}

// localEntry returns a configuration with the given local entry fields after "role".
func localEntry(t *testing.T, fields string) string {
	t.Helper()
	dir := t.TempDir()
	return fmt.Sprintf(`
node_id          = "01JB0000000000000000000001"
unprivileged_uid = 998
socket           = %q
state_dir        = %q
log              = %q

[[trust]]
name = "local-admins"
role = "local"
`, filepath.Join(dir, "priv.sock"), filepath.Join(dir, "state"), filepath.Join(dir, "log.jsonl")) + fields + "\n"
}

// userEntry returns a configuration with the given user entry fields.
func userEntry(t *testing.T, keyFields, kindFields string) string {
	t.Helper()
	dir := t.TempDir()
	return fmt.Sprintf(`
node_id          = "01JB0000000000000000000001"
unprivileged_uid = 998
socket           = %q
state_dir        = %q
log              = %q

[[trust]]
name = "alice"
role = "user"
`, filepath.Join(dir, "priv.sock"), filepath.Join(dir, "state"), filepath.Join(dir, "log.jsonl")) + keyFields + "\n" + kindFields + "\n"
}

// TestLoadChecksOwnership covers the file ownership and permission check of Load.
func TestLoadChecksOwnership(t *testing.T) {
	path := filepath.Join(t.TempDir(), "privileged.toml")
	if err := os.WriteFile(path, []byte(minimalConfig(t)), 0o644); err != nil {
		t.Fatal(err)
	}
	if _, err := Load(path); err != nil {
		t.Fatalf("Load: %v", err)
	}
	for _, mode := range []os.FileMode{0o664, 0o666, 0o646} {
		if err := os.Chmod(path, mode); err != nil {
			t.Fatal(err)
		}
		_, err := Load(path)
		if err == nil {
			t.Fatalf("mode %04o accepted", mode)
		}
		if !strings.Contains(err.Error(), "group- or world-writable") {
			t.Fatalf("mode %04o: error %q", mode, err)
		}
	}
	if _, err := Load(filepath.Join(t.TempDir(), "missing.toml")); err == nil {
		t.Fatal("missing file accepted")
	}
}

// TestCheckOwnerUid covers the owner check, which cannot be provoked as a non-root user.
func TestCheckOwnerUid(t *testing.T) {
	path := filepath.Join(t.TempDir(), "privileged.toml")
	if err := os.WriteFile(path, []byte("x"), 0o600); err != nil {
		t.Fatal(err)
	}
	fi, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	if _, ok := fi.Sys().(*syscall.Stat_t); !ok {
		t.Skip("no syscall.Stat_t on this platform")
	}
	if err := checkOwner(fi, uint32(os.Geteuid())); err != nil {
		t.Fatalf("own file: %v", err)
	}
	if err := checkOwner(fi, uint32(os.Geteuid())+1); err == nil || !strings.Contains(err.Error(), "owned by uid") {
		t.Fatalf("owner mismatch: %v", err)
	}
}

// TestDefaultsAndEmptyTrust checks the defaults that remain (socket_group and clock_skew) and
// that a configuration without trust entries still produces an encodable summary.
func TestDefaultsAndEmptyTrust(t *testing.T) {
	dir := t.TempDir()
	cfg, err := Parse([]byte(fmt.Sprintf(`node_id = "n"
unprivileged_uid = 0
socket = %q
state_dir = %q
log = %q
`, filepath.Join(dir, "priv.sock"), filepath.Join(dir, "state"), filepath.Join(dir, "log.jsonl"))))
	if err != nil {
		t.Fatalf("Parse: %v", err)
	}
	if cfg.SocketGroup != DefaultSocketGroup {
		t.Fatalf("socket group = %q, want %q", cfg.SocketGroup, DefaultSocketGroup)
	}
	if cfg.ClockSkew != DefaultClockSkew {
		t.Fatalf("clock skew = %v", cfg.ClockSkew)
	}
	summary := cfg.Summary()
	if summary.Trust == nil || len(summary.Trust) != 0 {
		t.Fatalf("trust = %v", summary.Trust)
	}
	if summary.Groups == nil {
		t.Fatal("groups is nil")
	}
	if _, err := protocol.Marshal(summary); err != nil {
		t.Fatalf("encode summary: %v", err)
	}
}
