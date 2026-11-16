import { screen } from "@testing-library/react";
import { describe, expect, test } from "vitest";
import { renderWithRouter } from "@/test/render";
import { RequestSource } from "./request-source";

describe("RequestSource", () => {
	test("links a session title to its session, and uses the untitled wording", async () => {
		await renderWithRouter(
			<div>
				<RequestSource source={{ type: "session", sessionId: "s1", title: "Clean up" }} />
				<RequestSource source={{ type: "session", sessionId: "s2", title: "" }} />
			</div>,
		);
		expect(screen.getByRole("link", { name: "Clean up" })).toHaveAttribute("href", "/sessions/s1");
		expect(screen.getByRole("link", { name: "New Session" })).toHaveAttribute("href", "/sessions/s2");
	});

	test("names a user with a link, an API token with its name, and the audit actors", async () => {
		await renderWithRouter(
			<div>
				<RequestSource source={{ type: "user", userId: "u1", username: "alice" }} />
				<RequestSource source={{ type: "api_token", tokenId: "t1", name: "deploy" }} />
				<RequestSource source={{ type: "system" }} />
				<RequestSource source={{ type: "auto_review" }} />
				<RequestSource source={{ type: "schedule", scheduleId: "sch1", name: "nightly" }} />
			</div>,
		);
		expect(screen.getByRole("link", { name: "alice" })).toHaveAttribute("href", "/users/u1");
		expect(screen.getByText("API token deploy")).toBeInTheDocument();
		expect(screen.getByText("System")).toBeInTheDocument();
		expect(screen.getByText("Auto Review")).toBeInTheDocument();
		expect(screen.getByText("Schedule nightly")).toBeInTheDocument();
	});
});
