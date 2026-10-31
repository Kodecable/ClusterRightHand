import { expect, test } from "vitest";
import type { TaskView } from "@/lib/api/types";
import { taskActor } from "./actor";

test("taskActor prefers the resolved on-behalf-of user", () => {
	const task = { onBehalfOfUserId: "u1", actorType: "agent", actorId: "a1" } as TaskView;
	expect(taskActor(task, (id) => (id === "u1" ? "Alice" : undefined))).toEqual({ name: "Alice", id: "u1" });
	expect(taskActor(task, () => undefined)).toEqual({ name: "u1", id: "u1" });
	expect(taskActor({ ...task, onBehalfOfUserId: null }, () => undefined)).toEqual({ name: "agent a1", id: "a1" });
});

test("taskActor resolves the user that asked directly", () => {
	const task = { onBehalfOfUserId: null, actorType: "user", actorId: "u1" } as TaskView;
	expect(taskActor(task, (id) => (id === "u1" ? "Alice" : undefined))).toEqual({ name: "Alice", id: "u1" });
	expect(taskActor(task, () => undefined)).toEqual({ name: "u1", id: "u1" });
});
