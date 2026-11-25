// README screenshots (scripts/readme-shots/README.md): one throwaway cluster per locale, a scripted model,
// the desktop and phone shots, the composed hero image, then everything is removed.
//
//   node scripts/readme-shots/run.mjs [--write] [--keep] [--locale en|zh-CN]
//   node scripts/readme-shots/run.mjs --down <work dir>
import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";

const HERE = new URL(".", import.meta.url).pathname;
const REPO = join(HERE, "../..");
const LOCALES = ["en", "zh-CN"];
const { values } = parseArgs({
	options: {
		write: { type: "boolean", default: false },
		keep: { type: "boolean", default: false },
		locale: { type: "string", multiple: true },
		down: { type: "string" },
	},
});
const sh = (cmd, args, opts = {}) =>
	execFileSync(cmd, args, { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"], ...opts });
const say = (line) => console.log(`readme-shots: ${line}`);

/** Removes one locale's containers, network and files. */
function down(work, locale) {
	const prefix = `crh-shot-${locale.toLowerCase()}`;
	const names = ["crhs", "web-1", "db-1", "app-1", "ssh-1", "model"].map((n) => `${prefix}-${n}`);
	try {
		sh("podman", ["rm", "-f", "-t", "2", ...names], { stdio: "ignore" });
	} catch {}
	try {
		sh("podman", ["network", "rm", prefix], { stdio: "ignore" });
	} catch {}
	// Files written by the containers belong to subordinate ids: remove them inside the user namespace.
	sh("podman", ["unshare", "rm", "-rf", join(work, locale)]);
}

if (values.down) {
	for (const locale of LOCALES) down(values.down, locale);
	sh("podman", ["unshare", "rm", "-rf", values.down]);
	say(`removed ${values.down}`);
	process.exit(0);
}

const locales = values.locale ?? LOCALES;
for (const locale of locales) if (!LOCALES.includes(locale)) throw new Error(`unknown locale ${locale}`);

const work = mkdtempSync(join(tmpdir(), "crh-readme-shots-"));
const out = join(work, "out");
mkdirSync(out);
say(`work dir ${work}`);

/** The privileged system suite's image, tagged by the hash of what is baked into it (its harness does the same). */
function ensureImage() {
	const suite = join(REPO, "server/test/system/privileged");
	const hash = createHash("sha256");
	for (const name of ["Containerfile", "entrypoint.sh", "privctl.sh", "fixtures/sshd_config"])
		hash.update(readFileSync(join(suite, name)));
	const tag = `crh-privileged-system:${hash.digest("hex").slice(0, 12)}`;
	try {
		sh("podman", ["image", "exists", tag]);
	} catch {
		say(`building ${tag}`);
		sh("podman", ["build", "-t", tag, "-f", join(suite, "Containerfile"), suite], { stdio: "inherit" });
	}
	return tag;
}

function prepare() {
	say("building the WebUI, crha and crhu");
	sh("pnpm", ["--filter", "@crh/web", "build"], { cwd: REPO, stdio: "ignore" });
	mkdirSync(join(work, "bin"));
	for (const cmd of ["crha", "crhu"]) {
		sh("go", ["build", "-o", join(work, "bin", cmd), `./cmd/${cmd}`], {
			cwd: join(REPO, "client"),
			env: { ...process.env, CGO_ENABLED: "0" },
		});
	}
	// The admin's signing key: trusted by web-1 and db-1, registered with crhs.
	mkdirSync(join(work, "signing"));
	sh("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-C", "admin-signing", "-f", join(work, "signing/admin-signing")]);
	// crha only dials https to a non-loopback host; crhs is plain http, so a small TLS terminator fronts it.
	const tls = join(work, "tls");
	mkdirSync(tls);
	sh(
		"openssl",
		[
			"req",
			"-x509",
			"-newkey",
			"ec",
			"-pkeyopt",
			"ec_paramgen_curve:prime256v1",
			"-nodes",
			"-days",
			"2",
			"-subj",
			"/CN=crhs",
			"-addext",
			"subjectAltName=DNS:crhs",
			"-keyout",
			join(tls, "tls.key"),
			"-out",
			join(tls, "tls.crt"),
		],
		{ stdio: "ignore" },
	);
	writeFileSync(
		join(tls, "tls-proxy.mjs"),
		`import { readFileSync } from "node:fs";
import net from "node:net";
import tls from "node:tls";
tls.createServer({ key: readFileSync("/data/tls.key"), cert: readFileSync("/data/tls.crt") }, (s) => {
	const u = net.connect(8080, "127.0.0.1");
	s.pipe(u).pipe(s);
	s.on("error", () => u.destroy());
	u.on("error", () => s.destroy());
}).listen(8443, "0.0.0.0");
`,
	);
	writeFileSync(
		join(work, "sshd_config"),
		[
			"Port 22",
			"ListenAddress 0.0.0.0",
			"HostKey /opt/crh/ssh/ssh_host_ed25519_key",
			"PidFile /run/sshd.pid",
			"AuthorizedKeysFile /opt/crh/ssh/authorized_keys",
			"PermitRootLogin prohibit-password",
			"PasswordAuthentication no",
			"KbdInteractiveAuthentication no",
			"UsePAM no",
			"StrictModes no",
			"Subsystem sftp /usr/lib/openssh/sftp-server",
			"",
		].join("\n"),
	);
	return ensureImage();
}

const freePort = () =>
	new Promise((resolve, reject) => {
		const server = createServer();
		server.on("error", reject);
		server.listen(0, "127.0.0.1", () => {
			const { port } = server.address();
			server.close(() => resolve(port));
		});
	});

/** Runs one of the scripts here with the shared environment; its output is prefixed with the locale. */
const step = (locale, script, args, env) =>
	new Promise((resolve, reject) => {
		const child = spawn(process.execPath, [join(HERE, script), ...args], { env, stdio: ["ignore", "pipe", "pipe"] });
		const relay = (stream, sink) => {
			let rest = "";
			stream.setEncoding("utf8");
			stream.on("data", (chunk) => {
				const lines = (rest + chunk).split("\n");
				rest = lines.pop() ?? "";
				for (const line of lines) sink.write(`[${locale}] ${line}\n`);
			});
		};
		relay(child.stdout, process.stdout);
		relay(child.stderr, process.stderr);
		child.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`${script} ${locale} exited with ${code}`))));
	});

let failed = false;
try {
	const image = prepare();
	const env = { ...process.env, SHOTS_WORK: work, SHOTS_IMAGE: image };
	await Promise.all(
		locales.map(async (locale) => {
			const port = await freePort();
			await step(locale, "cluster.mjs", [locale, String(port)], env);
			await step(locale, "shoot.mjs", [locale, String(port), out], env);
			await step(locale, "compose.mjs", [locale, out], env);
		}),
	);
	if (values.write) {
		for (const locale of locales) {
			for (const name of ["hero", "node-metrics", "node-trust"]) {
				copyFileSync(join(out, `${name}.${locale}.png`), join(REPO, "doc/images", `${name}.${locale}.png`));
			}
		}
		say("wrote doc/images");
	}
	say(`shots in ${out}: ${readdirSync(out).sort().join(", ")}`);
} catch (err) {
	failed = true;
	console.error(err);
	say(`failed; screenshots of the failing page, if any, are ${work}/debug-*.png`);
} finally {
	if (values.keep) say(`kept; remove with: node scripts/readme-shots/run.mjs --down ${work}`);
	else for (const locale of locales) down(work, locale);
}
process.exitCode = failed ? 1 : 0;
