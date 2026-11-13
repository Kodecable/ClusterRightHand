import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, test, vi } from "vitest";
import { renderWithI18n } from "@/test/render";
import { NewUserDialog } from "./new-user-dialog";

afterEach(() => {
	vi.unstubAllGlobals();
});

describe("New user dialog", () => {
	test("refuses a username that does not start with a letter before submitting", async () => {
		const fetchMock = vi.fn();
		vi.stubGlobal("fetch", fetchMock);
		renderWithI18n(<NewUserDialog onClose={() => undefined} />);
		const user = userEvent.setup();
		await user.type(screen.getByLabelText("Username"), "1st-user");
		await user.click(screen.getByRole("button", { name: "New user" }));
		expect(
			await screen.findByText("Use 1–64 characters of a-z, 0-9, '.', '_' or '-', starting with a letter."),
		).toBeInTheDocument();
		expect(fetchMock).not.toHaveBeenCalled();
	});
});
