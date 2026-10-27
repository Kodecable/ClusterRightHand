import { useState } from "react";
import { useAction } from "../hooks.ts";
import { ErrorText } from "./Feedback.tsx";

/** A "Test connection" button that shows whether `test` succeeded. */
export function TestConnection({ test }: { test: () => Promise<unknown> }) {
	const [ok, setOk] = useState(false);
	const { busy, error, run } = useAction();
	const go = async () => {
		setOk(false);
		const done = await run(async () => {
			await test();
			return true;
		});
		if (done) setOk(true);
	};
	return (
		<div className="row wrap">
			<button type="button" onClick={go} disabled={busy}>
				{busy ? "Testing…" : "Test connection"}
			</button>
			{ok && (
				<span className="badge badge-ok" role="status">
					connection works
				</span>
			)}
			<ErrorText error={error} />
		</div>
	);
}
