import { describe, expect, test } from "vitest";
import { renderWithI18n } from "@/test/render";
import { ReviewSummary, ReviewView } from "./evaluation";

const pending = { status: "pending", startedAt: "2026-01-01T00:00:00.000Z" } as const;

describe("a pending Auto Review marker", () => {
	test("renders no verdict and no compact summary", () => {
		const { container } = renderWithI18n(
			<>
				<ReviewView review={pending} />
				<ReviewSummary review={pending} />
			</>,
		);
		expect(container).toBeEmptyDOMElement();
	});
});
