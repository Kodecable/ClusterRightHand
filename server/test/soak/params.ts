/**
 * Parameters of the soak / resource test.
 *
 * Every knob is settable from the environment or, with the same name in kebab case, from the command line. The
 * defaults are the project owner's first run: 50 sessions, two at a time, 200 turns of 20 tool calls on four
 * forward-mode nodes, sampled every 15 s.
 */
import { mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";

export interface SoakParams {
	/** Sessions to run in total. */
	sessions: number;
	/** Sessions running side by side. */
	concurrency: number;
	/** Turns per session, one after another. */
	turns: number;
	/** Node exec tool calls in every turn's assistant message. */
	toolsPerTurn: number;
	/** Real crha containers. */
	nodes: number;
	/** Share of tool calls marked privileged. */
	privRatio: number;
	/** stdout bytes of a normal tool call. */
	outputBytes: number;
	/** Share of tool calls that print more than 50 KB. */
	bigOutputRatio: number;
	/** Seconds between samples. */
	sampleSeconds: number;
	/** Build crha with the pprof tag and capture Go heap profiles from every node. */
	pprof: boolean;
	/** Fractions of the total tool calls at which to capture heap profiles, ascending. */
	pprofPoints: number[];
	/** Where samples.csv, summary.md and the file-backed crhs state live. */
	outDir: string;
	/** A single turn that takes longer than this fails the session. */
	turnTimeoutMs: number;
	/** Context window of the faux model; compaction happens naturally below it. */
	contextWindow: number;
}

export class SoakParamError extends Error {}

const HELP = `ClusterRightHand soak / resource test

usage: node test/soak/run.ts [options]

  --sessions <n>           SESSIONS           50
  --concurrency <n>        CONCURRENCY        2
  --turns <n>              TURNS              200
  --tools-per-turn <n>     TOOLS_PER_TURN     20
  --nodes <n>              NODES              4
  --priv-ratio <0..1>      PRIV_RATIO         0.1
  --output-bytes <n>       OUTPUT_BYTES       200
  --big-output-ratio <r>   BIG_OUTPUT_RATIO   0.01
  --sample-seconds <n>     SAMPLE_SECONDS     15
  --pprof                  PPROF              0 (off); build crha with -tags pprof and save heap profiles
  --pprof-points <list>    PPROF_POINTS       0.1,0.5,1.0 (fractions of all tool calls)
  --out-dir <path>         OUT_DIR            a new directory under /tmp
  --turn-timeout <n>       TURN_TIMEOUT_SECONDS 900
  --context-window <n>     CONTEXT_WINDOW     128000

Podman must be available and CRH_TEST_PODMAN=1 must be set. The real crha image is built on the
first run. See server/test/soak/README.md.`;

export interface ParsedParams {
	help: boolean;
	params?: SoakParams;
}

/** Reads the command line and the environment; `--out-dir` is left as given and resolved by `materializeOutDir`. */
export function parseParams(argv: string[], env: NodeJS.ProcessEnv): ParsedParams {
	let values: Record<string, string | boolean | undefined>;
	try {
		({ values } = parseArgs({
			args: argv,
			options: {
				sessions: { type: "string" },
				concurrency: { type: "string" },
				turns: { type: "string" },
				"tools-per-turn": { type: "string" },
				nodes: { type: "string" },
				"priv-ratio": { type: "string" },
				"output-bytes": { type: "string" },
				"big-output-ratio": { type: "string" },
				"sample-seconds": { type: "string" },
				pprof: { type: "boolean" },
				"pprof-points": { type: "string" },
				"out-dir": { type: "string" },
				"turn-timeout": { type: "string" },
				"context-window": { type: "string" },
				help: { type: "boolean", short: "h" },
			},
			allowPositionals: false,
		}));
	} catch (err) {
		throw new SoakParamError((err as Error).message);
	}
	if (values.help) return { help: true };

	const text = (flag: string | boolean | undefined, envName: string, fallback: string): string => {
		if (typeof flag === "string") return flag;
		const fromEnv = env[envName];
		return fromEnv === undefined || fromEnv === "" ? fallback : fromEnv;
	};
	const integer = (flag: string | boolean | undefined, envName: string, fallback: number, min: number): number => {
		const raw = text(flag, envName, String(fallback));
		const value = Number(raw);
		if (!Number.isInteger(value) || value < min) {
			throw new SoakParamError(`${envName} must be an integer >= ${min}, got ${JSON.stringify(raw)}`);
		}
		return value;
	};
	const ratio = (flag: string | boolean | undefined, envName: string, fallback: number): number => {
		const raw = text(flag, envName, String(fallback));
		const value = Number(raw);
		if (!Number.isFinite(value) || value < 0 || value > 1) {
			throw new SoakParamError(`${envName} must be a number between 0 and 1, got ${JSON.stringify(raw)}`);
		}
		return value;
	};
	const positiveNumber = (flag: string | boolean | undefined, envName: string, fallback: number): number => {
		const raw = text(flag, envName, String(fallback));
		const value = Number(raw);
		if (!Number.isFinite(value) || value <= 0) {
			throw new SoakParamError(`${envName} must be a positive number, got ${JSON.stringify(raw)}`);
		}
		return value;
	};
	const toggle = (flag: string | boolean | undefined, envName: string): boolean => {
		if (typeof flag === "boolean") return flag;
		const raw = env[envName];
		if (raw === undefined || raw === "") return false;
		switch (raw.trim().toLowerCase()) {
			case "1":
			case "true":
			case "yes":
			case "on":
				return true;
			case "0":
			case "false":
			case "no":
			case "off":
				return false;
			default:
				throw new SoakParamError(`${envName} must be 1/0 (or true/false), got ${JSON.stringify(raw)}`);
		}
	};
	const fractions = (flag: string | boolean | undefined, envName: string): number[] => {
		const raw = text(flag, envName, "0.1,0.5,1.0");
		const parts = raw
			.split(",")
			.map((part) => part.trim())
			.filter((part) => part !== "");
		if (parts.length === 0) throw new SoakParamError(`${envName} is empty; give fractions such as 0.1,0.5,1.0`);
		const values = parts.map((part) => {
			const value = Number(part);
			if (!Number.isFinite(value) || value <= 0 || value > 1) {
				throw new SoakParamError(`${envName} entries must be fractions in (0, 1], got ${JSON.stringify(part)}`);
			}
			return value;
		});
		return [...new Set(values)].sort((a, b) => a - b);
	};

	const params: SoakParams = {
		sessions: integer(values.sessions, "SESSIONS", 50, 1),
		concurrency: integer(values.concurrency, "CONCURRENCY", 2, 1),
		turns: integer(values.turns, "TURNS", 200, 1),
		toolsPerTurn: integer(values["tools-per-turn"], "TOOLS_PER_TURN", 20, 1),
		nodes: integer(values.nodes, "NODES", 4, 1),
		privRatio: ratio(values["priv-ratio"], "PRIV_RATIO", 0.1),
		outputBytes: integer(values["output-bytes"], "OUTPUT_BYTES", 200, 0),
		bigOutputRatio: ratio(values["big-output-ratio"], "BIG_OUTPUT_RATIO", 0.01),
		sampleSeconds: positiveNumber(values["sample-seconds"], "SAMPLE_SECONDS", 15),
		pprof: toggle(values.pprof, "PPROF"),
		pprofPoints: fractions(values["pprof-points"], "PPROF_POINTS"),
		outDir: text(values["out-dir"], "OUT_DIR", ""),
		turnTimeoutMs: Math.round(positiveNumber(values["turn-timeout"], "TURN_TIMEOUT_SECONDS", 900) * 1000),
		contextWindow: integer(values["context-window"], "CONTEXT_WINDOW", 128_000, 4_096),
	};
	if (params.concurrency > params.sessions) {
		throw new SoakParamError("CONCURRENCY cannot exceed SESSIONS");
	}
	return { help: false, params };
}

/** Creates OUT_DIR (a fresh one when the parameters did not name it) and returns the resolved parameters. */
export async function materializeOutDir(params: SoakParams): Promise<SoakParams> {
	const outDir = params.outDir === "" ? await mkdtemp(join(tmpdir(), "crh-soak-")) : params.outDir;
	await mkdir(outDir, { recursive: true });
	return { ...params, outDir };
}

export function usage(): string {
	return HELP;
}
