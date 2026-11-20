// One throwaway cluster for the README screenshots: crhs + web-1, db-1, app-1 (crha) + ssh-1 (sshd) + the
// scripted model. Started by run.mjs, which prepares $SHOTS_WORK (binaries, keys, TLS) and $SHOTS_IMAGE.
// usage: node cluster.mjs <locale> <port>
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmodSync, cpSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";

const [locale, portArg] = process.argv.slice(2);
if (!locale || !portArg) throw new Error("usage: up.mjs <locale> <port>");
const port = Number(portArg);
const HERE = new URL(".", import.meta.url).pathname;
const REPO = new URL("../..", import.meta.url).pathname.replace(/\/$/, "");
const WORK = process.env.SHOTS_WORK;
if (!WORK || !process.env.SHOTS_IMAGE) throw new Error("run through run.mjs: SHOTS_WORK and SHOTS_IMAGE are unset");
const D = `${WORK}/${locale}`;
const P = `crh-shot-${locale.toLowerCase()}`;
const NET = P;
const URL_ = `http://127.0.0.1:${port}`;
const IMAGE = process.env.SHOTS_IMAGE;
const NODE_IMAGE = "docker.io/library/node:26-trixie-slim";
const sh = (cmd, args, opts = {}) => execFileSync(cmd, args, { encoding: "utf8", ...opts });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(what, fn, ms = 90_000) {
	const end = Date.now() + ms;
	while (Date.now() < end) {
		const v = await fn().catch(() => undefined);
		if (v) return v;
		await sleep(500);
	}
	throw new Error(`timed out waiting for ${what}`);
}

// ---- crhs ----
mkdirSync(`${D}/crhs`, { recursive: true });
const password = randomBytes(18).toString("base64url");
writeFileSync(`${D}/admin-password`, `${password}\n`, { mode: 0o600 });
writeFileSync(
	`${D}/crhs/init.json`,
	JSON.stringify({
		version: 1,
		listen: { host: "0.0.0.0", port: 8080 },
		database: { driver: "sqlite", path: "/data/crhs.db" },
		public_url: `http://localhost:${port}`,
		admin: { username: "admin", display_name: "admin", password },
		service: { install: false },
	}),
	{ mode: 0o600 },
);
for (const name of ["tls-proxy.mjs", "tls.crt", "tls.key"]) cpSync(`${WORK}/tls/${name}`, `${D}/crhs/${name}`);
sh("podman", ["network", "create", NET]);
const crhsRun = ["--network", NET, "-v", `${REPO}:/repo:ro`, "-v", `${D}/crhs:/data`, "-w", "/repo/server"];
sh("podman", [
	"run",
	"--rm",
	...crhsRun,
	"-e",
	"CRHS_DATA_DIR=/data",
	NODE_IMAGE,
	"node",
	"src/main.ts",
	"init",
	"--answers",
	"/data/init.json",
]);
sh("rm", ["-f", `${D}/crhs/init.json`]);
let toml = readFileSync(`${D}/crhs/crhs.toml`, "utf8");
if (!/^web_root/m.test(toml)) toml = `web_root = "/repo/web/dist"\n${toml}`;
writeFileSync(`${D}/crhs/crhs.toml`, toml);
// No proof of work at sign-in: a System setting, so it goes into the database before the first start.
sh("sqlite3", [
	`${D}/crhs/crhs.db`,
	`insert into settings (org_id, key, value, updated_at) select id, 'auth.captcha', '"none"', '${new Date().toISOString()}' from orgs`,
]);
sh("podman", [
	"run",
	"-d",
	"--name",
	`${P}-crhs`,
	"--hostname",
	"crhs",
	"--network-alias",
	"crhs",
	...crhsRun.slice(2),
	"--network",
	NET,
	"-p",
	`127.0.0.1:${port}:8080`,
	NODE_IMAGE,
	"sh",
	"-c",
	"node /data/tls-proxy.mjs & exec node src/main.ts --config /data/crhs.toml",
]);

let cookie = "";
async function api(path, body, method) {
	const res = await fetch(URL_ + path, {
		method: method ?? (body === undefined ? "GET" : "POST"),
		headers: { cookie, ...(body === undefined ? {} : { "content-type": "application/json" }) },
		body: body === undefined ? undefined : JSON.stringify(body),
	});
	const text = await res.text();
	if (res.status >= 300) throw new Error(`${method ?? ""} ${path}: ${res.status} ${text}`);
	return text ? JSON.parse(text) : undefined;
}
await waitFor("crhs", async () => (await fetch(`${URL_}/api/health`)).ok);
{
	const res = await fetch(`${URL_}/api/auth/login`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ username: "admin", password }),
	});
	cookie = res.headers.get("set-cookie")?.match(/crh_session=[^;]+/)?.[0] ?? "";
	if (res.status !== 200 || !cookie) throw new Error(`login: ${res.status} ${await res.text()}`);
}
await api("/api/me/settings", { locale }, "PATCH");

// ---- model: the scripted fake (fake-model.mjs), so every run tells the same story ----
sh("podman", [
	"run",
	"-d",
	"--name",
	`${P}-model`,
	"--network",
	NET,
	"--network-alias",
	"fake-model",
	"-v",
	`${HERE}fake-model.mjs:/fake-model.mjs:ro`,
	NODE_IMAGE,
	"node",
	"/fake-model.mjs",
]);
await api(
	"/api/model-providers/demo",
	{
		kind: "custom",
		name: "Demo",
		baseUrl: "http://fake-model:9000/v1",
		apiKey: "demo",
		models: [
			{
				id: "demo",
				name: "Demo model",
				api: "openai-completions",
				contextWindow: 128000,
				maxTokens: 8192,
				input: ["text"],
			},
		],
	},
	"PUT",
);
await api("/api/me/settings", { defaultModel: { provider: "demo", modelId: "demo" } }, "PATCH");
// Passkeys for localhost: the screenshots register one with a virtual authenticator.
await api("/api/settings", { webauthn: { rpId: "localhost", origins: [`http://localhost:${port}`] } }, "PATCH");

const groupIds = {};
for (const name of ["web", "db", "app", "ssh"]) groupIds[name] = (await api("/api/node-groups", { name })).group.id;
const userKey = readFileSync(`${WORK}/signing/admin-signing.pub`, "utf8").trim();
const crhsKey = (await api("/api/privilege/crhs-key")).key.authorizedKey;
{
	// Register the admin's signing key with proof of possession, so crhs offers the signature on db-1.
	const { challenge } = await api("/api/me/signing-credentials/ssh/challenge", {});
	const signature = sh(`${WORK}/bin/crhu`, ["register", challenge, "--key", `${WORK}/signing/admin-signing`]).trim();
	await api("/api/me/signing-credentials/ssh", { signature, name: "admin-signing" });
}

const nodes = [
	{
		name: "web-1",
		mode: "forward",
		groups: ["web"],
		trust: [
			{ name: "crhs", role: "crhs", format: "sshsig", key: crhsKey, kinds: ["execute"] },
			{ name: "admin", role: "user", format: "sshsig", key: userKey, kinds: ["execute"] },
			{ name: "local-root", role: "local", uids: [0], kinds: ["execute"] },
		],
	},
	{
		name: "db-1",
		mode: "forward",
		groups: ["db"],
		trust: [
			{ name: "admin", role: "user", format: "sshsig", key: userKey, kinds: ["execute"] },
			{ name: "local-root", role: "local", uids: [0], kinds: ["execute"] },
		],
	},
	{ name: "app-1", mode: "native", groups: ["app"], trust: null },
];
const q = (s) => JSON.stringify(s);
function trustToml(e) {
	const l = ["[[trust]]", `name = ${q(e.name)}`, `role = ${q(e.role)}`];
	if (e.format) l.push(`format = ${q(e.format)}`);
	if (e.key) l.push(`key = ${q(e.key)}`);
	if (e.uids) l.push(`uids = [${e.uids.join(", ")}]`);
	if (e.role !== "local") l.push(`kinds = [${e.kinds.map(q).join(", ")}]`);
	return l.join("\n");
}
function hostKeys(name) {
	const dir = `${D}/${name}/ssh`;
	mkdirSync(dir, { recursive: true });
	sh("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-C", name, "-f", `${dir}/ssh_host_ed25519_key`]);
	writeFileSync(`${dir}/authorized_keys`, "");
	return dir;
}

for (const n of nodes) {
	const cfg = `${D}/${n.name}/config`;
	mkdirSync(cfg, { recursive: true });
	chmodSync(cfg, 0o777);
	const ssh = hostKeys(n.name);
	writeFileSync(
		`${cfg}/crha.toml`,
		[
			'server = "https://crhs:8443"',
			'tls_verify = "none"',
			'state_dir = "/var/lib/crha"',
			"",
			"[privileged]",
			`mode = "${n.mode}"`,
			'socket = "/run/crha/privileged.sock"',
			'native = "sudo"',
			"",
			"[output]",
			'dir = "/var/lib/crha/output"',
			"",
		].join("\n"),
	);
	const cname = `${P}-${n.name}`;
	sh("podman", [
		"run",
		"-d",
		"--name",
		cname,
		"--hostname",
		n.name,
		"--network",
		NET,
		"--init",
		"-e",
		"PRIV_NO_SSHD=1",
		"-v",
		`${cfg}:/etc/crha:rw`,
		"-v",
		`${ssh}:/opt/crh/ssh:ro`,
		"-v",
		`${WORK}/bin/crha:/usr/local/bin/crha:ro`,
		IMAGE,
	]);
	const { token } = await api("/api/enrollment-tokens", { nameHint: n.name });
	const out = sh(
		"podman",
		["exec", "-i", "--user", "998", cname, "/usr/local/bin/crha", "register", "--config", "/etc/crha/crha.toml"],
		{ input: `${token}\n` },
	);
	const id = /enrolled as node ([^\s,]+)/.exec(out)?.[1];
	if (!id) throw new Error(`enroll ${n.name}: ${out}`);
	n.id = id;
	await waitFor(`${n.name} pending`, async () => (await api("/api/nodes")).nodes.find((x) => x.id === id));
	await api(`/api/nodes/${id}/approve`, {});
	await api(`/api/nodes/${id}/node-groups`, { nodeGroups: n.groups }, "PUT");
	if (n.trust)
		writeFileSync(
			`${cfg}/privileged.toml`,
			[
				`node_id = "${id}"`,
				"unprivileged_uid = 998",
				'clock_skew = "60s"',
				'socket = "/run/crha/privileged.sock"',
				'state_dir = "/var/lib/crha-privileged"',
				'log = "/var/log/crha/privileged.jsonl"',
				`aliases = [${n.groups.map((g) => q(groupIds[g])).join(", ")}]`,
				"",
				...n.trust.map(trustToml).flatMap((t) => [t, ""]),
			].join("\n"),
		);
	writeFileSync(`${cfg}/.ready`, "ready\n");
	await waitFor(`${n.name} connected`, async () => (await api(`/api/nodes/${id}`)).node.connected === true);
	if (n.mode === "native") sh("podman", ["exec", cname, "/usr/local/bin/privctl.sh", "stop-priv"]);
	console.log(`${n.name}: ${id}`);
}

{
	const ssh = hostKeys("ssh-1");
	sh("podman", [
		"run",
		"-d",
		"--name",
		`${P}-ssh-1`,
		"--hostname",
		"ssh-1",
		"--network",
		NET,
		"--init",
		"-v",
		`${ssh}:/opt/crh/ssh:ro`,
		"-v",
		`${WORK}/sshd_config:/etc/ssh/sshd_config.shots:ro`,
		"--entrypoint",
		"/bin/sh",
		IMAGE,
		"-c",
		"mkdir -p /run/sshd && exec /usr/sbin/sshd -D -e -f /etc/ssh/sshd_config.shots",
	]);
	const { credential } = await api("/api/ssh-credentials", { name: "demo-root" });
	writeFileSync(`${ssh}/authorized_keys`, `${credential.publicKey.trim()}\n`);
	const target = { host: "ssh-1", port: 22, user: "root", credentialId: credential.id };
	const hostFingerprint = await waitFor("sshd", async () => (await api("/api/ssh-nodes/probe", target)).fingerprint);
	const { node } = await api("/api/ssh-nodes", { name: "ssh-1", ...target, hostFingerprint });
	await api(`/api/nodes/${node.id}/node-groups`, { nodeGroups: ["ssh"] }, "PUT");
	console.log(`ssh-1: ${node.id}`);
}

for (const n of nodes.filter((x) => x.trust)) {
	const t = await waitFor(
		`${n.name} trust`,
		async () => {
			const r = (await api(`/api/nodes/${n.id}/trust`)).trust;
			return r.status !== "unknown" && r.status !== "pending" ? r : undefined;
		},
		30_000,
	).catch(() => undefined);
	console.log(`${n.name} trust: ${t?.status ?? "?"}`);
}
writeFileSync(
	`${D}/cluster.json`,
	JSON.stringify({ prefix: P, nodes: Object.fromEntries(nodes.map((n) => [n.name, n.id])), groups: groupIds }),
);
console.log(`${locale}: ready on ${URL_}`);
