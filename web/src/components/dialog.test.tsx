import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, test } from "vitest";
import { Button } from "@/components/ui/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
	DialogTrigger,
} from "@/components/ui/dialog";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle, SheetTrigger } from "@/components/ui/sheet";
import { renderWithI18n } from "@/test/render";

function DialogHarness() {
	const [open, setOpen] = useState(false);
	return (
		<Dialog open={open} onOpenChange={setOpen}>
			<DialogTrigger render={<Button />}>Open dialog</DialogTrigger>
			<DialogContent>
				<DialogHeader>
					<DialogTitle>Test dialog</DialogTitle>
					<DialogDescription>Focus and escape behaviour.</DialogDescription>
				</DialogHeader>
				<div className="flex gap-2">
					<Button>First</Button>
					<Button>Second</Button>
				</div>
				<DialogFooter>
					<Button variant="outline" onClick={() => setOpen(false)}>
						Done
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}

describe("Dialog (Base UI)", () => {
	test("Escape closes it", async () => {
		const user = userEvent.setup();
		renderWithI18n(<DialogHarness />);
		await user.click(screen.getByRole("button", { name: "Open dialog" }));
		expect(await screen.findByRole("dialog", { name: "Test dialog" })).toBeInTheDocument();
		await user.keyboard("{Escape}");
		await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
	});

	test("focus moves inside on open", async () => {
		const user = userEvent.setup();
		renderWithI18n(<DialogHarness />);
		await user.click(screen.getByRole("button", { name: "Open dialog" }));
		const dialog = await screen.findByRole("dialog", { name: "Test dialog" });
		// Base UI documents the Tab loop; jsdom has no layout, so `tabbable`
		// cannot find the focusable elements here. The loop is asserted in the
		// Playwright smoke test against Chromium.
		await waitFor(() => expect(dialog.contains(document.activeElement)).toBe(true));
	});
});

/** A dialog opened from inside another dialog: Base UI treats it as nested. */
function NestedDialogHarness() {
	return (
		<Dialog defaultOpen>
			<DialogContent data-testid="parent-dialog">
				<DialogHeader>
					<DialogTitle>Parent dialog</DialogTitle>
				</DialogHeader>
				<Dialog defaultOpen>
					<DialogContent data-testid="child-dialog">
						<DialogHeader>
							<DialogTitle>Child dialog</DialogTitle>
						</DialogHeader>
					</DialogContent>
				</Dialog>
			</DialogContent>
		</Dialog>
	);
}

describe("nested dialogs", () => {
	test("renders the nested backdrop and leaves the parent popup undimmed", async () => {
		renderWithI18n(<NestedDialogHarness />);
		const parent = await screen.findByTestId("parent-dialog");
		const child = await screen.findByTestId("child-dialog");

		// Base UI still marks the parent as having an open child; no styles hang off that now.
		await waitFor(() => expect(parent).toHaveAttribute("data-nested-dialog-open"));
		expect(child).toHaveAttribute("data-nested");
		expect(parent.className).not.toContain("scale-[");
		expect(parent.className).not.toContain("after:");

		// A nested dialog renders its own backdrop with the regular look, above the parent popup
		// and below its own popup (portal order: parent overlay, parent popup, child overlay, child popup).
		const overlays = document.querySelectorAll('[data-slot="dialog-overlay"]');
		expect(overlays).toHaveLength(2);
		expect(overlays[1]?.className).toBe(overlays[0]?.className);
		expect(overlays[1]).toHaveClass("fixed", "inset-0", "z-50", "bg-black/10");
		expect(parent.compareDocumentPosition(overlays[1] as Node) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
		expect((overlays[1] as Node).compareDocumentPosition(child) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
	});
});

function SheetHarness() {
	const [open, setOpen] = useState(false);
	return (
		<Sheet open={open} onOpenChange={setOpen}>
			<SheetTrigger render={<Button />}>Open sheet</SheetTrigger>
			<SheetContent>
				<SheetHeader>
					<SheetTitle>Test sheet</SheetTitle>
					<SheetDescription>Escape must close the mobile drawer.</SheetDescription>
				</SheetHeader>
				<Button>Inside</Button>
			</SheetContent>
		</Sheet>
	);
}

describe("Sheet (mobile drawer)", () => {
	test("Escape closes it", async () => {
		const user = userEvent.setup();
		renderWithI18n(<SheetHarness />);
		await user.click(screen.getByRole("button", { name: "Open sheet" }));
		expect(await screen.findByRole("dialog", { name: "Test sheet" })).toBeInTheDocument();
		await user.keyboard("{Escape}");
		await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
	});
});
