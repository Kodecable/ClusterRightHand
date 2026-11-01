import { Trans, useLingui } from "@lingui/react/macro";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { modelKey, parseModelKey } from "@/components/model-select";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import type { ModelRef } from "@/lib/api/types";
import { useModels, useReviewModel, useSetReviewModel } from "./api";

const NONE = "__session__";

/** The model Auto Review sends undecided approvals to; "each session's own model" is the default. */
export function ReviewModelCard() {
	const { t } = useLingui();
	const models = useModels();
	const review = useReviewModel();
	const save = useSetReviewModel();
	const [value, setValue] = useState<string>(NONE);

	useEffect(() => {
		if (review.data === undefined) return;
		setValue(review.data === null ? NONE : modelKey(review.data));
	}, [review.data]);

	return (
		<section
			className="grid gap-2 rounded-lg border p-4"
			aria-labelledby="review-model-heading"
			data-testid="review-model"
		>
			<h2 id="review-model-heading" className="text-sm font-semibold">
				<Trans>Review model</Trans>
			</h2>
			<p className="text-sm text-muted-foreground">
				<Trans>
					Auto Review sends approvals it cannot decide to this model. Without one, each session's own model is used.
				</Trans>
			</p>
			<div className="flex flex-wrap items-end gap-2">
				<div className="grid min-w-64 gap-1.5">
					<Label htmlFor="review-model-select">{t`Model`}</Label>
					<Select value={value} onValueChange={(next) => setValue(String(next))}>
						<SelectTrigger id="review-model-select" className="w-full">
							<SelectValue>
								{(current: string | null) => {
									if (current === null || current === NONE) return t`Each session's own model`;
									const model = models.data?.find((candidate) => modelKey(candidate) === current);
									return model?.name ?? current;
								}}
							</SelectValue>
						</SelectTrigger>
						<SelectContent>
							<SelectItem value={NONE}>{t`Each session's own model`}</SelectItem>
							{(models.data ?? []).map((model) => (
								<SelectItem key={modelKey(model)} value={modelKey(model)}>
									{model.name}
								</SelectItem>
							))}
						</SelectContent>
					</Select>
				</div>
				<Button
					type="button"
					variant="outline"
					disabled={save.isPending || review.data === undefined}
					onClick={() => {
						const model: ModelRef | null = value === NONE ? null : parseModelKey(value);
						save.mutate(model, { onSuccess: () => toast.success(t`Review model saved.`) });
					}}
				>
					<Trans>Save</Trans>
				</Button>
			</div>
			{save.error !== null && (
				<p role="alert" className="text-sm text-danger">
					{save.error.message}
				</p>
			)}
		</section>
	);
}
