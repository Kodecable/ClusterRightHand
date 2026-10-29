/**
 * Regenerate test/interop/crh_frames.json:
 *   node test/generate-crh-frames.ts
 */
import { writeFileSync } from "node:fs";
import { buildFixture } from "./crh_frames.ts";

const target = new URL("../../../test/interop/crh_frames.json", import.meta.url);
writeFileSync(target, `${JSON.stringify(buildFixture(), null, "\t")}\n`);
console.log(`wrote ${target.pathname}`);
