/**
 * Nodes, node groups, node access, SSH routes and the trust panel
 * (doc/design/webui.md "Node pages", doc/design/access-control.md "Ownership, access grants and sharing",
 * doc/design/privilege.md "Trust cache"). The trust shapes are the protocol's own types.
 */

import type {
	JsonFacts,
	GuardRule as ProtocolGuardRule,
	TrustEntry as ProtocolTrustEntry,
	TrustSummary as ProtocolTrustSummary,
	TrustKey,
	TrustReport,
} from "@crh/protocol";

/** How the caller reaches a node: administrators, or a granted user (one level). */
export type NodeAccess = "admin" | "granted";

export type GranteeType = "user" | "user_group";
/** What an access grant points at (doc/design/access-control.md "Ownership, access grants and sharing"). */
export type AccessTargetType = "node" | "node_group";

/** A node group as a node response names it. */
export interface NodeGroupRef {
	id: string;
	name: string;
}

/** A node group and its members (`GET /api/node-groups`). */
export interface NodeGroup extends NodeGroupRef {
	memberIds: string[];
}

/**
 * `POST /api/enrollment-tokens` and `POST /api/nodes/:id/reenroll`: a one-time token, shown once.
 * A re-enrollment token also replaces an existing crha node's key.
 */
export interface EnrollmentTokenResponse {
	token: string;
	expiresAt: string;
}

/** `GET /api/node-groups`; `more` is present only with `limit` (doc/design/webui.md "Entity search"). */
export interface NodeGroupListResponse {
	groups: NodeGroup[];
	more?: boolean;
}

/**
 * One node access grant: a user or user group may see and run tasks on a node or on the nodes of a node group.
 * There is one level. `granteeName` / `targetName` are null when the grantee or target was deleted.
 */
export interface NodeAccessGrant {
	id: string;
	granteeType: GranteeType;
	granteeId: string;
	granteeName: string | null;
	targetType: AccessTargetType;
	targetId: string;
	targetName: string | null;
	createdAt: string;
	createdByUserId: string;
}

/** Query parameters of `GET /api/node-access-grants`. */
export interface NodeAccessGrantFilter {
	targetType?: AccessTargetType;
	targetId?: string;
	granteeType?: GranteeType;
	granteeId?: string;
}

/** A trust alias or trust entry that is out of sync with crhs-managed node groups. */
export type TrustWarningKind = "alias_superfluous" | "alias_unknown" | "alias_missing" | "trust_unknown";
export type TrustWarningSeverity = "danger" | "warning" | "info";

export interface TrustWarning {
	kind: TrustWarningKind;
	severity: TrustWarningSeverity;
	/** The alias or node group UUID the warning is about; null for a trust entry. */
	uuid: string | null;
	/** The node group the UUID names, when it is one. */
	nodeGroupName: string | null;
	/** The trust entry name, for `trust_unknown`. */
	trustName: string | null;
	message: string;
}

export type TrustStatus = TrustReport["kind"];
export type TrustEntryKey = TrustKey;
export type TrustEntry = ProtocolTrustEntry;
export type TrustSummary = ProtocolTrustSummary;
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

export interface PublicNode {
	id: string;
	name: string;
	transport: "client" | "ssh";
	status: "pending" | "active";
	hostname: string | null;
	clientVersion: string | null;
	privilegedMode: string | null;
	lastSeenAt: string | null;
	createdAt: string;
	approvedAt: string | null;
	/** The crhs-managed node groups the node belongs to. */
	nodeGroups: NodeGroupRef[];
	access: NodeAccess;
	facts: JsonFacts | null;
	keyFingerprint: string | null;
	/** Whether crha is connected now; null for SSH nodes (they connect per task). */
	connected: boolean | null;
	/**
	 * The node's measured clock offset from crhs, when it exceeds the warning threshold
	 * (doc/design/privilege.md "Clock"). `offsetMs` is local clock minus crhs (positive: the node is ahead);
	 * null when the offset is within the threshold, the warning is off, or there is no measurement.
	 */
	clockWarning: { offsetMs: number; thresholdMs: number } | null;
	/** Out-of-sync trust aliases and unknown trust entries (doc/design/privilege.md "Trust cache"). */
	trustWarnings: TrustWarning[];
}

/** `GET /api/nodes`; `more` is present only with `limit`. */
export interface NodeListResponse {
	nodes: PublicNode[];
	more?: boolean;
}

/** What to paste into ~/privileged.toml as a crhs trust entry. */
export interface CrhsKey {
	authorizedKey: string;
	fingerprint: string;
}

/**
 * `GET /api/privilege/crhs-key`: the newest key and every key, newest first
 * (doc/design/privilege.md "Authorization signing key").
 */
export interface CrhsKeyResponse {
	key: CrhsKey;
	keys: CrhsKey[];
}

export interface SshCredential {
	id: string;
	name: string;
	publicKey: string;
	createdAt: string;
	/** The nodes that use this credential on any hop of their route. */
	usedBy: { id: string; name: string }[];
}

/** One hop of a confirmed route (`GET /api/nodes/:id`'s `ssh`). */
export interface SshHop {
	host: string;
	port: number;
	user: string;
	/** Pinned host fingerprint, "SHA256:<base64>" as OpenSSH prints it. Empty only while probing. */
	hostFingerprint: string;
	/** The credential that authenticates this hop. */
	credentialId: string;
	/** The same credential with its display name, when it still exists. */
	credential: { id: string; name: string | null };
}

/** One hop as the route editor submits it; `hostFingerprint` is empty until the probe confirmed it. */
export interface SshHopInput {
	host: string;
	port?: number;
	user: string;
	hostFingerprint?: string;
	/** This hop's own credential. */
	credentialId: string;
}

/** Body of `POST /api/ssh-nodes`, `/ssh-nodes/probe` and `/ssh-nodes/test`. */
export interface SshTargetInput extends SshHopInput {
	/** Jump hosts in order, then the node itself. The top-level hop is the target. */
	jumps?: SshHopInput[];
}

/** How crhs reaches an SSH node (administrators only). */
export interface SshNodeDetails {
	/** Jump hosts in order, then the node itself; each carries its own credential. */
	hops: SshHop[];
}
