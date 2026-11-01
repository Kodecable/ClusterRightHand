import { Trans, useLingui } from "@lingui/react/macro";
import { useMutation } from "@tanstack/react-query";
import { CheckCircle2Icon } from "lucide-react";
import { ErrorText } from "@/components/error-state";
import { Spinner } from "@/components/spinner";
import { Button } from "@/components/ui/button";

/**
 * A "Test connection" button: it runs the caller's probe and reports success
 * inline. Failures show the server's message verbatim (server messages are not
 * translated), like every other mutation.
 */
export function TestConnection({
	onTest,
	label,
	testId,
}: {
	onTest: () => Promise<unknown>;
	label?: string;
	testId?: string;
}) {
	const { t } = useLingui();
	const test = useMutation({ mutationFn: onTest, meta: { toast: false } });
	return (
		<div className="flex flex-wrap items-center gap-2" data-testid={testId}>
			<Button type="button" variant="outline" size="sm" disabled={test.isPending} onClick={() => test.mutate()}>
				{test.isPending && <Spinner className="size-3.5" decorative />}
				{label ?? t`Test connection`}
			</Button>
			{test.isSuccess && (
				<span role="status" className="inline-flex items-center gap-1 text-sm text-ok">
					<CheckCircle2Icon className="size-4" aria-hidden="true" />
					<Trans>Connection works.</Trans>
				</span>
			)}
			{test.error !== null && <ErrorText error={test.error} />}
		</div>
	);
}
