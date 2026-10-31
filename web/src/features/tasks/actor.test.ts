import { expect, test } from "vitest";
import type { TaskView } from "@/lib/api/types";
import { taskActor } from "./actor";

test("taskActor prefers the resolved on-behalf-of user", () => {
	const task = { onBehalfOfUserId: "u1", actorType: "agent", actorId: "a1" } as TaskView;
	expect(taskActor(task, (id) => (id === "u1" ? "Alice" : undefined))).toBe("Alice");
	expect(taskActor(task, () => undefined)).toBe("u1");
	expect(taskActor({ ...task, onBehalfOfUserId: null }, () => undefined)).toBe("agent a1");
});
