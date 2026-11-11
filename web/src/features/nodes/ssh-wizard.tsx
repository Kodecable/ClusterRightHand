import type { PublicNode } from "@crh/api";
import type { MessageDescriptor } from "@lingui/core";
import { msg } from "@lingui/core/macro";
import { Trans, useLingui } from "@lingui/react/macro";
import { useState } from "react";
import { ErrorText } from "@/components/error-state";
import { FormActions } from "@/components/form";
import { KeyValueList } from "@/components/key-value";
import { TestConnection } from "@/components/test-connection";
import { Button } from "@/components/ui/button";
import { useCreateSshNode, useTestSshRoute } from "@/features/nodes/api";
import { hopErrorText, SshRouteEditor } from "./ssh-route-editor";
import { emptyHop, firstUnpinned, type Hop, hopBodies, validateHops } from "./sshHops";

/** The wizard's two steps, in order (doc/guide/webui.md "Adding an SSH node"). */
export const SSH_STEP_LABELS: readonly MessageDescriptor[] = [msg`Route`, msg`Create`];

/** Wizard step 2: the summary, the route test and (in the footer) creation. */
function CreateStep({ hops, name }: { hops: Hop[]; name: string }) {
	const { t } = useLingui();
	const test = useTestSshRoute();
	const target = hops[hops.length - 1] as Hop;
	return (
		<div className="grid gap-3" data-testid="ssh-step-create">
			<KeyValueList
				items={[
					{ label: t`Node name`, value: name.trim() || target.host },
					{
						label: t`Route`,
						value: hops.map((hop) => `${hop.user}@${hop.host}:${hop.port}`).join(" → "),
						mono: true,
					},
				]}
			/>
			<p className="text-sm text-muted-foreground">
				<Trans>
					The node is active as soon as it is created; every hop is checked against its pinned host fingerprint on each
					connection. Test first to check that each hop's credential is installed and the account can run commands.
				</Trans>
			</p>
			<TestConnection testId="ssh-route-test" onTest={() => test.mutateAsync(hopBodies(hops))} />
		</div>
	);
}

/** The last step's submit; a separate component so the creation mutation is only mounted there. */
function WizardCreate({ hops, name, onCreated }: { hops: Hop[]; name: string; onCreated: (node: PublicNode) => void }) {
	const create = useCreateSshNode();
	return (
		<Button
			type="button"
			disabled={create.isPending}
			data-testid="ssh-create"
			onClick={() => {
				create.mutate(
					{
						...hopBodies(hops),
						name: name.trim(),
					},
					{
						onSuccess: (node) => {
							onCreated(node);
						},
					},
				);
			}}
		>
			<Trans>New node</Trans>
		</Button>
	);
}

/**
 * The two-step "New SSH node" wizard: the name and the route table (jump hosts and the target, each with
 * its own credential and pinned host fingerprint), then the connection test and creation.
 */
export function SshNodeWizard({
	onCancel,
	onCreated,
}: {
	onCancel: () => void;
	onCreated: (node: PublicNode) => void;
}) {
	const { t, i18n } = useLingui();
	const [step, setStep] = useState(0);
	const [hops, setHopList] = useState<Hop[]>([emptyHop()]);
	const [name, setName] = useState("");
	const [stepError, setStepError] = useState<string>();

	const setHops = (next: Hop[]) => {
		setStepError(undefined);
		setHopList(next);
	};

	const go = (to: number) => {
		setStepError(undefined);
		if (to > step) {
			const bad = validateHops(hops);
			if (bad) {
				setStepError(hopErrorText(i18n, hops, bad));
				return;
			}
			if (firstUnpinned(hops) >= 0) {
				setStepError(t`Confirm every host fingerprint first.`);
				return;
			}
		}
		setStep(to);
	};

	return (
		<div className="grid gap-4" data-testid="ssh-wizard">
			<ol className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground" aria-label={t`Steps`}>
				{SSH_STEP_LABELS.map((label, index) => (
					<li
						key={label.id}
						aria-current={index === step ? "step" : undefined}
						className={index === step ? "font-medium text-foreground" : undefined}
					>
						{index + 1}. {i18n._(label)}
					</li>
				))}
			</ol>

			{step === 0 && (
				<div data-testid="ssh-step-route">
					<SshRouteEditor hops={hops} onHops={setHops} name={name} onName={setName} />
				</div>
			)}
			{step === 1 && <CreateStep hops={hops} name={name} />}

			{/* The row keeps its height between steps; only a real message is an alert. */}
			<div className="min-h-5">
				<ErrorText error={stepError} />
			</div>

			<FormActions>
				{step > 0 && (
					<Button type="button" variant="outline" onClick={() => go(step - 1)}>
						<Trans>Back</Trans>
					</Button>
				)}
				<Button type="button" variant="outline" onClick={onCancel}>
					<Trans>Cancel</Trans>
				</Button>
				{step < SSH_STEP_LABELS.length - 1 ? (
					<Button type="button" onClick={() => go(step + 1)} data-testid="ssh-next">
						<Trans>Next</Trans>
					</Button>
				) : (
					<WizardCreate hops={hops} name={name} onCreated={onCreated} />
				)}
			</FormActions>
		</div>
	);
}
