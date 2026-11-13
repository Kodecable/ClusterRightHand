/**
 * Starting file plane tasks through the Cluster API (doc/design/library.md "File plane"). The caller
 * names the crhs-side location; these functions fill in the transfer endpoint, the task spec and the
 * stored transfer record. Phase 1's only location kind is a staging file; a library location is
 * added in phase 2 without touching the transport.
 */
import { randomUUID } from "node:crypto";
import type { TaskSpec } from "@crh/protocol";
import { newStagingLocation, stageBytes, type TransferLocationJson } from "../library/transfer-location.ts";
import { UserError } from "../util/errors.ts";
import type { ClusterCore } from "./core.ts";
import { createTask } from "./task-dispatch.ts";
import type { CreateTaskInput, TaskView } from "./types.ts";

/** The transfer record stored in the task row. */
interface TransferRecord {
	transferId: string;
	location: TransferLocationJson;
}

export type PushFileInput = Omit<CreateTaskInput, "spec" | "input" | "transfer"> & {
	/** The node-side destination path. */
	path: string;
	/** The crhs-side source: a staging location with its size and SHA-256. */
	location: TransferLocationJson;
	overwrite?: boolean;
	mode?: number;
	owner?: string;
	group?: string;
};

export type PullFileInput = Omit<CreateTaskInput, "spec" | "input" | "transfer"> & {
	/** The node-side source path. */
	path: string;
	/** The most the destination accepts; the node refuses a larger file with too_large. */
	maxBytes: number;
	/** The crhs-side destination; a new staging location when omitted. */
	location?: TransferLocationJson;
};

/** A new, empty staging destination for a pull. */
export function stagingLocation(): TransferLocationJson {
	return newStagingLocation();
}

/** Writes bytes into the staging directory, for a push source. */
export function stageBytesForPush(core: ClusterCore, data: Uint8Array): Promise<TransferLocationJson> {
	return stageBytes(core.transferRoot, data);
}

/** Starts a file.push task: crhs streams the location's bytes to the node's path. */
export function pushFile(core: ClusterCore, input: PushFileInput): Promise<TaskView> {
	const { path, location, overwrite, mode, owner, group, ...rest } = input;
	if (location.size === null || location.sha256 === null) {
		throw new UserError("a push source must have a size and sha256");
	}
	const transferId = randomUUID();
	const spec: TaskSpec = {
		kind: "file.push",
		path,
		size: location.size,
		sha256: Buffer.from(location.sha256, "hex"),
		overwrite: overwrite === true,
		mode: mode ?? 0,
		owner: owner ?? "",
		group: group ?? "",
		endpoint: { kind: "crhs", transferId },
	};
	const record: TransferRecord = { transferId, location };
	return createTask(core, {
		...rest,
		spec,
		outputMode: rest.outputMode ?? "status",
		transfer: JSON.stringify(record),
	});
}

/** Starts a file.pull task: crhs receives the node's regular file into the location. */
export function pullFile(core: ClusterCore, input: PullFileInput): Promise<TaskView> {
	const { path, maxBytes, location, ...rest } = input;
	const transferId = randomUUID();
	const spec: TaskSpec = {
		kind: "file.pull",
		path,
		maxBytes,
		endpoint: { kind: "crhs", transferId },
	};
	const record: TransferRecord = { transferId, location: location ?? newStagingLocation() };
	return createTask(core, {
		...rest,
		spec,
		outputMode: rest.outputMode ?? "status",
		transfer: JSON.stringify(record),
	});
}
