import {
	ErrorResponseSchema,
	IdParamSchema,
	NodeResponseSchema,
	OkResponseSchema,
	SshCredentialCreateBodySchema,
	SshCredentialListResponseSchema,
	SshCredentialResponseSchema,
	SshNodeCreateBodySchema,
	SshProbeInputSchema,
	SshProbeResponseSchema,
	SshTargetInputSchema,
} from "@crh/api/schemas";
import type { Context } from "hono";
import { HTTPException } from "hono/http-exception";
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
import { NotFoundError, UserError } from "../util/errors.ts";
import type { AppEnv } from "./context.ts";
import { requireAdmin } from "./middleware.ts";
import { apiRouter, defineRoute, json } from "./openapi.ts";

const TAGS = ["SSH"];

const listCredentialsRoute = defineRoute({
	method: "get",
	path: "/ssh-credentials",
	tags: TAGS,
	summary: "List the organization's SSH credentials and the nodes that use each (administrators)",
	agent: "deny",
	middleware: [requireAdmin],
	responses: { 200: { description: "The credentials", ...json(SshCredentialListResponseSchema) } },
});

const createCredentialRoute = defineRoute({
	method: "post",
	path: "/ssh-credentials",
	tags: TAGS,
	summary: "Generate an SSH key pair for the organization; only the public key is returned (administrators)",
	agent: "deny",
	middleware: [requireAdmin],
	request: { body: { required: true, ...json(SshCredentialCreateBodySchema) } },
	responses: { 201: { description: "The new credential", ...json(SshCredentialResponseSchema) } },
});

const deleteCredentialRoute = defineRoute({
	method: "delete",
	path: "/ssh-credentials/{id}",
	tags: TAGS,
	summary: "Delete an SSH credential; a credential a node's route uses is refused (administrators)",
	agent: "deny",
	middleware: [requireAdmin],
	request: { params: IdParamSchema },
	responses: {
		200: { description: "Deleted", ...json(OkResponseSchema) },
		409: { description: "A node's route uses the credential", ...json(ErrorResponseSchema) },
	},
});

const probeRoute = defineRoute({
	method: "post",
	path: "/ssh-nodes/probe",
	tags: TAGS,
	summary: "Probe the first hop without a pinned host fingerprint and return its fingerprint (administrators)",
	agent: "deny",
	middleware: [requireAdmin],
	request: { body: { required: true, ...json(SshProbeInputSchema) } },
	responses: {
		200: { description: "The probed hop and its fingerprint", ...json(SshProbeResponseSchema) },
		502: { description: "The host could not be reached", ...json(ErrorResponseSchema) },
	},
});

const testRouteDefinition = defineRoute({
	method: "post",
	path: "/ssh-nodes/test",
	tags: TAGS,
	summary: "Test a confirmed SSH route: connect and run a command before saving the node (administrators)",
	agent: "deny",
	middleware: [requireAdmin],
	request: { body: { required: true, ...json(SshTargetInputSchema) } },
	responses: {
		200: { description: "The route works", ...json(OkResponseSchema) },
		502: { description: "The route could not be used", ...json(ErrorResponseSchema) },
	},
});

const sshTestRoute = defineRoute({
	method: "post",
	path: "/nodes/{id}/ssh-test",
	tags: TAGS,
	summary: "Test a saved SSH node's route (administrators who can see the node)",
	agent: "deny",
	request: { params: IdParamSchema },
	responses: {
		200: { description: "The route works", ...json(OkResponseSchema) },
		403: { description: "Administrators only", ...json(ErrorResponseSchema) },
		502: { description: "The route could not be used", ...json(ErrorResponseSchema) },
	},
});

const createNodeRoute = defineRoute({
	method: "post",
	path: "/ssh-nodes",
	tags: TAGS,
	summary: "Add an SSH node with a fully pinned route; every hop names its own credential (administrators)",
	agent: "deny",
	middleware: [requireAdmin],
	request: { body: { required: true, ...json(SshNodeCreateBodySchema) } },
	responses: { 201: { description: "The new node", ...json(NodeResponseSchema) } },
});

const updateNodeRoute = defineRoute({
	method: "patch",
	path: "/nodes/{id}/ssh-route",
	tags: TAGS,
	summary: "Replace an SSH node's route, jump hosts and hop credentials; its id, name and grants stay (administrators)",
	agent: "deny",
	middleware: [requireAdmin],
	request: { params: IdParamSchema, body: { required: true, ...json(SshTargetInputSchema) } },
	responses: {
		200: { description: "The node with its new route", ...json(NodeResponseSchema) },
		403: { description: "Administrators only", ...json(ErrorResponseSchema) },
	},
});

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
	const app = apiRouter();

	app.openapi(listCredentialsRoute, async (c) => {
		return c.json({ credentials: await listSshCredentials(db) }, 200);
	});

	app.openapi(createCredentialRoute, async (c) => {
		const body = c.req.valid("json");
		const credential = await createSshCredential(db, masterKey, body.name ?? "");
		void c.get("audit").record({
			actor: userActor(c.get("user")),
			action: "ssh_credential.created",
			target: { type: "ssh_credential", id: credential.id },
			detail: { name: credential.name, public_key: credential.publicKey },
		});
		return c.json({ credential }, 201);
	});

	app.openapi(deleteCredentialRoute, async (c) => {
		const { id } = c.req.valid("param");
		const usedBy = (await sshCredentialUsage(db, id)).get(id) ?? [];
		if (usedBy.length > 0) throw new HTTPException(409, { message: "the credential is in use by a node" });
		await deleteSshCredential(db, id);
		void c.get("audit").record({
			actor: userActor(c.get("user")),
			action: "ssh_credential.deleted",
			target: { type: "ssh_credential", id },
		});
		return c.json({ ok: true as const }, 200);
	});

	app.openapi(probeRoute, async (c) => {
		const body = c.req.valid("json");
		const route = await probeRouteFromInput(db, masterKey, body as SshTargetInput);
		if (route.hops.every((h) => h.hostFingerprint)) throw new UserError("every hop already has a host fingerprint");
		return c.json(await probeHostFingerprint(route), 200);
	});

	// Before creating: does every hop's own key work, and can the target account run commands?
	app.openapi(testRouteDefinition, async (c) => {
		const body = c.req.valid("json");
		const route = await routeFromInput(db, masterKey, body);
		if (route.hops.some((h) => !h.hostFingerprint)) throw new UserError("every hop needs a confirmed host fingerprint");
		await testRoute(route);
		return c.json({ ok: true as const }, 200);
	});

	/** The node for an SSH management route: 404 when hidden, 403 for a non-administrator. */
	const sshNode = async (c: Context<AppEnv>, id: string) => {
		const access = await nodeAccess(db, c.get("user"), id);
		const node = access ? await getNode(db, id) : undefined;
		if (!access || !node) throw new NotFoundError("no such node");
		if (!isAdmin(c.get("user"))) throw new HTTPException(403, { message: "administrators only" });
		if (node.transport !== "ssh") throw new UserError("not an SSH node");
		return node;
	};

	app.openapi(sshTestRoute, async (c) => {
		const { id } = c.req.valid("param");
		const node = await sshNode(c, id);
		await testRoute(await nodeRoute(db, masterKey, node));
		return c.json({ ok: true as const }, 200);
	});

	app.openapi(createNodeRoute, async (c) => {
		const input = c.req.valid("json");
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
	app.openapi(updateNodeRoute, async (c) => {
		const { id } = c.req.valid("param");
		const before = await sshNode(c, id);
		const body = c.req.valid("json");
		const node = await updateSshNodeRoute(db, masterKey, before, body);
		cluster?.closeSshNode(id);
		const nodeGroups = (await nodeGroupsForNodes(db, [id])).get(id) ?? [];
		void c.get("audit").record({
			actor: userActor(c.get("user")),
			action: "node.ssh_route_changed",
			target: { type: "node", id },
			detail: { before: routeDetail(before), after: routeDetail(node) },
		});
		return c.json({ node: toPublicNode(node, "admin", nodeGroups) }, 200);
	});

	return app;
}
