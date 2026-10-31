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
