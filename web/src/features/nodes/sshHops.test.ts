import { expect, test } from "vitest";
import {
	addJump,
	clearPinsFrom,
	editHop,
	firstUnpinned,
	type Hop,
	hopBodies,
	moveJump,
	pinHop,
	removeJump,
	validateHops,
} from "./sshHops";

const h = (host: string, hostKey = ""): Hop => ({ host, port: "22", user: "u", hostKey });
const keys = (hops: Hop[]) => hops.map((x) => x.hostKey);

test("clearPinsFrom clears the hop and later ones", () => {
	expect(keys(clearPinsFrom([h("a", "A"), h("b", "B"), h("c", "C")], 1))).toEqual(["A", "", ""]);
});

test("editHop clears pins only on a real change", () => {
	const hops = [h("a", "A"), h("b", "B"), h("c", "C")];
	expect(keys(editHop(hops, 1, { host: "b" }))).toEqual(["A", "B", "C"]);
	const edited = editHop(hops, 1, { host: "x" });
	expect(edited[1]?.host).toBe("x");
	expect(keys(edited)).toEqual(["A", "", ""]);
	expect(keys(editHop(hops, 0, { port: "2222" }))).toEqual(["", "", ""]);
});

test("add, remove and move jumps keep the target last", () => {
	const hops = [h("j1", "1"), h("t", "T")];
	const added = addJump(hops, h("j2"));
	expect(added.map((x) => x.host)).toEqual(["j1", "j2", "t"]);
	expect(keys(added)).toEqual(["1", "", ""]);
	const removed = removeJump([h("j1", "1"), h("j2", "2"), h("t", "T")], 0);
	expect(removed.map((x) => x.host)).toEqual(["j2", "t"]);
	expect(keys(removed)).toEqual(["", ""]);
	expect(removeJump(hops, 1)).toBe(hops);
	const moved = moveJump([h("a", "A"), h("b", "B"), h("t", "T")], 1, -1);
	expect(moved.map((x) => x.host)).toEqual(["b", "a", "t"]);
	expect(keys(moved)).toEqual(["", "", ""]);
	const same = [h("a"), h("t")];
	expect(moveJump(same, 0, 1)).toBe(same);
});

test("pinHop and firstUnpinned", () => {
	let hops = [h("a"), h("t")];
	expect(firstUnpinned(hops)).toBe(0);
	hops = pinHop(hops, 0, "SHA256:x");
	expect(firstUnpinned(hops)).toBe(1);
	expect(firstUnpinned(pinHop(hops, 1, "SHA256:y"))).toBe(-1);
});

test("validateHops and hopBodies", () => {
	expect(validateHops([h("")])).toBe("target: host is required");
	expect(validateHops([h("j"), { ...h("t"), port: "0" }])).toBe("target: invalid port");
	expect(hopBodies([h("j", "K"), h("t")])).toEqual({
		host: "t",
		port: 22,
		user: "u",
		jumps: [{ host: "j", port: 22, user: "u", hostKey: "K" }],
	});
});
