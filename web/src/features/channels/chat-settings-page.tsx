import { Trans } from "@lingui/react/macro";
import { Page } from "@/components/page";
import { PageHeader } from "@/components/page-header";
import { ChatAccountsSection } from "./chat-accounts-section";

/** The user's own chat settings (doc/design/channels.md "Accounts"): linked accounts and notification defaults. */
export function ChatSettingsPage() {
	return (
		<Page width="detail" data-testid="chat-settings-page">
			<PageHeader title={<Trans>Chat accounts</Trans>} />
			<ChatAccountsSection />
		</Page>
	);
}
