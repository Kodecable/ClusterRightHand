import { screen } from "@testing-library/react";
import { describe, expect, test } from "vitest";
import { renderWithI18n } from "@/test/render";
import { SessionBanner, type SessionBannerProps } from "./session-banner";

function renderBanner(overrides: Partial<SessionBannerProps> = {}) {
	return renderWithI18n(
		<SessionBanner
			connection="live"
			failure={undefined}
			retry={undefined}
			waitingKind={null}
			queued={0}
			{...overrides}
		/>,
	);
}

describe("SessionBanner", () => {
	test("shows no banner while a session is merely running", () => {
		const { container } = renderBanner();
		expect(container).toBeEmptyDOMElement();
		expect(screen.queryByText("Working…")).not.toBeInTheDocument();
	});

	test("the connection state outranks every other banner", () => {
		renderBanner({
			connection: "reconnecting",
			failure: "the run failed",
			retry: "overloaded",
			waitingKind: "approval",
			queued: 2,
		});
		expect(screen.getByRole("status")).toHaveTextContent("Reconnecting…");
		expect(screen.queryByRole("alert")).not.toBeInTheDocument();
		expect(screen.queryByTestId("waiting-reason")).not.toBeInTheDocument();
		expect(screen.queryByText("2 messages queued")).not.toBeInTheDocument();
	});

	test("a failure outranks the retry, waiting and queued banners", () => {
		renderBanner({ failure: "the run failed", retry: "overloaded", waitingKind: "approval", queued: 2 });
		expect(screen.getByRole("alert")).toHaveTextContent("the run failed");
		expect(screen.queryByTestId("waiting-reason")).not.toBeInTheDocument();
		expect(screen.queryByText("Retrying after an error: overloaded")).not.toBeInTheDocument();
		expect(screen.queryByText("2 messages queued")).not.toBeInTheDocument();
	});

	test("a retry outranks the waiting and queued banners", () => {
		renderBanner({ retry: "overloaded", waitingKind: "authorization", queued: 2 });
		expect(screen.getByRole("status")).toHaveTextContent("Retrying after an error: overloaded");
		expect(screen.queryByTestId("waiting-reason")).not.toBeInTheDocument();
		expect(screen.queryByText("2 messages queued")).not.toBeInTheDocument();
	});

	test("a waiting reason outranks the queued count", () => {
		renderBanner({ waitingKind: "approval", queued: 2 });
		expect(screen.getByTestId("waiting-reason")).toHaveTextContent("The session is waiting for an approval.");
		expect(screen.queryByText("2 messages queued")).not.toBeInTheDocument();
	});

	test("names each waiting kind", () => {
		const { rerender } = renderBanner({ waitingKind: "authorization" });
		expect(screen.getByTestId("waiting-reason")).toHaveTextContent("The session is waiting for a signature.");
		// renderWithI18n provides the providers, so the same tree carries the next props.
		rerender(<SessionBanner connection="live" failure={undefined} retry={undefined} waitingKind="quota" queued={0} />);
		expect(screen.getByTestId("waiting-reason")).toHaveTextContent(
			"The session is paused: its token quota is used up.",
		);
	});

	test("shows the queued count alone when nothing outranks it", () => {
		renderBanner({ queued: 1 });
		expect(screen.getByRole("status")).toHaveTextContent("1 message queued");
		expect(screen.queryByTestId("waiting-reason")).not.toBeInTheDocument();
	});

	test("shows the connecting state", () => {
		renderBanner({ connection: "connecting" });
		expect(screen.getByRole("status")).toHaveTextContent("Connecting…");
	});
});
