import { type Context, Hono } from "hono";
import { userActor } from "../audit/audit.ts";
import { nodeGroupsForNodes } from "../cluster/node-groups.ts";
import { getNode, nodeAccess, toPublicNode } from "../cluster/nodes.ts";
import { probeHostKey, testRoute } from "../cluster/ssh/connection.ts";
import {
	createSshCredential,
	createSshNode,
	deleteSshCredential,
	listSshCredentials,
	nodeRoute,
	routeFromInput,
	type SshTargetInput,
	sshCredentialUsage,
} from "../cluster/ssh/nodes.ts";
import type { MasterKey } from "../keys/master-key.ts";
import type { Db } from "../storage/db.ts";
import { type AppEnv, jsonError, readJsonObject } from "./context.ts";
import { adminOnly } from "./middleware.ts";

/**
 * Adding SSH nodes: crhs generates a key (the user installs its public half), probes each hop's host key
 * for the user to confirm, then saves the node with every key pinned. Expects requireUser to have run.
 */
export function sshRoutes(db: Db, masterKey: MasterKey) {
	const app = new Hono<AppEnv>();

	app.get("/ssh-credentials", adminOnly, async (c) => {
		return c.json({ credentials: await listSshCredentials(db) });
	});

	app.post("/ssh-credentials", adminOnly, async (c) => {
		const body = await readJsonObject(c);
		const name = typeof body?.name === "string" ? body.name : "";
		const credential = await createSshCredential(db, masterKey, name);
		void c.get("audit").record({
			actor: userActor(c.get("user")),
			action: "ssh_credential.created",
			target: { type: "ssh_credential", id: credential.id },
			detail: { name: credential.name, public_key: credential.publicKey },
		});
		return c.json({ credential }, 201);
	});

	app.delete("/ssh-credentials/:id", adminOnly, async (c) => {
		const id = c.req.param("id");
		const usedBy = (await sshCredentialUsage(db, id)).get(id) ?? [];
		if (usedBy.length > 0) return jsonError(c, 409, "the credential is in use by a node");
		await deleteSshCredential(db, id);
		void c.get("audit").record({
			actor: userActor(c.get("user")),
			action: "ssh_credential.deleted",
			target: { type: "ssh_credential", id },
		});
		return c.json({ ok: true });
	});

	app.post("/ssh-nodes/probe", adminOnly, async (c) => {
		const body = await readJsonObject(c);
		if (!body) return jsonError(c, 400, "expected a JSON object");
		const route = await routeFromInput(db, masterKey, body as unknown as SshTargetInput);
		if (route.hops.every((h) => h.hostKey)) return jsonError(c, 400, "every hop already has a host key");
		return c.json(await probeHostKey(route));
	});

	// Before creating: does the key work on every hop, and can the account run commands?
	app.post("/ssh-nodes/test", adminOnly, async (c) => {
		const body = await readJsonObject(c);
		if (!body) return jsonError(c, 400, "expected a JSON object");
		const route = await routeFromInput(db, masterKey, body as unknown as SshTargetInput);
		if (route.hops.some((h) => !h.hostKey)) return jsonError(c, 400, "every hop needs a confirmed host key");
		await testRoute(route);
		return c.json({ ok: true });
	});

	/** The node for an SSH management route: 404 when hidden, 403 for a non-administrator. */
	const sshNode = async (c: Context<AppEnv>, id: string) => {
		const access = await nodeAccess(db, c.get("user"), id);
		const node = access ? await getNode(db, id) : undefined;
		if (!access || !node) return { error: jsonError(c, 404, "no such node") };
		if (c.get("user").kind !== "admin") return { error: jsonError(c, 403, "administrators only") };
		if (node.transport !== "ssh") return { error: jsonError(c, 400, "not an SSH node") };
		return { node };
	};

	app.post("/nodes/:id/ssh-test", async (c) => {
		const r = await sshNode(c, c.req.param("id"));
		if (r.error) return r.error;
		await testRoute(await nodeRoute(db, masterKey, r.node));
		return c.json({ ok: true });
	});

	app.post("/ssh-nodes", adminOnly, async (c) => {
		const body = await readJsonObject(c);
		if (!body) return jsonError(c, 400, "expected a JSON object");
		if (body.nodeGroups !== undefined) {
			return jsonError(c, 400, "node groups are managed with the node-group endpoints, not when adding a node");
		}
		const input = body as unknown as SshTargetInput & { name?: string };
		const node = await createSshNode(db, masterKey, input, c.get("user").userId);
		const nodeGroups = (await nodeGroupsForNodes(db, [node.id])).get(node.id) ?? [];
		void c.get("audit").record({
			actor: userActor(c.get("user")),
			action: "ssh_node.created",
			target: { type: "node", id: node.id },
			detail: {
				name: node.name,
				credential_id: input.credentialId,
				route: [...(input.jumps ?? []), input].map((h) => `${h.user}@${h.host}:${h.port ?? 22}`),
				node_groups: nodeGroups,
			},
		});
		return c.json({ node: toPublicNode(node, "admin", nodeGroups) }, 201);
	});

	return app;
}
