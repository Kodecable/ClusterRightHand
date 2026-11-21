/**
 * The protocol majors crhs serves (doc/design/protocol.md "The major in the clear", "Compatibility across
 * majors"). crha names its major in the WebSocket request; crhs refuses a major it does not serve with
 * HTTP 426 before any handshake, and picks the prologue (and, once older majors are served, the codec)
 * from this list. The current major gets a normal connection; an older one in the window will get an
 * upgrade-only connection, frozen to that major's upgrade path.
 *
 * Before the first stable release crhs serves only the current major: no older codec exists yet.
 */
import {
	DATA_NOISE_PROLOGUE_PREFIX,
	factsFromJson,
	NOISE_PROLOGUE_PREFIX,
	PROTOCOL_MAJOR,
	subprotocolFor,
	type TaskSpec,
} from "@crh/protocol";
import { UserError } from "../util/errors.ts";

export interface ServedMajor {
	major: number;
	/** Whether this is the current major; any other served major gets an upgrade-only connection. */
	current: boolean;
	/** The control connection's Noise prologue prefix for this major. */
	prologue: string;
	/** The data connection's Noise prologue prefix for this major. */
	dataPrologue: string;
}

const CURRENT: ServedMajor = {
	major: PROTOCOL_MAJOR,
	current: true,
	prologue: NOISE_PROLOGUE_PREFIX,
	dataPrologue: DATA_NOISE_PROLOGUE_PREFIX,
};

/** The majors this release serves, current first. Each release's documentation states the same list. */
export const SERVED_MAJORS: readonly ServedMajor[] = Object.freeze([CURRENT]);

/** The served major `major`, or undefined when crhs does not serve it. */
export function servedMajor(
	major: number | undefined,
	served: readonly ServedMajor[] = SERVED_MAJORS,
): ServedMajor | undefined {
	return major === undefined ? undefined : served.find((entry) => entry.major === major);
}

/** The code of a request refused because its node is on an upgrade-only connection. */
export const UPGRADE_REQUIRED_CODE = "upgrade_required";

/**
 * Whether an upgrade-only node may run `spec`: only the frozen upgrade path, which is `node.upgrade`
 * and a `file.read` of the upgrade log the node reported (doc/design/protocol.md "Upgrade-only connections").
 */
export function upgradeOnlyAllows(spec: TaskSpec, factsJson: string | null): boolean {
	if (spec.kind === "node.upgrade") return true;
	if (spec.kind !== "file.read") return false;
	let logPath: string | undefined;
	try {
		logPath = factsJson === null ? undefined : factsFromJson(JSON.parse(factsJson)).upgradeLogPath;
	} catch {
		logPath = undefined;
	}
	return logPath !== undefined && spec.path === logPath;
}

/** The refusal of any other task on an upgrade-only node. */
export function upgradeRequired(nodeName: string): UserError {
	return new UserError(
		`node ${nodeName} runs an older protocol major and accepts only an upgrade; upgrade its crha first`,
		UPGRADE_REQUIRED_CODE,
	);
}

/** The header of a 426 refusal that lists the served majors, for crha to log (comma-separated). */
export const SERVED_MAJORS_HEADER = "CRH-Served-Majors";

/** The HTTP 426 response crhs sends to a node of a major it does not serve, before any WebSocket upgrade. */
export function refusalResponse(
	clientMajor: number | undefined,
	served: readonly ServedMajor[] = SERVED_MAJORS,
): string {
	const list = served.map((entry) => entry.major).join(", ");
	const body =
		clientMajor === undefined
			? `crhs could not read the protocol major of this request; it serves protocol majors ${list}.\n`
			: `crhs serves protocol majors ${list}; this crha speaks major ${clientMajor}. Upgrade crha by hand, as the release documentation describes.\n`;
	return [
		"HTTP/1.1 426 Upgrade Required",
		`Upgrade: ${served.map((entry) => subprotocolFor(entry.major)).join(", ")}`,
		`${SERVED_MAJORS_HEADER}: ${served.map((entry) => entry.major).join(",")}`,
		"Connection: close",
		"Content-Type: text/plain; charset=utf-8",
		`Content-Length: ${Buffer.byteLength(body)}`,
		"",
		body,
	].join("\r\n");
}
