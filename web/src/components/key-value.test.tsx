import { describe, expect, test } from "vitest";
import { renderWithI18n } from "@/test/render";
import { KeyValueList } from "./key-value";

function pair(container: HTMLElement): { label: Element; value: Element } {
	const label = container.querySelector("dt");
	const value = container.querySelector("dd");
	if (label === null || value === null) throw new Error("no label/value pair");
	return { label, value };
}

describe("KeyValueList", () => {
	test("labels and values share one line box", () => {
		const { container } = renderWithI18n(<KeyValueList items={[{ label: "Id", value: "task-1", mono: true }]} />);
		const list = container.querySelector('[data-slot="key-value"]');
		expect(list).toHaveClass("items-start");
		const { label, value } = pair(container);
		expect(label).toHaveClass("text-muted-foreground");
		expect(label).not.toHaveClass("self-center");
		// A mono value keeps the text-sm line box, so it does not sit higher.
		expect(value).toHaveClass("font-mono", "text-xs", "leading-5");
	});

	test("a control value centers its label against the control", () => {
		const { container } = renderWithI18n(
			<KeyValueList
				items={[
					{
						label: "Role",
						value: (
							<select aria-label="Role">
								<option>Member</option>
							</select>
						),
						control: true,
					},
				]}
			/>,
		);
		const { label, value } = pair(container);
		expect(label).toHaveClass("self-center");
		expect(value).toHaveClass("self-center");
	});
});
