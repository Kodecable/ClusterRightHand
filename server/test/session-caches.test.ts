import { describe, expect, it } from "vitest";
import { SessionCaches } from "../src/agent/runtime-host/session-caches.ts";

const session = (id: string) => ({ id, ownerUserId: "u1", orgId: "o1", parentSessionId: null });

describe("SessionCaches provider session index", () => {
	it("resolves both directions, and keeps sessions apart", () => {
		const caches = new SessionCaches();
		caches.rememberProviderSession("c1", "p1", "s1");
		caches.rememberProviderSession("c2", "p2", "s2");

		expect(caches.providerSessionIdFor("s1")).toBe("p1");
		expect(caches.providerSessionIdFor("s2")).toBe("p2");
		expect(caches.providerSessionOf("p1")).toBe("s1");
		expect(caches.providerSessionOf("p2")).toBe("s2");
	});

	it("drops the stale reverse entry when a session learns a new provider id", () => {
		const caches = new SessionCaches();
		caches.rememberProviderSession("c1", "p1", "s1");
		caches.rememberProviderSession("c1", "p2", "s1");

		expect(caches.providerSessionIdFor("s1")).toBe("p2");
		expect(caches.providerSessionOf("p1")).toBeUndefined();
		expect(caches.providerSessionOf("p2")).toBe("s1");
	});

	it("forgets both directions and can learn them again", () => {
		const caches = new SessionCaches();
		caches.rememberSession("c1", session("s1"));
		caches.rememberSubagentParent("s1");
		caches.rememberProviderSession("c1", "p1", "s1");

		caches.forgetSession("s1", "c1");

		expect(caches.sessionFor("c1")).toBeUndefined();
		expect(caches.hasSubagentParent("s1")).toBe(false);
		expect(caches.hasLearnedProvider("c1")).toBe(false);
		expect(caches.providerSessionIdFor("s1")).toBeUndefined();
		expect(caches.providerSessionOf("p1")).toBeUndefined();

		caches.rememberProviderSession("c1", "p1", "s1");
		expect(caches.providerSessionIdFor("s1")).toBe("p1");
		expect(caches.providerSessionOf("p1")).toBe("s1");
	});

	it("forgetting one session leaves the other's mappings", () => {
		const caches = new SessionCaches();
		caches.rememberProviderSession("c1", "p1", "s1");
		caches.rememberProviderSession("c2", "p2", "s2");

		caches.forgetSession("s1", "c1");

		expect(caches.providerSessionIdFor("s1")).toBeUndefined();
		expect(caches.providerSessionIdFor("s2")).toBe("p2");
		expect(caches.providerSessionOf("p2")).toBe("s2");
	});
});
