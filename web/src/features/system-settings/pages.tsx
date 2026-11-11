import { Trans, useLingui } from "@lingui/react/macro";
import { ErrorState } from "@/components/error-state";
import { Page } from "@/components/page";
import { PageHeader } from "@/components/page-header";
import { PageSkeleton } from "@/components/skeletons";
import { useSystemSettings } from "./api";
import { GeneralSection } from "./general-section";
import { PasskeysSection } from "./passkeys-section";
import { RetentionSection } from "./retention-section";
import { SignInSection } from "./sign-in-section";
import { SigningKeysSection } from "./signing-keys-section";

/**
 * System settings (administrators only, doc/design/webui.md "System settings page"): the
 * low-frequency runtime settings and crhs's authorization signing keys. Each
 * section saves only its own values and applies without a restart.
 */
export function SystemSettingsPage() {
	const { t } = useLingui();
	const settings = useSystemSettings();

	if (settings.isError) {
		return (
			<Page width="detail" data-testid="system-settings-page">
				<PageHeader title={<Trans>System settings</Trans>} />
				<ErrorState error={settings.error} retry={() => void settings.refetch()} />
			</Page>
		);
	}
	if (!settings.data) {
		return (
			<Page width="detail" data-testid="system-settings-page">
				<PageSkeleton />
			</Page>
		);
	}

	return (
		<Page width="detail" data-testid="system-settings-page">
			<PageHeader
				title={<Trans>System settings</Trans>}
				description={t`Runtime settings for this crhs. A save applies without a restart and is recorded in the audit log.`}
			/>
			<GeneralSection settings={settings.data.settings} defaults={settings.data.defaults} />
			<SignInSection settings={settings.data.settings} defaults={settings.data.defaults} />
			<PasskeysSection settings={settings.data.settings} defaults={settings.data.defaults} />
			<RetentionSection settings={settings.data.settings} defaults={settings.data.defaults} />
			<SigningKeysSection />
		</Page>
	);
}
