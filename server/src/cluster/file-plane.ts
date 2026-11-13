/**
 * Starting file plane tasks through the Cluster API (doc/design/library.md "File plane"). The caller
 * names the crhs-side location; these functions fill in the transfer endpoint, the task spec and the
 * stored transfer record. Phase 1's only location kind is a staging file; a library location is
 * added in phase 2 without touching the transport.
 */
import { randomUUID } from "node:crypto";
import type { TaskSpec } from "@crh/protocol";
import { findLibraryFile, libraryForTransfer } from "../library/files.ts";
import type { LibraryRecord } from "../library/library.ts";
import {
	newLibraryLocation,
	newStagingLocation,
	stageBytes,
	type TransferLocationJson,
} from "../library/transfer-location.ts";
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
	/** Create missing parent directories, like write_file's create_parent_dirs. */
	createParentDirs?: boolean;
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
	const { path, location, overwrite, mode, owner, group, createParentDirs, ...rest } = input;
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
		createParentDirs: createParentDirs === true,
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

/** A push source that names a library file: its size and SHA-256 are the row's. */
export async function stageLibrarySource(
	core: ClusterCore,
	libraryId: string,
	libraryPath: string,
): Promise<TransferLocationJson> {
	const row = await findLibraryFile(core.db, libraryId, libraryPath);
	if (!row) throw new UserError(`no such library file ${libraryPath}`);
	return newLibraryLocation(libraryId, libraryPath, {
		overwrite: false,
		createdBy: null,
		size: row.size,
		sha256: row.sha256,
	});
}

export type PushLibraryFileInput = Omit<PushFileInput, "location"> & {
	libraryId: string;
	/** The source path inside the library. */
	libraryPath: string;
};

/** Starts a file.push task whose source is a library file (library → node). */
export async function pushLibraryFile(core: ClusterCore, input: PushLibraryFileInput): Promise<TaskView> {
	const { libraryId, libraryPath, ...rest } = input;
	const location = await stageLibrarySource(core, libraryId, libraryPath);
	return pushFile(core, { ...rest, location });
}

export type PullLibraryFileInput = Omit<PullFileInput, "location" | "maxBytes"> & {
	libraryId: string;
	/** The destination path inside the library. */
	libraryPath: string;
	overwrite?: boolean;
	/** The user the new row records as creator; the task actor's user. */
	createdBy: string | null;
};

/**
 * Starts a file.pull task whose destination is a library path (node → library). The node refuses a
 * file larger than the library's one-file limit; the count and total limits are checked at commit.
 */
export async function pullLibraryFile(core: ClusterCore, input: PullLibraryFileInput): Promise<TaskView> {
	const { libraryId, libraryPath, overwrite, createdBy, ...rest } = input;
	const record: LibraryRecord = await libraryForTransfer(core.db, libraryId);
	const location = newLibraryLocation(libraryId, libraryPath, {
		overwrite: overwrite === true,
		createdBy,
	});
	return pullFile(core, { ...rest, maxBytes: record.row.max_file_bytes, location });
}
