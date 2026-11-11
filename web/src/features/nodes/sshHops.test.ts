import { expect, test } from "vitest";
import {
	addHop,
	editHop,
	emptyHop,
	firstUnpinned,
	type Hop,
	hopBodies,
	pinHop,
	removeHop,
	validateHops,
} from "./sshHops";

const h = (host: string, hostFingerprint = "", credentialId = "cred"): Hop => ({
	host,
	port: "22",
	user: "u",
	hostFingerprint,
	credentialId,
});
const keys = (hops: Hop[]) => hops.map((x) => x.hostFingerprint);

test("editHop clears only that hop's pin on a host or port change", () => {
	const hops = [h("a", "A"), h("b", "B"), h("c", "C")];
	expect(keys(editHop(hops, 1, { host: "b" }))).toEqual(["A", "B", "C"]);
	const edited = editHop(hops, 1, { host: "x" });
	expect(edited[1]?.host).toBe("x");
	// The pins of the other rows belong to their own addresses and stay.
	expect(keys(edited)).toEqual(["A", "", "C"]);
	expect(keys(editHop(hops, 0, { port: "2222" }))).toEqual(["", "B", "C"]);
});

test("editHop keeps every pin when the user or credential changes", () => {
	const hops = [h("a", "A"), h("b", "B")];
	expect(keys(editHop(hops, 0, { user: "other" }))).toEqual(["A", "B"]);
	expect(keys(editHop(hops, 1, { credentialId: "other" }))).toEqual(["A", "B"]);
});

test("addHop appends the new target and removes the target in place", () => {
	const hops = [h("j1", "1"), h("t", "T")];
	const added = addHop(hops);
	expect(added.map((x) => x.host)).toEqual(["j1", "t", ""]);
	// The previous target keeps its pin and becomes a jump.
	expect(keys(added)).toEqual(["1", "T", ""]);
	expect(emptyHop()).toEqual({ host: "", port: "22", user: "", hostFingerprint: "", credentialId: "" });

	const removedJump = removeHop([h("j1", "1"), h("j2", "2"), h("t", "T")], 0);
	expect(removedJump.map((x) => x.host)).toEqual(["j2", "t"]);
	expect(keys(removedJump)).toEqual(["2", "T"]);

	// Removing the target makes the previous jump the target, with its own pin.
	const removedTarget = removeHop([h("j1", "1"), h("t", "T")], 1);
	expect(removedTarget.map((x) => x.host)).toEqual(["j1"]);
	expect(keys(removedTarget)).toEqual(["1"]);
	const only = [h("j1")];
	expect(removeHop(only, 0)).toBe(only);
});

test("pinHop and firstUnpinned", () => {
	let hops = [h("a"), h("t")];
	expect(firstUnpinned(hops)).toBe(0);
	hops = pinHop(hops, 0, "SHA256:x");
	expect(firstUnpinned(hops)).toBe(1);
	expect(firstUnpinned(pinHop(hops, 1, "SHA256:y"))).toBe(-1);
});

test("validateHops and hopBodies", () => {
	expect(validateHops([h("")])).toEqual({ hop: 0, code: "host-required" });
	expect(validateHops([{ ...h("j"), user: " " }, h("t")])).toEqual({ hop: 0, code: "user-required" });
	expect(validateHops([h("j"), { ...h("t"), port: "0" }])).toEqual({ hop: 1, code: "port-invalid" });
	expect(validateHops([h("j"), { ...h("t"), credentialId: "" }])).toEqual({ hop: 1, code: "credential-required" });
	expect(validateHops([h("j"), h("t")])).toBeUndefined();
	expect(hopBodies([h("j", "K", "cj"), h("t", "", "ct")])).toEqual({
		host: "t",
		port: 22,
		user: "u",
		credentialId: "ct",
		jumps: [{ host: "j", port: 22, user: "u", credentialId: "cj", hostFingerprint: "K" }],
	});
});
