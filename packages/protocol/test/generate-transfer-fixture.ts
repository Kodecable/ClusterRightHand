/**
 * Regenerate test/interop/transfer_fixture.json:
 *   node test/generate-transfer-fixture.ts
 */
import { writeFileSync } from "node:fs";
import { buildTransferFixture } from "./transfer_fixture.ts";

const target = new URL("../../../test/interop/transfer_fixture.json", import.meta.url);
writeFileSync(target, `${JSON.stringify(buildTransferFixture(), null, "\t")}\n`);
console.log(`wrote ${target.pathname}`);
