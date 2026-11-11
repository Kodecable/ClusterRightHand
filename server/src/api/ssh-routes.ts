import { type Context, Hono } from "hono";
import { userActor } from "../audit/audit.ts";
import { isAdmin } from "../auth/sessions.ts";
import type { Cluster } from "../cluster/cluster.ts";
import { nodeGroupsForNodes } from "../cluster/node-groups.ts";
import { getNode, type NodeRow, nodeAccess, toPublicNode } from "../cluster/nodes.ts";
import { probeHostFingerprint, testRoute } from "../cluster/ssh/connection.ts";
import {
	createSshCredential,
	createSshNode,
	deleteSshCredential,
	listSshCredentials,
	nodeRoute,
	probeRouteFromInput,
	routeFromInput,
	type SshTargetInput,
	sshCredentialUsage,
	updateSshNodeRoute,
} from "../cluster/ssh/nodes.ts";
import type { MasterKey } from "../keys/master-key.ts";
import type { Db } from "../storage/db.ts";
import { type AppEnv, jsonError, readJsonObject } from "./context.ts";
import { requireAdmin } from "./middleware.ts";

/** An SSH node's stored route, as the audit log keeps it; each hop names its own credential. */
function routeDetail(node: NodeRow) {
	const jumps = (
		JSON.parse(node.ssh_jumps ?? "[]") as {
			host: string;
			port: number;
			user: string;
			hostFingerprint: string;
			credentialId: string;
		}[]
	).map(({ host, port, user, hostFingerprint, credentialId }) => ({ host, port, user, hostFingerprint, credentialId }));
	return {
		hops: [
			...jumps,
			{
				host: node.ssh_host,
				port: node.ssh_port ?? 22,
				user: node.ssh_user,
				hostFingerprint: node.ssh_host_fingerprint,
				credentialId: node.ssh_credential_id,
			},
		],
	};
}

/**
 * Adding and editing SSH nodes: crhs probes each hop's host fingerprint for the user to confirm, then
 * saves the node with every fingerprint pinned and each hop's own credential. Credentials are created on
 * the SSH credentials page. Expects requireUser to have run.
 */
export function sshRoutes(db: Db, masterKey: MasterKey, cluster?: Cluster) {
	const app = new Hono<AppEnv>();

	app.get("/ssh-credentials", requireAdmin, async (c) => {
		return c.json({ credentials: await listSshCredentials(db) });
	});

	app.post("/ssh-credentials", requireAdmin, async (c) => {
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

	app.delete("/ssh-credentials/:id", requireAdmin, async (c) => {
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

	app.post("/ssh-nodes/probe", requireAdmin, async (c) => {
		const body = await readJsonObject(c);
		if (!body) return jsonError(c, 400, "expected a JSON object");
		const route = await probeRouteFromInput(db, masterKey, body as unknown as SshTargetInput);
		if (route.hops.every((h) => h.hostFingerprint))
			return jsonError(c, 400, "every hop already has a host fingerprint");
		return c.json(await probeHostFingerprint(route));
	});

	// Before creating: does every hop's own key work, and can the target account run commands?
	app.post("/ssh-nodes/test", requireAdmin, async (c) => {
		const body = await readJsonObject(c);
		if (!body) return jsonError(c, 400, "expected a JSON object");
		const route = await routeFromInput(db, masterKey, body as unknown as SshTargetInput);
		if (route.hops.some((h) => !h.hostFingerprint))
			return jsonError(c, 400, "every hop needs a confirmed host fingerprint");
		await testRoute(route);
		return c.json({ ok: true });
	});

	/** The node for an SSH management route: 404 when hidden, 403 for a non-administrator. */
	const sshNode = async (c: Context<AppEnv>, id: string) => {
		const access = await nodeAccess(db, c.get("user"), id);
		const node = access ? await getNode(db, id) : undefined;
		if (!access || !node) return { error: jsonError(c, 404, "no such node") };
		if (!isAdmin(c.get("user"))) return { error: jsonError(c, 403, "administrators only") };
		if (node.transport !== "ssh") return { error: jsonError(c, 400, "not an SSH node") };
		return { node };
	};

	app.post("/nodes/:id/ssh-test", async (c) => {
		const r = await sshNode(c, c.req.param("id"));
		if (r.error) return r.error;
		await testRoute(await nodeRoute(db, masterKey, r.node));
		return c.json({ ok: true });
	});

	app.post("/ssh-nodes", requireAdmin, async (c) => {
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
				route: [...(input.jumps ?? []), input].map((h) => `${h.user}@${h.host}:${h.port ?? 22}`),
				credential_ids: [...(input.jumps ?? []), input].map((h) => h.credentialId),
				node_groups: nodeGroups,
			},
		});
		return c.json({ node: toPublicNode(node, "admin", nodeGroups) }, 201);
	});

	/**
	 * Replaces an existing SSH node's route (target, jump hosts and each hop's credential) after the same
	 * probe and confirm an add needs. Id, name, node groups, access grants and task history stay; the
	 * pooled connection is closed, so tasks running on it become `unknown` (doc/design/execution.md "Adding an SSH node").
	 */
	app.patch("/nodes/:id/ssh-route", requireAdmin, async (c) => {
		const id = c.req.param("id");
		const r = await sshNode(c, id);
		if (r.error) return r.error;
		const body = await readJsonObject(c);
		if (!body) return jsonError(c, 400, "expected a JSON object");
		if (body.nodeGroups !== undefined) {
			return jsonError(c, 400, "node groups are managed with the node-group endpoints, not when editing a route");
		}
		const before = r.node;
		const node = await updateSshNodeRoute(db, masterKey, before, body as unknown as SshTargetInput);
		cluster?.closeSshNode(id);
		const nodeGroups = (await nodeGroupsForNodes(db, [id])).get(id) ?? [];
		void c.get("audit").record({
			actor: userActor(c.get("user")),
			action: "node.ssh_route_changed",
			target: { type: "node", id },
			detail: { before: routeDetail(before), after: routeDetail(node) },
		});
		return c.json({ node: toPublicNode(node, "admin", nodeGroups) });
	});

	return app;
}
