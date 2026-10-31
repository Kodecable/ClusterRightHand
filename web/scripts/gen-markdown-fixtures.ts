/**
 * Deterministic fixture generator for the streaming-Markdown benchmark.
 *
 * Run with `node scripts/gen-fixtures.ts` (Node's type stripping). The output is
 * byte-for-byte reproducible: every random choice comes from a seeded PRNG.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = join(ROOT, "src", "markdown", "__fixtures__");

/* ------------------------------------------------------------------- random */

type Rng = () => number;

function mulberry32(seed: number): Rng {
	let a = seed >>> 0;
	return () => {
		a = (a + 0x6d2b79f5) >>> 0;
		let t = a;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

function pick<T>(rng: Rng, values: readonly T[]): T {
	const value = values[Math.floor(rng() * values.length)];
	if (value === undefined) throw new Error("pick from empty list");
	return value;
}

function int(rng: Rng, min: number, max: number): number {
	return min + Math.floor(rng() * (max - min + 1));
}

/* --------------------------------------------------------------- code text */

const CODE_SAMPLES: Array<{ lang: string; body: string }> = [
	{
		lang: "bash",
		body: [
			"set -euo pipefail",
			// biome-ignore lint/suspicious/noTemplateCurlyInString: this is shell source, not a template.
			"NAMESPACE=${NAMESPACE:-prod}",
			'kubectl -n "$NAMESPACE" rollout status deploy/api --timeout=120s',
			'kubectl -n "$NAMESPACE" get pods -l app=api -o wide',
			'echo "rollout of api in $NAMESPACE complete"',
		].join("\n"),
	},
	{
		lang: "shellsession",
		body: [
			"$ kubectl get nodes",
			"NAME        STATUS   ROLES    AGE   VERSION",
			"worker-01   Ready    <none>   42d   v1.32.4",
			"worker-02   Ready    <none>   42d   v1.32.4",
			"$ kubectl describe node worker-01 | head -4",
			"Name:               worker-01",
			"Roles:              <none>",
			"Labels:             kubernetes.io/hostname=worker-01",
		].join("\n"),
	},
	{
		lang: "json",
		body: [
			"{",
			'  "apiVersion": "apps/v1",',
			'  "kind": "Deployment",',
			'  "metadata": { "name": "api", "namespace": "prod" },',
			'  "spec": {',
			'    "replicas": 3,',
			'    "template": {',
			'      "spec": { "containers": [{ "name": "api", "image": "ghcr.io/acme/api:1.4.2" }] }',
			"    }",
			"  }",
			"}",
		].join("\n"),
	},
	{
		lang: "yaml",
		body: [
			"apiVersion: apps/v1",
			"kind: Deployment",
			"metadata:",
			"  name: api",
			"  namespace: prod",
			"spec:",
			"  replicas: 3",
			"  selector:",
			"    matchLabels: { app: api }",
			"  template:",
			"    metadata:",
			"      labels: { app: api }",
		].join("\n"),
	},
	{
		lang: "diff",
		body: [
			"--- a/deploy/api.yaml",
			"+++ b/deploy/api.yaml",
			"@@ -12,7 +12,7 @@ spec:",
			"   replicas: 3",
			"-  image: ghcr.io/acme/api:1.4.1",
			"+  image: ghcr.io/acme/api:1.4.2",
			"   resources:",
			"     limits: { cpu: 500m, memory: 512Mi }",
		].join("\n"),
	},
	{
		lang: "ini",
		body: [
			"[api]",
			"host = 0.0.0.0",
			"port = 8080",
			"log_level = info",
			"",
			"[telemetry]",
			"endpoint = https://otel.acme.internal:4317",
			"sample_rate = 0.25",
		].join("\n"),
	},
	{
		lang: "toml",
		body: [
			"[service]",
			'name = "api"',
			"port = 8080",
			"",
			"[limits]",
			'cpu = "500m"',
			'memory = "512Mi"',
			"",
			"[[probes]]",
			'path = "/healthz"',
			'period = "10s"',
		].join("\n"),
	},
	{
		lang: "dockerfile",
		body: [
			"FROM node:26-alpine AS build",
			"WORKDIR /app",
			"COPY package.json pnpm-lock.yaml ./",
			"RUN corepack enable && pnpm install --frozen-lockfile",
			"COPY . .",
			"RUN pnpm build",
			"FROM node:26-alpine",
			"COPY --from=build /app/dist /app/dist",
			'CMD ["node", "dist/server.js"]',
		].join("\n"),
	},
	{
		lang: "python",
		body: [
			"import json",
			"import os",
			"from pathlib import Path",
			"",
			"def load_manifest(path: str) -> dict:",
			"    data = json.loads(Path(path).read_text())",
			'    data.setdefault("replicas", 3)',
			"    return data",
			"",
			'if __name__ == "__main__":',
			'    print(load_manifest(os.environ["MANIFEST"]))',
		].join("\n"),
	},
	{
		lang: "go",
		body: [
			"package main",
			"",
			'import "fmt"',
			"",
			"func main() {",
			'\tpods := []string{"api-0", "api-1", "api-2"}',
			"\tfor i, pod := range pods {",
			'\t\tfmt.Printf("%d: %s ready\\n", i, pod)',
			"\t}",
			"}",
		].join("\n"),
	},
	{
		lang: "typescript",
		body: [
			"type Rollout = { name: string; replicas: number; image: string };",
			"",
			"export async function rollout(deploy: Rollout): Promise<void> {",
			// biome-ignore lint/suspicious/noTemplateCurlyInString: this is TypeScript source, not a template.
			"  const res = await fetch(`/api/v1/deployments/${deploy.name}`, {",
			'    method: "PATCH",',
			"    body: JSON.stringify({ replicas: deploy.replicas, image: deploy.image }),",
			"  });",
			// biome-ignore lint/suspicious/noTemplateCurlyInString: this is TypeScript source, not a template.
			"  if (!res.ok) throw new Error(`rollout failed: ${res.status}`);",
			"}",
		].join("\n"),
	},
	{
		lang: "javascript",
		body: [
			"const poll = async (url, tries = 5) => {",
			"  for (let i = 0; i < tries; i += 1) {",
			"    const res = await fetch(url);",
			"    if (res.ok) return res.json();",
			"    await new Promise((resolve) => setTimeout(resolve, 500));",
			"  }",
			'  throw new Error("timed out");',
			"};",
		].join("\n"),
	},
	{
		lang: "sql",
		body: [
			"SELECT d.name,",
			"       count(*) FILTER (WHERE p.phase = 'Running') AS running,",
			"       max(p.restart_count) AS restarts",
			"FROM deployments d",
			"JOIN pods p ON p.deployment_id = d.id",
			"WHERE d.namespace = 'prod'",
			"GROUP BY d.name",
			"ORDER BY restarts DESC;",
		].join("\n"),
	},
	{
		lang: "nginx",
		body: [
			"upstream api {",
			"  server 10.0.0.11:8080 max_fails=3 fail_timeout=10s;",
			"  server 10.0.0.12:8080 max_fails=3 fail_timeout=10s;",
			"}",
			"",
			"server {",
			"  listen 443 ssl http2;",
			"  server_name api.acme.internal;",
			"  location / { proxy_pass http://api; proxy_read_timeout 60s; }",
			"}",
		].join("\n"),
	},
	{
		lang: "ansi",
		body: [
			"\u001b[32mINFO\u001b[0m  controller  starting reconcile loop",
			"\u001b[34mDEBUG\u001b[0m watcher     resync period 30s",
			"\u001b[33mWARN\u001b[0m  deploy      api rollout 2/3 ready",
			"\u001b[31mERROR\u001b[0m probe       readiness failed: connection refused",
			"\u001b[38;5;214mTRACE\u001b[0m http        GET /healthz 200 3ms",
			"\u001b[1;36mINFO\u001b[0m  scheduler   placed api-2 on worker-02",
			"\u001b[31;1mFATAL\u001b[0m kubelet     node worker-03 not ready",
		].join("\n"),
	},
	{
		lang: "robot",
		body: [
			"START JOB scan.prod",
			"  MOVE ARM 12 4",
			"  IF SENSOR > 0.5 THEN",
			'    REPORT "hot"',
			"  END",
			"END JOB",
		].join("\n"),
	},
];

const LANG_ORDER = [
	"bash",
	"shellsession",
	"json",
	"yaml",
	"diff",
	"ini",
	"toml",
	"dockerfile",
	"python",
	"go",
	"typescript",
	"javascript",
	"sql",
	"nginx",
	"ansi",
	"robot",
];

/* ---------------------------------------------------------- big code block */

function bigPythonBlock(lines: number): string {
	const out: string[] = ["# generated tuning constants for the scheduler (do not edit)"];
	for (let i = 1; i <= lines; i += 1) {
		const id = String(i).padStart(4, "0");
		out.push(`TUNE_${id} = ${i % 97}`);
	}
	return out.join("\n");
}

/* -------------------------------------------------------------- documents */

const NAMES = ["worker-01", "worker-02", "worker-03", "api-0", "api-1", "api-2", "etcd-0", "ingress-7f9c"];
const METRICS = ["p99 latency", "error rate", "queue depth", "restart count", "CPU saturation", "memory pressure"];
const ACTIONS = [
	"drained the node",
	"rotated the certificate",
	"rolled back the image",
	"scaled the deployment",
	"replayed the event log",
];
const REASONS = [
	"a noisy neighbour",
	"a stale leader lease",
	"an OOM kill",
	"a misconfigured probe",
	"a partial write",
];

function paragraph(rng: Rng, index: number): string {
	const name = pick(rng, NAMES);
	const metric = pick(rng, METRICS);
	const action = pick(rng, ACTIONS);
	const reason = pick(rng, REASONS);
	const minutes = int(rng, 2, 55);
	return [
		`**Observation ${index}.** The ${metric} on \`${name}\` stayed above target for *${minutes} minutes*;`,
		`the on-call rotated through \`kubectl -n prod describe pod/${name}\` and ${action} after`,
		`${int(rng, 2, 7)} attempts. The root cause was ${reason}, and the rollback was verified with`,
		`[the runbook][runbook] plus \`curl -fsS http://127.0.0.1:9000/healthz\`.`,
	].join(" ");
}

function fillerSection(rng: Rng, index: number): string {
	const parts: string[] = [];
	parts.push(`## Observation ${index}\n`);
	parts.push(`${paragraph(rng, index)}\n`);
	parts.push(`${paragraph(rng, index + 1)}\n`);
	if (index % 3 === 0) {
		parts.push(
			`${[
				"- first check: `kubectl get events -A --field-selector reason=FailedMount`",
				`- second check: dashboards for **${pick(rng, METRICS)}**`,
				"  - nested: compare against the 7 day baseline",
				"  - nested: confirm the rollout window",
				"1. capture the evidence bundle",
				"2. page the service owner",
				"3. open an incident in the tracker",
				"",
				`> ${pick(rng, ACTIONS)} while the ${pick(rng, METRICS)} was still elevated.`,
				">",
				"> The follow-up ticket references [the dashboard][dashboards].",
				"",
			].join("\n")}\n`,
		);
	}
	if (index % 4 === 0) {
		parts.push(
			`${[
				"- [x] confirm the alert fired",
				"- [x] attach `journalctl -u kubelet --since -15min`",
				"- [ ] write the postmortem",
				"",
			].join("\n")}\n`,
		);
	}
	return parts.join("");
}

function tablesBlock(): string {
	const simple = [
		"| Service | Replicas | Ready |",
		"| --- | ---: | :---: |",
		"| api | 3 | yes |",
		"| worker | 5 | yes |",
		"| ingest | 2 | no |",
		"",
	].join("\n");

	const aligned = [
		"| Metric | p50 | p95 | p99 |",
		"| --- | --- | --- | --- |",
		"| `http_request_duration_seconds` | 0.04 | 0.31 | 1.82 |",
		"| `queue_wait_seconds` | 0.01 | 0.09 | 0.44 |",
		"| `etcd_disk_wal_fsync_seconds` | 0.002 | 0.011 | 0.061 |",
		"| `kubelet_pod_start_seconds` | 0.8 | 2.4 | 7.9 |",
		"",
	].join("\n");

	const wideHeader = [
		"zone",
		"region",
		"node",
		"pods",
		"cpu",
		"mem",
		"disk",
		"net",
		"p99",
		"errors",
		"restarts",
		"age",
	];
	const wide = [
		`| ${wideHeader.join(" | ")} |`,
		`| ${wideHeader.map(() => "---").join(" | ")} |`,
		"| eu-west-1a | eu-west | worker-01 | 42 | 61% | 74% | 12% | 340 Mbps | 0.21s | 0 | 0 | 42d |",
		"| eu-west-1b | eu-west | worker-02 | 38 | 58% | 69% | 9% | 210 Mbps | 0.19s | 1 | 0 | 42d |",
		"| eu-west-1c | eu-west | worker-03 | 51 | 77% | 81% | 31% | 120 Mbps | 1.94s | 14 | 3 | 11d |",
		"| us-east-1a | us-east | worker-04 | 33 | 44% | 52% | 6% | 470 Mbps | 0.12s | 0 | 0 | 42d |",
		"| us-east-1b | us-east | worker-05 | 29 | 39% | 47% | 5% | 390 Mbps | 0.11s | 0 | 0 | 42d |",
		"",
	].join("\n");

	return `## Signals\n\n${simple}\n${aligned}\n### Wide table\n\n${wide}`;
}

interface DocSpec {
	name: string;
	target: number;
	bigLines: number;
	seed: number;
}

function buildDoc(spec: DocSpec): string {
	const rng = mulberry32(spec.seed);
	const parts: string[] = [];

	parts.push(`# ClusterRightHand incident brief — ${spec.name}\n`);
	parts.push(
		[
			"This brief was assembled automatically from the **ops agent** transcript, the *incident*",
			"channel and the `kubectl` audit log. Start with [the runbook][runbook] and the",
			"[dashboards][dashboards]; the raw export is linked in [the incident log][incident-log].",
			"",
		].join("\n"),
	);

	parts.push("## Summary\n");
	parts.push(`${paragraph(rng, 1)}\n`);
	parts.push(`${paragraph(rng, 2)}\n`);

	// Setext heading (level 1) followed by a level 2 setext heading.
	parts.push("Overview of the rollout\n=======================\n");
	parts.push(`${paragraph(rng, 3)}\n`);
	parts.push("What changed\n------------\n");
	parts.push(`${paragraph(rng, 4)}\n`);

	parts.push("### Lists\n");
	parts.push(
		`${[
			"- controller loop",
			"  - reconcile every 30s",
			"  - resync every 5m",
			"    - *deep* nesting level three",
			"    - second item at level three",
			"- watcher",
			"  1. list pods",
			"  2. watch events",
			"  3. record metrics",
			"",
			"- [x] drain worker-03",
			"- [x] verify pod disruption budgets",
			"- [ ] re-run the canary",
			"",
			"> The agent decided to halt the rollout after **two** failed health checks.",
			">",
			"> > Nested quote: the on-call confirmed the pause at 14:02 UTC.",
			"",
		].join("\n")}\n`,
	);

	parts.push("### Tables\n");
	parts.push(`${tablesBlock()}\n`);

	parts.push("## Code samples\n");
	for (const lang of LANG_ORDER) {
		const sample = CODE_SAMPLES.find((item) => item.lang === lang);
		if (!sample) throw new Error(`missing sample for ${lang}`);
		const title = lang === "robot" ? "unknown language (robot)" : lang;
		parts.push(`#### ${title}\n`);
		parts.push(`\`\`\`${lang}\n${sample.body}\n\`\`\`\n`);
	}

	parts.push("## Generated tuning module\n");
	parts.push(`The scheduler ships a ${spec.bigLines}-line generated constants file:\n`);
	parts.push(`\`\`\`python\n${bigPythonBlock(spec.bigLines)}\n\`\`\`\n`);

	const tail = [
		"## References",
		"",
		"The links below use reference-style syntax and their definitions live at the very end of",
		'the document, exactly as an LLM that emits "sources" last would produce them. See',
		"[the runbook][runbook], [the dashboards][dashboards] and [the incident log][incident-log].",
		"",
		"[runbook]: https://runbooks.acme.internal/clusterright/hand",
		"[dashboards]: https://grafana.acme.internal/d/clusterright/rollout",
		"[incident-log]: https://incidents.acme.internal/INC-4127",
		"",
	].join("\n");

	let body = parts.join("\n");
	let index = 10;
	while (body.length + tail.length < spec.target - 120) {
		body += `${fillerSection(rng, index)}\n`;
		index += 1;
	}

	return body + tail;
}

/* ------------------------------------------------------------ malicious */

function buildMalicious(): string {
	return [
		"# Malicious markdown fixture",
		"",
		"This document tries every injection vector the agent output could contain.",
		"",
		'<script>window.__pwned = true; document.title = "pwned";</script>',
		"",
		"<img src=x onerror=\"fetch('http://127.0.0.1:__BEACON_PORT__/beacon?src=html-onerror')\">",
		"",
		'<iframe src="http://127.0.0.1:__BEACON_PORT__/beacon?src=iframe" width="400" height="60"></iframe>',
		"",
		"<a href=\"javascript:fetch('http://127.0.0.1:__BEACON_PORT__/beacon?src=raw-js')\">raw javascript anchor</a>",
		"",
		'<img src="http://127.0.0.1:__BEACON_PORT__/beacon?src=html-img" alt="html img">',
		"",
		"Inline <img src=x onerror=\"fetch('http://127.0.0.1:__BEACON_PORT__/beacon?src=inline-onerror')\"> inside a paragraph.",
		"",
		"## Markdown links",
		"",
		"[javascript link](javascript:alert(1))",
		"",
		"[case trick](JaVaScRiPt:alert(2))",
		"",
		"[leading space]( javascript:alert(3))",
		"",
		"[entity trick](jav&#x61;script:alert(4))",
		"",
		"[decimal entity](jav&#97;script:alert(5))",
		"",
		"[data url](data:text/html,<script>alert(6)</script>)",
		"",
		"[file url](file:///etc/passwd)",
		"",
		"[vbscript url](vbscript:msgbox(7))",
		"",
		"## Images and autolinks",
		"",
		"![beacon image](http://127.0.0.1:__BEACON_PORT__/beacon?src=md-image)",
		"",
		"[beacon link](http://127.0.0.1:__BEACON_PORT__/beacon?src=md-link)",
		"",
		"Autolink: <http://127.0.0.1:__BEACON_PORT__/beacon?src=autolink>",
		"",
		"Bare URL: http://127.0.0.1:__BEACON_PORT__/beacon?src=bare",
		"",
		"## A benign link that must survive",
		"",
		"[the runbook](https://runbooks.acme.internal/clusterright/hand) and",
		"[mail us](mailto:oncall@acme.internal).",
		"",
	].join("\n");
}

/* --------------------------------------------------------------- warm-up */

/**
 * Small language-diverse document rendered once per page before the measured
 * stream, so lazy Shiki grammar chunks are loaded before the clock starts.
 * The load cost itself is measured and reported separately.
 */
function buildWarmup(): string {
	const parts = ["# Warm-up", "", "One short fence per language, to load every grammar chunk.", ""];
	for (const sample of CODE_SAMPLES) {
		parts.push(`\`\`\`${sample.lang}\n${sample.body}\n\`\`\`\n`);
	}
	return parts.join("\n");
}

/* ------------------------------------------------------------ edge cases */

interface EdgeCaseFixture {
	text: string;
	markers: Record<string, number>;
}

function buildEdgeCases(): EdgeCaseFixture {
	const markers: Record<string, number> = {};
	let text = "";

	text += "# Edge cases\n\n";
	text += "A paragraph before the setext heading.\n\n";
	text += "Setext heading in flight\n========================\n";
	markers.setext = text.length;
	text += "\nThe setext heading above is complete; this paragraph arrived after it.\n\n";

	text += "## Wide table in flight\n\n";
	const columns = ["zone", "node", "pods", "cpu", "mem", "p99", "errors", "age"];
	text += `| ${columns.join(" | ")} |\n`;
	text += `| ${columns.map(() => "---").join(" | ")} |\n`;
	const rows = [
		["eu-west-1a", "worker-01", "42", "61%", "74%", "0.21s", "0", "42d"],
		["eu-west-1b", "worker-02", "38", "58%", "69%", "0.19s", "1", "42d"],
		["eu-west-1c", "worker-03", "51", "77%", "81%", "1.94s", "14", "11d"],
		["us-east-1a", "worker-04", "33", "44%", "52%", "0.12s", "0", "42d"],
		["us-east-1b", "worker-05", "29", "39%", "47%", "0.11s", "0", "42d"],
		["us-east-1c", "worker-06", "31", "41%", "49%", "0.13s", "0", "42d"],
	];
	for (let i = 0; i < rows.length; i += 1) {
		text += `| ${rows[i]?.join(" | ")} |\n`;
		if (i === 1) markers.table = text.length;
	}
	text += "\n";

	text += "## Unterminated fence in flight\n\n";
	text += "The next block keeps streaming while the fence is still open.\n\n";
	text += "```bash\n";
	for (let i = 1; i <= 18; i += 1) {
		text += `kubectl -n prod get pods --field-selector spec.nodeName=worker-0${(i % 3) + 1} -o wide | head -${i}\n`;
		if (i === 6) markers.fence = text.length;
	}
	text += "```\n\n";

	text += "## Late reference definitions\n\n";
	text += "This paragraph points at [a late reference][late-ref] and [another one][late-ref-2].\n\n";
	text += "[late-ref]: https://example.com/late-reference\n";
	text += "[late-ref-2]: https://example.com/another-late-reference\n";

	markers.end = text.length;
	return { text, markers };
}

/* ------------------------------------------------------------------ main */

interface DocResult {
	name: string;
	chars: number;
	path: string;
}

function write(name: string, content: string): void {
	writeFileSync(join(OUT, `${name}.md`), content);
}

function main(): void {
	mkdirSync(OUT, { recursive: true });

	const specs: DocSpec[] = [
		// 2 000 lines x ~8 chars = ~16 KB; a 20K document cannot also fit the rest
		// of the feature set, so its largest block is deliberately smaller.
		{ name: "doc-20k", target: 20000, bigLines: 380, seed: 0xc0ffee },
		{ name: "doc-50k", target: 50000, bigLines: 2050, seed: 0xc0ffee },
		{ name: "doc-100k", target: 100000, bigLines: 2050, seed: 0xc0ffee },
	];

	const results: DocResult[] = [];
	for (const spec of specs) {
		const doc = buildDoc(spec);
		write(spec.name, doc);
		results.push({ name: spec.name, chars: doc.length, path: `src/markdown/__fixtures__/${spec.name}.md` });
	}

	const malicious = buildMalicious();
	write("malicious", malicious);
	results.push({ name: "malicious", chars: malicious.length, path: "src/markdown/__fixtures__/malicious.md" });

	const warmup = buildWarmup();
	write("warmup", warmup);
	results.push({ name: "warmup", chars: warmup.length, path: "src/markdown/__fixtures__/warmup.md" });

	const edge = buildEdgeCases();
	write("edge-cases", edge.text);
	writeFileSync(join(OUT, "edge-cases.markers.json"), `${JSON.stringify(edge.markers, null, 2)}\n`);
	results.push({ name: "edge-cases", chars: edge.text.length, path: "src/markdown/__fixtures__/edge-cases.md" });

	const report: Record<string, unknown> = {
		generatedAt: new Date().toISOString(),
		fixtures: results,
		edgeCaseMarkers: edge.markers,
	};
	writeFileSync(join(OUT, "manifest.json"), `${JSON.stringify(report, null, 2)}\n`);

	for (const result of results) {
		console.log(`${result.name.padEnd(12)} ${String(result.chars).padStart(7)} chars`);
	}
	console.log(`edge-case markers: ${JSON.stringify(edge.markers)}`);
}

main();
