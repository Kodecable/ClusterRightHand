import { render, screen } from "@testing-library/react";
import { describe, expect, test } from "vitest";
import { renderWithI18n } from "@/test/render";
import {
	AuthorizationStatusBadge,
	NodeStatusBadge,
	ScheduleStatusBadge,
	SessionStatusBadge,
	StatusBadge,
	StatusDot,
	TaskStatusBadge,
	TokenStatusBadge,
} from "./status-badge";

describe("StatusBadge", () => {
	test("renders a tone and a translated label", () => {
		const { container } = render(
			<StatusBadge tone="ok">
				<span>value</span>
			</StatusBadge>,
		);
		expect(container.querySelector('[data-tone="ok"]')).not.toBeNull();
		expect(screen.getByText("value")).toBeInTheDocument();
	});

	test("StatusDot is announced through its label", () => {
		const { container } = render(<StatusDot tone="warn" label="Warning" />);
		expect(screen.getByRole("img", { name: "Warning" })).toBeInTheDocument();
		expect(container.querySelector('[data-tone="warn"]')).not.toBeNull();
	});
});

describe("status family mappings", () => {
	test("nodes", () => {
		const { rerender } = renderWithI18n(<NodeStatusBadge status="active" />);
		expect(screen.getByText("Active")).toBeInTheDocument();
		rerender(<NodeStatusBadge status="pending" />);
		expect(screen.getByText("Pending")).toBeInTheDocument();
		rerender(<NodeStatusBadge status="disabled" />);
		expect(screen.getByText("Disabled")).toBeInTheDocument();
	});

	test("tasks", () => {
		const { rerender } = renderWithI18n(<TaskStatusBadge state="exited" exitCode={0} />);
		expect(screen.getByText("Exited")).toBeInTheDocument();
		rerender(<TaskStatusBadge state="awaiting_approval" />);
		expect(screen.getByText("Awaiting approval")).toBeInTheDocument();
		rerender(<TaskStatusBadge state="failed" />);
		expect(screen.getByText("Failed")).toBeInTheDocument();
		rerender(<TaskStatusBadge state="waiting_elsewhere" />);
		expect(screen.getByText("waiting_elsewhere")).toBeInTheDocument();
	});

	test("sessions show the contract's states and keep an unknown one raw", () => {
		const { rerender } = renderWithI18n(<SessionStatusBadge state="idle" />);
		expect(screen.getByText("Idle")).toBeInTheDocument();
		rerender(<SessionStatusBadge state="running" />);
		expect(screen.getByText("Running")).toBeInTheDocument();
		rerender(<SessionStatusBadge state="awaiting" />);
		expect(screen.getByText("Awaiting")).toBeInTheDocument();
		// An unknown value is not flattened to "Unknown" (the WU2a audit fix).
		rerender(<SessionStatusBadge state="hibernating" />);
		expect(screen.getByText("hibernating")).toBeInTheDocument();
		expect(screen.queryByText("Unknown")).not.toBeInTheDocument();
	});

	test("authorizations, schedules and tokens", () => {
		const { rerender } = renderWithI18n(<AuthorizationStatusBadge status="revoked" />);
		expect(screen.getByText("Revoked")).toBeInTheDocument();
		rerender(<ScheduleStatusBadge status="succeeded" />);
		expect(screen.getByText("Succeeded")).toBeInTheDocument();
		rerender(<TokenStatusBadge status="expired" />);
		expect(screen.getByText("Expired")).toBeInTheDocument();
	});

	test("labels are translated into zh-CN", () => {
		renderWithI18n(<TaskStatusBadge state="awaiting_authorization" />, "zh-CN");
		expect(screen.getByText("等待授权")).toBeInTheDocument();
	});
});
