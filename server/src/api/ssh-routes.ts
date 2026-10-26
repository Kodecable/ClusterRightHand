import { Hono } from "hono";
import { nodeGroupNames, toPublicNode } from "../cluster/nodes.ts";
import { probeHostKey, SshError } from "../cluster/ssh/connection.ts";
import {
	createSshCredential,
	createSshNode,
	listSshCredentials,
	routeFromInput,
	type SshTargetInput,
} from "../cluster/ssh/nodes.ts";
import type { MasterKey } from "../keys/master-key.ts";
import type { Db } from "../storage/db.ts";
import { NotFoundError, UserError } from "../users/service.ts";
import { type AppEnv, jsonError, readJsonObject } from "./context.ts";

/**
 * Adding SSH nodes: crhs generates a key (the user installs its public half), probes each hop's host key
 * for the user to confirm, then saves the node with every key pinned. Expects requireUser to have run.
 */
export function sshRoutes(db: Db, masterKey: MasterKey) {
	const app = new Hono<AppEnv>();

	app.onError((err, c) => {
		if (err instanceof NotFoundError) return jsonError(c, 404, err.message);
		if (err instanceof UserError) return jsonError(c, 400, err.message);
		if (err instanceof SshError) return c.json({ error: err.message, code: err.code }, 502);
		throw err;
	});

	app.get("/ssh-credentials", async (c) => c.json({ credentials: await listSshCredentials(db, c.get("user")) }));

	app.post("/ssh-credentials", async (c) => {
		const body = await readJsonObject(c);
		const name = typeof body?.name === "string" ? body.name : "";
		return c.json({ credential: await createSshCredential(db, masterKey, c.get("user"), name) }, 201);
	});

	app.post("/ssh-nodes/probe", async (c) => {
		const body = await readJsonObject(c);
		if (!body) return jsonError(c, 400, "expected a JSON object");
		const route = await routeFromInput(db, masterKey, c.get("user"), body as unknown as SshTargetInput);
		if (route.hops.every((h) => h.hostKey)) return jsonError(c, 400, "every hop already has a host key");
		return c.json(await probeHostKey(route));
	});

	app.post("/ssh-nodes", async (c) => {
		const body = await readJsonObject(c);
		if (!body) return jsonError(c, 400, "expected a JSON object");
		const input = body as unknown as SshTargetInput & { name: string; groups?: string[] };
		const node = await createSshNode(db, masterKey, c.get("user"), input);
		const groups = (await nodeGroupNames(db, [node.id])).get(node.id) ?? [];
		return c.json({ node: toPublicNode(node, "owner", groups) }, 201);
	});

	return app;
}
