/**
 * Runtime schemas for the node group routes (doc/design/webui.md "Node pages"). The route definitions
 * validate requests with them and the API document is generated from them; `../nodes.ts` derives the
 * wire types, so a type and its schema cannot drift.
 */
import { z } from "zod";

export const NodeGroupRefSchema = z
	.object({
		id: z.string(),
		name: z.string(),
	})
	.meta({ id: "NodeGroupRef", description: "A node group as a node response names it." });

export const NodeGroupSchema = NodeGroupRefSchema.extend({
	memberIds: z.array(z.string()).describe("Ids of the member nodes the caller can see."),
}).meta({ id: "NodeGroup", description: "A node group and its members." });

export const NodeGroupListResponseSchema = z
	.object({
		groups: z.array(NodeGroupSchema),
		more: z.boolean().optional().describe("Present only with `limit`: whether more groups match."),
	})
	.meta({ id: "NodeGroupListResponse" });

export const NodeGroupListQuerySchema = z.object({
	q: z.string().optional().describe("Case-insensitive substring of the group name."),
	limit: z.string().optional().describe("Page size; with it the response carries `more`."),
	ids: z.string().optional().describe("Comma-separated group ids to return."),
});

export const NodeGroupNameBodySchema = z.object({
	name: z.string().describe("The new name; node and node group names share one namespace."),
});

export const NodeGroupMembersBodySchema = z.object({
	nodeIds: z.array(z.string(), { error: "must be a list of node ids" }).describe("The complete member list."),
});

export const NodeGroupResponseSchema = z.object({ group: NodeGroupSchema });

/** Out-of-sync trust alias or trust entry (doc/design/privilege.md "Trust cache"). */
export const TrustWarningKindSchema = z.enum([
	"alias_superfluous",
	"alias_unknown",
	"alias_missing",
	"trust_unknown",
	"trust_newer_values",
	"upgrade_not_denied",
]);

export const TrustWarningSeveritySchema = z.enum(["danger", "warning", "info"]);

export const TrustWarningSchema = z
	.object({
		kind: TrustWarningKindSchema,
		severity: TrustWarningSeveritySchema,
		uuid: z.string().nullable().describe("The alias or node group id the warning is about; null for a trust entry."),
		nodeGroupName: z.string().nullable().describe("The node group the id names, when it is one."),
		trustName: z
			.string()
			.nullable()
			.describe("The trust entry name, for the `trust_*` kinds and `upgrade_not_denied`."),
		message: z.string(),
	})
	.meta({ id: "TrustWarning" });

/** The facts a node reported (doc/design/protocol.md "Events"); an absent field means unknown. */
export const NodeFactsSchema = z
	.object({
		hostname: z.string().optional(),
		platform: z
			.string()
			.optional()
			.describe(
				'For people and models, never parsed: "<os>, <arch>, <distribution>", such as "linux, amd64, Ubuntu 24.04.4 LTS".',
			),
		hints: z
			.string()
			.optional()
			.describe('Short sentences about the system for people and models ("Found apt."), at most 16 lines and 1 KiB.'),
		notesPath: z.string().optional(),
		clockOffsetMs: z.number().optional(),
		shells: z
			.object({
				sh: z.string(),
				bash: z.string().nullable().optional(),
			})
			.optional(),
		selfUpgrade: z
			.object({
				available: z.boolean(),
				reasons: z
					.array(z.string())
					.describe(
						"Why crhs cannot upgrade the node: package_managed, not_systemd, unmanaged_unit, unit_mismatch, no_privilege, privileged_not_root, privileged_unavailable, or a reason from a newer crha.",
					),
				arch: z.string().optional().describe("The architecture of the crha binary the node needs."),
			})
			.optional()
			.describe("Whether crhs may upgrade this node's crha (doc/design/distribution.md)."),
		upgradeLogPath: z.string().optional().describe("The node's upgrade log, JSON lines, read with a file read."),
	})
	.meta({ id: "NodeFacts" });

/** A node as the WebUI lists and opens it. */
export const PublicNodeSchema = z
	.object({
		id: z.string(),
		name: z.string(),
		transport: z.enum(["client", "ssh"]),
		status: z.enum(["pending", "active"]),
		hostname: z.string().nullable(),
		clientVersion: z.string().nullable(),
		privilegedMode: z.string().nullable(),
		lastSeenAt: z.string().nullable(),
		createdAt: z.string(),
		approvedAt: z.string().nullable(),
		nodeGroups: z.array(NodeGroupRefSchema).describe("The crhs-managed node groups the node belongs to."),
		access: z.enum(["admin", "granted"]),
		facts: NodeFactsSchema.nullable(),
		keyFingerprint: z.string().nullable(),
		connected: z.boolean().nullable().describe("Whether crha is connected now; null for SSH nodes."),
		clockWarning: z
			.object({
				offsetMs: z.number().describe("Local clock minus crhs; positive means the node is ahead."),
				thresholdMs: z.number(),
			})
			.nullable()
			.describe("Set only while the measured offset exceeds the warning threshold."),
		trustWarnings: z.array(TrustWarningSchema),
	})
	.meta({ id: "PublicNode" });

export const NodeResponseSchema = z.object({ node: PublicNodeSchema });

/** A node access grant: one grantee reaches one node or every current member of a node group. */
export const NodeAccessGrantSchema = z
	.object({
		id: z.string(),
		granteeType: z.enum(["user", "user_group"]),
		granteeId: z.string(),
		granteeName: z.string().nullable().describe("null when the grantee was deleted."),
		targetType: z.enum(["node", "node_group"]),
		targetId: z.string(),
		targetName: z.string().nullable().describe("null when the target was deleted."),
		createdAt: z.string(),
		createdByUserId: z.string(),
	})
	.meta({ id: "NodeAccessGrant" });

/** Query parameters of `GET /api/node-access-grants`. */
export const NodeAccessGrantFilterSchema = z.object({
	targetType: z.enum(["node", "node_group"]).optional(),
	targetId: z.string().optional(),
	granteeType: z.enum(["user", "user_group"]).optional(),
	granteeId: z.string().optional(),
});

export const NodeAccessGrantListResponseSchema = z.object({ grants: z.array(NodeAccessGrantSchema) });
export const NodeAccessGrantResponseSchema = z.object({ grant: NodeAccessGrantSchema });

/** `POST /api/node-access-grants`: the grantee and the target the grant reaches. */
export const NodeAccessGrantInputSchema = z.object({
	granteeType: z.enum(["user", "user_group"]),
	granteeId: z.string().min(1).describe("A user id or user group id."),
	targetType: z.enum(["node", "node_group"]),
	targetId: z.string().min(1),
});

/** What to paste into ~/privileged.toml as a crhs trust entry. */
export const CrhsKeySchema = z.object({ authorizedKey: z.string(), fingerprint: z.string() }).meta({ id: "CrhsKey" });

/** `GET /api/privilege/crhs-key`: the newest key and every key, newest first. */
export const CrhsKeyResponseSchema = z
	.object({
		key: CrhsKeySchema,
		keys: z.array(CrhsKeySchema),
	})
	.meta({ id: "CrhsKeyResponse" });

/** A node that uses an SSH credential on some hop of its route. */
export const SshCredentialUserSchema = z.object({ id: z.string(), name: z.string() });

/** An organization-owned SSH key pair; only the public half is returned. */
export const SshCredentialSchema = z
	.object({
		id: z.string(),
		name: z.string(),
		publicKey: z.string().describe("The authorized_keys line."),
		createdAt: z.string(),
		usedBy: z.array(SshCredentialUserSchema).describe("The nodes that use this credential on any hop."),
	})
	.meta({ id: "SshCredential" });

export const SshCredentialListResponseSchema = z.object({ credentials: z.array(SshCredentialSchema) });
export const SshCredentialResponseSchema = z.object({ credential: SshCredentialSchema });

/** `POST /api/ssh-credentials`: crhs generates the key pair; only the label is supplied. */
export const SshCredentialCreateBodySchema = z.object({
	name: z.string().optional().describe('A label; "crh" when empty.'),
});

/** One hop as the route editor submits it; the fingerprint is empty until the probe confirmed it. */
const SshHopInputShape = {
	host: z.string(),
	port: z.number().optional().describe("22 when omitted."),
	user: z.string(),
	hostFingerprint: z.string().optional().describe("Pinned host fingerprint; empty until the probe confirmed it."),
	credentialId: z.string().optional().describe("This hop's own credential."),
};

export const SshHopInputSchema = z.object({
	...SshHopInputShape,
	credentialId: z.string().describe("This hop's own credential; every hop that authenticates needs one."),
});

/** Body of `POST /api/ssh-nodes`, `/ssh-nodes/test` and `PATCH /api/nodes/{id}/ssh-route`. */
export const SshTargetInputSchema = z
	.object({
		...SshHopInputShape,
		credentialId: z.string(),
		jumps: z.array(SshHopInputSchema).optional().describe("Jump hosts in order, then the node itself."),
	})
	.strict();

/**
 * Body of `POST /api/ssh-nodes/probe`: the hop being probed authenticates nothing, so it needs no
 * credential; the pinned hops before it do.
 */
export const SshProbeInputSchema = z
	.object({
		...SshHopInputShape,
		jumps: z.array(SshHopInputSchema).optional().describe("Jump hosts in order, then the node itself."),
	})
	.strict();

/** `POST /api/ssh-nodes`: the target route plus the node's name. */
export const SshNodeCreateBodySchema = SshTargetInputSchema.extend({
	name: z.string().optional(),
});

/** `POST /api/ssh-nodes/probe`: the first hop without a confirmed fingerprint. */
export const SshProbeResponseSchema = z.object({
	hop: z.number().describe("Index into the hops, jumps first and the target last."),
	fingerprint: z.string().describe('The host key fingerprint, "SHA256:<base64>".'),
});

/** Query parameters of `GET /api/nodes` (doc/design/webui.md "Entity search"). */
export const NodeListQuerySchema = z.object({
	q: z.string().optional().describe("Case-insensitive substring of the node name or hostname."),
	limit: z.string().optional().describe("Page size, 1 to 100; with it the response carries `more`."),
	ids: z.string().optional().describe("Comma-separated node ids to return."),
});

/** `GET /api/nodes`; `more` is present only with `limit`. */
export const NodeListResponseSchema = z.object({
	nodes: z.array(PublicNodeSchema),
	more: z.boolean().optional().describe("Present only with `limit`: whether more nodes match."),
});

/** One confirmed hop of an SSH route (administrators only). */
export const SshHopSchema = z
	.object({
		host: z.string(),
		port: z.number(),
		user: z.string(),
		hostFingerprint: z.string().describe('Pinned host fingerprint, "SHA256:<base64>" as OpenSSH prints it.'),
		credentialId: z.string().describe("The credential that authenticates this hop."),
		credential: z
			.object({ id: z.string(), name: z.string().nullable() })
			.describe("The same credential with its display name, when it still exists."),
	})
	.meta({ id: "SshHop" });

/** How crhs reaches an SSH node; only `GET /api/nodes/{id}` serves it, to administrators. */
export const SshNodeDetailsSchema = z
	.object({
		hops: z.array(SshHopSchema).describe("Jump hosts in order, then the node itself; each carries its own credential."),
	})
	.meta({ id: "SshNodeDetails" });

/** `GET /api/nodes/{id}`: the node and, for administrators, its SSH route. */
export const NodeDetailResponseSchema = z
	.object({
		node: PublicNodeSchema,
		ssh: SshNodeDetailsSchema.nullable().optional().describe("Present for administrators; null for a crha node."),
	})
	.meta({ id: "NodeDetailResponse" });

/** The trust panel of a node (doc/design/privilege.md "Trust cache"). */
export const NodeTrustSchema = z
	.object({
		status: z.enum(["ok", "unavailable", "not_forward"]).nullable(),
		message: z.string().nullable(),
		digest: z.string().nullable(),
		updatedAt: z.string().nullable(),
		stale: z
			.boolean()
			.describe("The last report is kept after a disconnect but is stale until the connection reports again."),
		summary: z.unknown().nullable().describe('The last trust summary (doc/design/protocol.md "Privilege messages").'),
	})
	.meta({ id: "NodeTrust" });

export const NodeTrustResponseSchema = z.object({ trust: NodeTrustSchema });

/** One entry of a node listing; the path is absolute. */
export const NodeFileEntrySchema = z
	.object({
		path: z.string(),
		name: z.string(),
		type: z.string(),
		size: z.number(),
		mtime: z.string().optional().describe("Undefined when the node's listing did not report it."),
		linkTarget: z.string().nullable().optional(),
	})
	.meta({ id: "NodeFileEntry" });

/** `GET /api/nodes/{id}/files?path=…`: the entries under an absolute directory path. */
export const NodeFilesResponseSchema = z
	.object({
		path: z.string().describe("The listed absolute path."),
		entries: z.array(NodeFileEntrySchema),
		truncated: z.boolean(),
	})
	.meta({ id: "NodeFilesResponse" });

/** One file's metadata on a node (doc/design/webui.md "Node pages"). */
export const NodeFileInfoSchema = z
	.object({
		path: z.string().describe("The absolute path."),
		type: z.string(),
		size: z.number(),
		mode: z.number().describe("Octal permission bits as the node reports them."),
		uid: z.number(),
		gid: z.number(),
		owner: z.string(),
		group: z.string(),
		mtime: z.string().describe("ISO 8601."),
		linkTarget: z.string().nullable(),
	})
	.meta({ id: "NodeFileInfo" });

/** `GET /api/nodes/{id}/stat?path=…`. */
export const NodeFileResponseSchema = z.object({ file: NodeFileInfoSchema });

/** Query parameters of `GET /api/nodes/{id}/files`: the absolute directory path; "/" by default. */
export const NodeFilesQuerySchema = z.object({
	path: z.string().optional().describe('An absolute directory path; "/" by default.'),
});

/** Query parameters of `GET /api/nodes/{id}/stat`: the absolute path; required. */
export const NodeStatQuerySchema = z.object({
	path: z.string().optional().describe("An absolute path; required."),
});

/** Query parameters of `GET /api/nodes/{id}/file`. */
export const NodeFileQuerySchema = NodeStatQuerySchema.extend({
	preview: z.string().optional().describe("`1` serves a supported image inline instead of as an attachment."),
});

/** `PATCH /api/nodes/{id}`: the node's new name. */
export const NodeRenameBodySchema = z.object({
	name: z.string().describe("The new name; node and node group names share one namespace."),
});

/** `PUT /api/nodes/{id}/node-groups`: the complete node group list, by name or id. */
export const NodeGroupsBodySchema = z.object({
	nodeGroups: z.array(z.string(), { error: "must be a list of node-group names or ids" }),
});

/** `POST /api/enrollment-tokens`: a label for the pending node. */
export const EnrollmentTokenBodySchema = z.object({
	nameHint: z.string().optional(),
});

/** `POST /api/enrollment-tokens` and `POST /api/nodes/{id}/reenroll`: a one-time token, shown once. */
export const EnrollmentTokenResponseSchema = z
	.object({
		token: z.string().describe("The secret; it cannot be read again."),
		expiresAt: z.string(),
	})
	.meta({ id: "EnrollmentTokenResponse" });

/** `PUT /api/nodes/{id}/node-groups`: the node with its new node groups. */
export const NodeGroupsResponseSchema = z.object({ nodeGroups: z.array(NodeGroupRefSchema) });

/** An upgrade request: the nodes or node groups to bring to crhs's own crha version (doc/design/distribution.md). */
export const NodeUpgradeBodySchema = z
	.object({
		targets: z.array(z.string()).min(1).describe("Node or node-group names or ids, or _all, as for a task group."),
		dryRun: z
			.boolean()
			.optional()
			.describe("Only plan: which nodes would be upgraded and why the others would not. Nothing is fetched."),
	})
	.strict()
	.meta({ id: "NodeUpgradeBody" });

export const NodeUpgradeSkipReasonSchema = z.enum([
	"not_crha",
	"not_connected",
	"self_upgrade_unavailable",
	"no_arch",
	"up_to_date",
	"newer_than_crhs",
	"not_a_release_version",
	"upgrade_in_progress",
]);

export const NodeUpgradeResponseSchema = z
	.object({
		version: z.string().describe("crhs's version: the crha version the nodes are upgraded to."),
		upgrades: z.array(
			z.object({
				nodeId: z.string(),
				name: z.string(),
				version: z.string(),
				arch: z.string(),
				runningTasks: z.number().describe("Tasks running on the node now; restarting crha ends them as unknown."),
			}),
		),
		skipped: z.array(
			z.object({
				nodeId: z.string(),
				name: z.string(),
				reason: NodeUpgradeSkipReasonSchema,
				nodeReasons: z.array(z.string()).describe("The node's own self_upgrade reasons."),
				version: z.string().nullable(),
			}),
		),
		taskGroups: z
			.array(z.object({ arch: z.string(), taskGroupId: z.string() }))
			.describe("One privileged node.upgrade task group per architecture; empty for a dry run."),
	})
	.meta({ id: "NodeUpgradeResponse" });
