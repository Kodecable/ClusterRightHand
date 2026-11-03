import type { SoakParams } from "./params.ts";

/** The parent passes the resolved parameters as JSON in SOAK_PARAMS. */
export function parseChildParams(): SoakParams {
	const raw = process.env.SOAK_PARAMS;
	if (!raw) throw new Error("SOAK_PARAMS is missing; run the soak through test/soak/run.ts");
	const params = JSON.parse(raw) as SoakParams;
	if (!params.outDir) throw new Error("SOAK_PARAMS.outDir is missing");
	return params;
}
