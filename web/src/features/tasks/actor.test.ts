import type { TaskView } from "@crh/api";
import { expect, test } from "vitest";
import { taskActor } from "./actor";

test("taskActor prefers the resolved on-behalf-of user", () => {
	const task = { onBehalfOfUserId: "u1", actorType: "agent", actorId: "a1" } as TaskView;
	expect(taskActor(task, (id) => (id === "u1" ? "Alice" : undefined))).toEqual({ name: "Alice", id: "u1" });
	expect(taskActor(task, () => undefined)).toEqual({ name: "u1", id: "u1" });
});
