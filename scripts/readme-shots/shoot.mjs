// usage: node shoot.mjs <locale> <port> <outdir>   (run.mjs starts it with $SHOTS_WORK set)
// Desktop: session, node-trust and node-metrics. Phone: the same signature request, signed with a Passkey.
import { execFileSync } from "node:child_process";
import { appendFileSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";

const [locale, port, out] = process.argv.slice(2);
const require = createRequire(new URL("../../web/package.json", import.meta.url));
const { chromium } = require("@playwright/test");
const WORK = process.env.SHOTS_WORK;
const D = `${WORK}/${locale}`;
const cluster = JSON.parse(readFileSync(`${D}/cluster.json`, "utf8"));
const password = readFileSync(`${D}/admin-password`, "utf8").trim();
const base = `http://localhost:${port}`;
const en = locale === "en";
const L = en
	? {
			table: "Show the OS release, the nginx status and the number of running processes on every node, as a table.",
			sign: "Check disk usage on all nodes and tell me which one is closest to full. Then clean the apt cache on db-1 (needs root).",
			approve: "Approve",
			register: "Register Passkey",
			passkey: "My phone",
			details: "Technical details",
			metrics: "Metrics",
		}
	: {
			table: "以表格列出每个节点的系统版本、nginx 状态和正在运行的进程数。",
			sign: "检查所有节点的磁盘用量，告诉我哪个最接近写满。然后清理 db-1 上的 apt 缓存（需要 root）。",
			approve: "批准",
			register: "注册 Passkey",
			passkey: "我的手机",
			details: "技术信息",
			metrics: "指标",
		};

const browser = await chromium.launch();
const context = await browser.newContext({
	viewport: { width: 1440, height: 900 },
	deviceScaleFactor: 2,
	locale: en ? "en-US" : "zh-CN",
	colorScheme: "light",
});
const page = await context.newPage();
const shot = (name) => page.screenshot({ path: `${out}/${name}.${locale}.png` });
const debug = (name) => page.screenshot({ path: `${WORK}/debug-${locale}-${name}.png` });
const settle = async (ms = 1_500) => {
	await page.waitForTimeout(ms);
	await page.mouse.move(0, page.viewportSize().height - 1);
};
const api = async (path) => (await page.request.get(`${base}${path}`)).json();

try {
	await page.goto(`${base}/login`);
	await page.locator('input[autocomplete="username"]').fill("admin");
	await page.locator('input[type="password"]').fill(password);
	await page.keyboard.press("Enter");
	await page.waitForURL(/\/sessions/);

	// ---- a Passkey on a virtual authenticator, trusted by db-1 ----
	const cdp = await context.newCDPSession(page);
	await cdp.send("WebAuthn.enable");
	await cdp.send("WebAuthn.addVirtualAuthenticator", {
		options: {
			protocol: "ctap2",
			transport: "internal",
			hasResidentKey: true,
			hasUserVerification: true,
			isUserVerified: true,
			automaticPresenceSimulation: true,
		},
	});
	await page.goto(`${base}/signing-credentials`);
	await page.locator("#passkey-name").fill(L.passkey);
	await page.getByRole("button", { name: L.register }).click();
	let passkey;
	for (let i = 0; i < 40 && !passkey; i++) {
		await page.waitForTimeout(500);
		passkey = (await api("/api/me/signing-credentials")).signingCredentials.find((c) => c.kind === "webauthn");
	}
	if (!passkey) throw new Error("the Passkey was not registered");
	const cose = Buffer.from(passkey.publicKey, "base64").toString("base64url");
	appendFileSync(
		`${D}/db-1/config/privileged.toml`,
		[
			"",
			"[[trust]]",
			'name = "admin-phone"',
			'role = "user"',
			'format = "webauthn"',
			`rp_id = ${JSON.stringify(passkey.rpId)}`,
			`origins = ${JSON.stringify(passkey.origins)}`,
			`credential_id = ${JSON.stringify(passkey.credentialId)}`,
			`key = "cose:${cose}"`,
			'kinds = ["execute"]',
			"",
		].join("\n"),
	);
	execFileSync("podman", ["exec", `${cluster.prefix}-db-1`, "/usr/local/bin/privctl.sh", "hup-priv"]);
	const dbId = cluster.nodes["db-1"];
	for (let i = 0; ; i++) {
		const trust = JSON.stringify(await api(`/api/nodes/${dbId}/trust`));
		if (trust.includes("admin-phone") && trust.includes('"ok"')) break;
		if (i > 60) throw new Error(`db-1 did not report the Passkey: ${trust.slice(0, 400)}`);
		await page.waitForTimeout(500);
	}

	// ---- sessions ----
	const ask = async (prompt) => {
		await page.goto(`${base}/sessions`);
		await page.getByTestId("new-session-button").click();
		const input = page.getByTestId("new-session-input");
		await input.waitFor();
		await page.waitForTimeout(1_500);
		for (let attempt = 0; attempt < 5; attempt++) {
			await input.fill(prompt);
			await page.waitForTimeout(500);
			if ((await input.inputValue().catch(() => "")) !== prompt) continue;
			await input.press("Enter");
			try {
				await page.waitForURL(/\/sessions\/[0-9a-f-]{36}/, { timeout: 15_000 });
				break;
			} catch {}
		}
		if (!/\/sessions\/[0-9a-f-]{36}/.test(page.url())) throw new Error("the prompt was not sent");
		return page.url();
	};
	// A fresh crhs has no rules, so ordinary commands wait for an approval: approve them as they come.
	const approveUntil = async (done, ms = 180_000) => {
		const end = Date.now() + ms;
		const approve = page.getByTestId("session-decisions").getByRole("button", { name: L.approve, exact: true });
		while (Date.now() < end) {
			if (await done()) return;
			if (await approve.isVisible().catch(() => false)) await approve.click().catch(() => {});
			await page.waitForTimeout(700);
		}
		throw new Error("timed out");
	};
	const signing = page.getByTestId("session-decisions").getByRole("tab", { name: "Passkey", exact: true });

	const tableUrl = await ask(L.table);
	await approveUntil(() => page.getByTestId("turn-summary").first().isVisible());

	const signUrl = await ask(L.sign);
	await approveUntil(() => signing.isVisible());

	await page.goto(tableUrl);
	await page.getByTestId("turn-summary").first().waitFor();
	await settle();
	await shot("session");

	// Both node shots need more height than a 1440x900 viewport: the Technical details tab puts the trust
	// table below the facts, and the Metrics tab puts the network chart and the availability strip below the
	// first rows. The width and the 2x scale stay those of the other desktop shots.
	await page.setViewportSize({ width: 1440, height: 1470 });
	await page.goto(`${base}/nodes/${dbId}`);
	await page.getByRole("tab", { name: L.details }).click();
	await page.getByTestId("node-detail").evaluate((el) => {
		el.scrollTop = 0;
	});
	await settle(2_500);
	await shot("node-trust");

	// The Metrics tab is summary-free; the range picker and the charts follow the tabs.
	await page.getByRole("tab", { name: L.metrics, exact: true }).click();
	await page.getByTestId("metrics-range-1h").click();
	await page.getByTestId("metrics-plot-cpu").waitFor({ timeout: 30_000 });
	await page.getByTestId("metrics-chart-availability").waitFor({ timeout: 30_000 });
	await page.getByTestId("metrics-plot-network").waitFor({ timeout: 30_000 });
	await page.getByTestId("node-detail").evaluate((el) => {
		el.scrollTop = 0;
	});
	await settle(3_000);
	await shot("node-metrics");

	// ---- phone ----
	await page.setViewportSize({ width: 390, height: 844 });
	await page.goto(signUrl);
	await signing.waitFor();
	await settle(2_500);
	await shot("phone-signature");
	console.log(`done ${locale}`);
} catch (err) {
	await debug("error");
	throw err;
} finally {
	await browser.close();
}
