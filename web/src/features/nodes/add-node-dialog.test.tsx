import { fireEvent, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";
import { renderWithI18n } from "@/test/render";
import { AddNodeDialog } from "./add-node-dialog";

const CREATED = { token: "crh1.fp-test.secret", expiresAt: "2026-12-01T00:00:00.000Z" };

afterEach(() => {
	vi.unstubAllGlobals();
});

describe("AddNodeDialog", () => {
	test("shows the command, the crhs address and the token after creating one", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(
				async () =>
					new Response(JSON.stringify(CREATED), {
						status: 201,
						headers: { "content-type": "application/json" },
					}),
			),
		);
		renderWithI18n(<AddNodeDialog onClose={() => {}} />);
		expect(screen.queryByText("sudo crha enroll")).not.toBeInTheDocument();

		fireEvent.click(screen.getByRole("button", { name: "New token" }));
		expect(await screen.findByText("sudo crha enroll")).toBeInTheDocument();
		const address = within(screen.getByRole("group", { name: "crhs address" }));
		expect(address.getByText(window.location.origin)).toBeInTheDocument();
		expect(address.getByRole("button", { name: "Copy crhs address" })).toBeInTheDocument();
		const token = within(screen.getByRole("group", { name: "Enrollment token" }));
		expect(token.getByText(CREATED.token)).toBeInTheDocument();
		expect(token.getByRole("button", { name: "Copy enrollment token" })).toBeInTheDocument();
		expect(screen.getByRole("button", { name: "Copy and close" })).toBeInTheDocument();
		expect(screen.getByText(/The token is shown once and expires/)).toBeInTheDocument();
		expect(screen.getByText(/compare its key fingerprint/)).toBeInTheDocument();
	});
});
