import type { AvailableModel } from "@crh/api";
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, test } from "vitest";
import { renderWithRouter } from "@/test/render";
import { ModelSelect } from "./model-select";

const MODEL: AvailableModel = {
	provider: "faux",
	providerName: "Faux Provider",
	modelId: "faux-1",
	name: "Faux One",
	contextWindow: 128_000,
	thinkingLevels: ["off"],
	input: ["text"],
};

describe("ModelSelect", () => {
	test("groups models under the provider's display name, not its raw id", async () => {
		await renderWithRouter(
			<ModelSelect models={[MODEL]} value={{ provider: MODEL.provider, modelId: MODEL.modelId }} onChange={() => {}} />,
		);
		const user = userEvent.setup();
		await user.click(screen.getByRole("combobox", { name: "Model" }));
		expect(await screen.findByText("Faux Provider")).toBeInTheDocument();
		expect(screen.queryByText("faux")).not.toBeInTheDocument();
	});
});
