/**
 * Regenerate test/interop/m4_vectors.json (fresh keys every run; needs ssh-keygen):
 *   node test/generate-m4-vectors.ts
 */
import { writeFileSync } from "node:fs";
import { buildVectors } from "./m4_vectors.ts";

const target = new URL("../../../test/interop/m4_vectors.json", import.meta.url);
writeFileSync(target, `${JSON.stringify(buildVectors(), null, "\t")}\n`);
console.log(`wrote ${target.pathname}`);
