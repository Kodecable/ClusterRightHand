import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, test } from "vitest";
import { ByteSizeInput } from "./byte-size-input";

function Harness({ initial = 32 * 1024 ** 2 }: { initial?: number }) {
	const [value, setValue] = useState(initial);
	return (
		<>
			<label htmlFor="size">Size</label>
			<ByteSizeInput id="size" value={value} onChange={setValue} />
			<output data-testid="value">{Number.isNaN(value) ? "invalid" : String(value)}</output>
			<button type="button" onClick={() => setValue(5 * 1024 ** 3)}>
				Reset
			</button>
		</>
	);
}

describe("ByteSizeInput", () => {
	test("shows the initial value formatted and keeps typed text until blur", async () => {
		render(<Harness />);
		const input = screen.getByLabelText("Size");
		expect(input).toHaveValue("32 MiB");

		await userEvent.clear(input);
		await userEvent.type(input, "1M");
		expect(input).toHaveValue("1M");
		expect(screen.getByTestId("value")).toHaveTextContent("1048576");

		await userEvent.tab();
		expect(input).toHaveValue("1 MiB");
	});

	test("leaves an unparseable value invalid", async () => {
		render(<Harness />);
		const input = screen.getByLabelText("Size");

		await userEvent.clear(input);
		await userEvent.type(input, "nope");
		await userEvent.tab();

		expect(input).toHaveValue("nope");
		expect(screen.getByTestId("value")).toHaveTextContent("invalid");
	});

	test("shows a value set outside the input formatted", async () => {
		render(<Harness />);
		const input = screen.getByLabelText("Size");

		await userEvent.click(screen.getByRole("button", { name: "Reset" }));
		expect(input).toHaveValue("5 GiB");
	});
});
