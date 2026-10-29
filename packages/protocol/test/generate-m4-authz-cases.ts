/**
 * Regenerate test/interop/m4_authz_cases.json:
 *   node test/generate-m4-authz-cases.ts
 */
import { writeFileSync } from "node:fs";
import { buildAuthzCases } from "./m4_authz_cases.ts";

const target = new URL("../../../test/interop/m4_authz_cases.json", import.meta.url);
writeFileSync(target, `${JSON.stringify(buildAuthzCases(), null, "\t")}\n`);
console.log(`wrote ${target.pathname}`);
