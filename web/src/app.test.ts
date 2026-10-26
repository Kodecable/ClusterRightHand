import { expect, test } from "vitest";
import { appTitle } from "./meta.ts";

test("appTitle", () => {
	expect(appTitle()).toBe("ClusterRightHand");
	expect(appTitle("Nodes")).toBe("ClusterRightHand - Nodes");
});
