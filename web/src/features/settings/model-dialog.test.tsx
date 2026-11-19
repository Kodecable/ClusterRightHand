import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, test, vi } from "vitest";
import { renderWithRouter } from "@/test/render";
import { ModelDialog } from "./model-dialog";
import { emptyModelRow, type ModelRow } from "./providers";

const standardRow = (): ModelRow => {
	const row = emptyModelRow();
	return {
		...row,
		id: "chat-model",
		thinkingMode: "standard",
		formatLevels: { ...row.formatLevels, low: { kind: "value", value: "" } },
	};
};

describe("ModelDialog level mapping", () => {
	// The level table's cells are rendered as components; a column rebuilt on every keystroke would remount
	// the input, so each typed character would land in a fresh field without focus.
	test("typing a display name or a mapped value keeps the focus in the same field", async () => {
		const user = userEvent.setup();
		const onSave = vi.fn();
		await renderWithRouter(<ModelDialog initial={standardRow()} editing={false} onClose={() => {}} onSave={onSave} />);
		const dialog = await screen.findByRole("dialog");

		const highName = within(dialog).getByLabelText("high display name");
		await user.clear(highName);
		await user.type(highName, "Deep think");
		expect(highName).toBeInTheDocument();
		expect(highName).toHaveFocus();
		expect(highName).toHaveValue("Deep think");

		const lowValue = within(dialog).getByLabelText("low value");
		await user.type(lowValue, "minimal");
		expect(lowValue).toBeInTheDocument();
		expect(lowValue).toHaveFocus();
		expect(lowValue).toHaveValue("minimal");

		await user.click(within(dialog).getByRole("button", { name: "Save model" }));
		expect(onSave).toHaveBeenCalledWith(
			expect.objectContaining({
				labels: expect.objectContaining({ high: "Deep think" }),
				formatLevels: expect.objectContaining({ low: { kind: "value", value: "minimal" } }),
			}),
		);
	});
});
