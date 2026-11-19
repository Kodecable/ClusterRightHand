/**
 * Nodes, node groups, node access, SSH routes and the trust panel
 * (doc/design/webui.md "Node pages", doc/design/access-control.md "Ownership, access grants and sharing",
 * doc/design/privilege.md "Trust cache"). The trust shapes are the protocol's own types.
 */

import type {
	GuardRule as ProtocolGuardRule,
	TrustEntry as ProtocolTrustEntry,
	TrustSummary as ProtocolTrustSummary,
	TrustKey,
	TrustReport,
} from "@crh/protocol";
import type { z } from "zod";
import type {
	CrhsKeyResponseSchema,
	CrhsKeySchema,
	EnrollmentTokenResponseSchema,
	NodeAccessGrantFilterSchema,
	NodeAccessGrantSchema,
	NodeFileEntrySchema,
	NodeFileInfoSchema,
	NodeFileResponseSchema,
	NodeFilesResponseSchema,
	NodeGroupListResponseSchema,
	NodeGroupRefSchema,
	NodeGroupSchema,
	NodeListResponseSchema,
	PublicNodeSchema,
	SshCredentialSchema,
	SshHopInputSchema,
	SshHopSchema,
	SshNodeDetailsSchema,
	SshTargetInputSchema,
	TrustWarningKindSchema,
	TrustWarningSchema,
	TrustWarningSeveritySchema,
} from "./schemas/nodes.ts";

/** How the caller reaches a node: administrators, or a granted user (one level). */
export type NodeAccess = "admin" | "granted";

export type GranteeType = "user" | "user_group";
/** What an access grant points at (doc/design/access-control.md "Ownership, access grants and sharing"). */
export type AccessTargetType = "node" | "node_group";

/** A node group as a node response names it. */
export type NodeGroupRef = z.infer<typeof NodeGroupRefSchema>;

/** A node group and its members (`GET /api/node-groups`). */
export type NodeGroup = z.infer<typeof NodeGroupSchema>;

/**
 * `POST /api/enrollment-tokens` and `POST /api/nodes/:id/reenroll`: a one-time token, shown once.
 * A re-enrollment token also replaces an existing crha node's key.
 */
export type EnrollmentTokenResponse = z.infer<typeof EnrollmentTokenResponseSchema>;

/** `GET /api/node-groups`; `more` is present only with `limit` (doc/design/webui.md "Entity search"). */
export type NodeGroupListResponse = z.infer<typeof NodeGroupListResponseSchema>;

/**
 * One node access grant: a user or user group may see and run tasks on a node or on the nodes of a node group.
 * There is one level. `granteeName` / `targetName` are null when the grantee or target was deleted.
 */
export type NodeAccessGrant = z.infer<typeof NodeAccessGrantSchema>;

/** Query parameters of `GET /api/node-access-grants`. */
export type NodeAccessGrantFilter = z.infer<typeof NodeAccessGrantFilterSchema>;

/** A trust alias or trust entry that is out of sync with crhs-managed node groups. */
export type TrustWarningKind = z.infer<typeof TrustWarningKindSchema>;
export type TrustWarningSeverity = z.infer<typeof TrustWarningSeveritySchema>;

export type TrustWarning = z.infer<typeof TrustWarningSchema>;

export type TrustStatus = TrustReport["kind"];
/**
 * A trust key as the API returns it: the protocol's key in crhs's JSON form, where bytes are standard
 * base64 text (doc/design/protocol.md "JSON storage forms").
 */
export type TrustEntryKey =
	| Exclude<TrustKey, { kind: "webauthn" }>
	| { kind: "webauthn"; credentialId: string; coseKey: string; rpId: string; origins: string[] };
export type TrustEntry = Omit<ProtocolTrustEntry, "key"> & { key: TrustEntryKey };
export type TrustSummary = Omit<ProtocolTrustSummary, "trust"> & { trust: TrustEntry[] };
export type GuardRule = ProtocolGuardRule;

/** The trust panel of a node (doc/design/privilege.md "Trust cache"). */
export interface NodeTrust {
	status: TrustStatus | null;
	message: string | null;
	digest: string | null;
	updatedAt: string | null;
	/** The last report is kept after a disconnect but is stale until the connection reports again. */
	stale: boolean;
	summary: TrustSummary | null;
}

/** A node as the WebUI lists and opens it. */
export type PublicNode = z.infer<typeof PublicNodeSchema>;

/** `GET /api/nodes`; `more` is present only with `limit`. */
export type NodeListResponse = z.infer<typeof NodeListResponseSchema>;

/** What to paste into ~/privileged.toml as a crhs trust entry. */
export type CrhsKey = z.infer<typeof CrhsKeySchema>;

/**
 * `GET /api/privilege/crhs-key`: the newest key and every key, newest first
 * (doc/design/privilege.md "Authorization signing key").
 */
export type CrhsKeyResponse = z.infer<typeof CrhsKeyResponseSchema>;

export type SshCredential = z.infer<typeof SshCredentialSchema>;

/** One hop of a confirmed route (`GET /api/nodes/:id`'s `ssh`). */
export type SshHop = z.infer<typeof SshHopSchema>;

/** One hop as the route editor submits it; `hostFingerprint` is empty until the probe confirmed it. */
export type SshHopInput = z.infer<typeof SshHopInputSchema>;

/** Body of `POST /api/ssh-nodes`, `/ssh-nodes/probe` and `/ssh-nodes/test`. */
export type SshTargetInput = z.infer<typeof SshTargetInputSchema>;

/** How crhs reaches an SSH node (administrators only). */
export type SshNodeDetails = z.infer<typeof SshNodeDetailsSchema>;

/**
 * A node's file manager (doc/design/webui.md "Node pages"): listings and stats are `file.list` /
 * `file.stat` tasks with purpose `browse`, run as the signed-in user and unprivileged.
 */
export type NodeFileInfo = z.infer<typeof NodeFileInfoSchema>;

/** One entry of a node listing; the path is absolute. */
export type NodeFileEntry = z.infer<typeof NodeFileEntrySchema>;

/** `GET /api/nodes/:id/files?path=…`: the entries under an absolute directory path. */
export type NodeFilesResponse = z.infer<typeof NodeFilesResponseSchema>;

/** `GET /api/nodes/:id/stat?path=…`. */
export type NodeFileResponse = z.infer<typeof NodeFileResponseSchema>;
