// A scripted Chat Completions endpoint for the README screenshots: no real model, the same transcript every run.
// The scene and language come from the first user message; the step is how many tool calls were already made.
import { createServer } from "node:http";

const SCENES = [
	{
		match: /table|表格/,
		title: { en: "Node status: OS, nginx, processes", zh: "节点状态：系统、nginx 与进程数" },
		steps: {
			en: [
				["I'll start by listing the nodes.", "list_nodes", {}],
				[
					"Four nodes. One command per node collects all three facts:",
					"exec",
					{
						targets: ["_all"],
						cmd: '. /etc/os-release && echo "$PRETTY_NAME"; pgrep -x nginx >/dev/null && echo running || echo "not running"; ps -e --no-headers | wc -l',
					},
				],
				[
					"| Node | OS release | nginx | Running processes |\n|---|---|---|---|\n| app-1 | Ubuntu 24.04.4 LTS | not running | 9 |\n| db-1 | Ubuntu 24.04.4 LTS | not running | 10 |\n| ssh-1 | Ubuntu 24.04.4 LTS | not running | 7 |\n| web-1 | Ubuntu 24.04.4 LTS | not running | 10 |\n\nnginx is not installed on any node, so there is nothing to restart. Process counts are low and even across the cluster; nothing looks out of place.",
				],
			],
			zh: [
				["我先看一下有哪些节点。", "list_nodes", {}],
				[
					"共四个节点，用一条命令在每个节点上同时收集这三项信息：",
					"exec",
					{
						targets: ["_all"],
						cmd: '. /etc/os-release && echo "$PRETTY_NAME"; pgrep -x nginx >/dev/null && echo running || echo "not running"; ps -e --no-headers | wc -l',
					},
				],
				[
					"| 节点 | 系统版本 | nginx | 运行中的进程 |\n|---|---|---|---|\n| app-1 | Ubuntu 24.04.4 LTS | 未运行 | 9 |\n| db-1 | Ubuntu 24.04.4 LTS | 未运行 | 10 |\n| ssh-1 | Ubuntu 24.04.4 LTS | 未运行 | 7 |\n| web-1 | Ubuntu 24.04.4 LTS | 未运行 | 10 |\n\n四个节点都没有安装 nginx，所以没有需要重启的服务。各节点的进程数都不多，也比较均衡，没有发现异常。",
				],
			],
		},
	},
	{
		match: /disk|磁盘/,
		title: { en: "Disk usage and the apt cache on db-1", zh: "磁盘用量与 db-1 的 apt 缓存" },
		steps: {
			en: [
				["Checking disk usage on every node first.", "exec", { targets: ["_all"], cmd: "df -h / | tail -n 1" }],
				[
					"All four nodes share the same disk and sit at 74%, so none is closer to full than the others. Cleaning the apt cache on db-1 needs root, so that task waits for your signature.",
					"exec",
					{ targets: ["db-1"], cmd: "apt-get clean", privileged: true },
				],
				["The apt cache on db-1 is clean."],
			],
			zh: [
				["先检查每个节点的磁盘用量。", "exec", { targets: ["_all"], cmd: "df -h / | tail -n 1" }],
				[
					"四个节点共用同一块磁盘，用量都是 74%，没有哪个更接近写满。清理 db-1 的 apt 缓存需要 root，这个任务会等待你的签名。",
					"exec",
					{ targets: ["db-1"], cmd: "apt-get clean", privileged: true },
				],
				["db-1 的 apt 缓存已清理。"],
			],
		},
	},
];

const textOf = (content) =>
	typeof content === "string" ? content : Array.isArray(content) ? content.map((part) => part.text ?? "").join("") : "";

function respond(body) {
	const messages = body.messages ?? [];
	const firstUser = textOf(messages.find((m) => m.role === "user")?.content);
	const lang = /[一-鿿]/.test(firstUser) ? "zh" : "en";
	const scene = SCENES.find((s) => s.match.test(firstUser));
	const tools = (body.tools ?? []).map((t) => t.function?.name);
	if (tools.includes("submit_review"))
		return { tool: ["submit_review", { decision: "approve", risk: "low", reason: "read-only" }] };
	if (!tools.includes("exec")) return { text: scene?.title[lang] ?? (lang === "zh" ? "新会话" : "New session") };
	if (!scene) return { text: lang === "zh" ? "好的。" : "OK." };
	const done = messages.filter((m) => m.role === "assistant" && m.tool_calls?.length).length;
	const steps = scene.steps[lang];
	const [text, name, args] = steps[Math.min(done, steps.length - 1)];
	return { text, tool: name ? [name, args] : undefined, step: done };
}

let calls = 0;
createServer((req, res) => {
	let raw = "";
	req.setEncoding("utf8");
	req.on("data", (chunk) => {
		raw += chunk;
	});
	req.on("end", async () => {
		if (!req.url?.endsWith("/chat/completions")) {
			res.writeHead(req.url?.endsWith("/models") ? 200 : 404, { "content-type": "application/json" });
			return res.end(JSON.stringify({ object: "list", data: [{ id: "demo", object: "model" }] }));
		}
		const body = raw ? JSON.parse(raw) : {};
		const answer = respond(body);
		const id = `chatcmpl-${++calls}`;
		res.writeHead(200, { "content-type": "text/event-stream", connection: "keep-alive" });
		const chunk = (choices, extra = {}) =>
			res.write(
				`data: ${JSON.stringify({ id, object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model: "demo", choices, ...extra })}\n\n`,
			);
		const send = (delta, finish = null) => chunk([{ index: 0, delta, finish_reason: finish }]);
		const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
		await sleep(900); // time to first token
		send({ role: "assistant", content: "" });
		if (answer.text) {
			// Streamed in pieces at a model-like pace (about 80 tokens a second).
			for (const piece of answer.text.match(/[\s\S]{1,6}/g) ?? []) {
				send({ content: piece });
				await sleep(/[\u4e00-\u9fff]/.test(piece) ? 60 : 22);
			}
		}
		if (answer.tool) {
			const [name, args] = answer.tool;
			const json = JSON.stringify(args);
			send({
				tool_calls: [
					{ index: 0, id: `call_${calls}`, type: "function", function: { name, arguments: json.slice(0, 10) } },
				],
			});
			send({ tool_calls: [{ index: 0, function: { arguments: json.slice(10) } }] });
		}
		send({}, answer.tool ? "tool_calls" : "stop");
		const prompt = Math.round(raw.length / 4);
		const said = (answer.text ?? "") + (answer.tool ? JSON.stringify(answer.tool[1]) : "");
		const cjk = (said.match(/[\u4e00-\u9fff]/g) ?? []).length;
		const completion = Math.ceil(cjk / 1.4 + (said.length - cjk) / 3.8) + 8;
		const cached = calls > 1 ? Math.floor(prompt * 0.82) : 0;
		chunk([], {
			usage: {
				prompt_tokens: prompt,
				completion_tokens: completion,
				total_tokens: prompt + completion,
				prompt_tokens_details: { cached_tokens: cached },
			},
		});
		res.end("data: [DONE]\n\n");
		console.log(`${id} step=${answer.step ?? "-"} tool=${answer.tool?.[0] ?? "-"}`);
	});
}).listen(9000, "0.0.0.0", () => console.log("fake model on :9000"));
