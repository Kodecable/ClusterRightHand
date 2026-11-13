import type { LibraryView } from "@crh/api";
import { msg } from "@lingui/core/macro";
import { Trans, useLingui } from "@lingui/react/macro";
import { useNavigate, useParams, useSearch } from "@tanstack/react-router";
import { ChevronsUpDownIcon } from "lucide-react";
import { EntityPicker } from "@/components/entity-picker";
import { ErrorState } from "@/components/error-state";
import { FileManager } from "@/components/file-manager";
import { Page } from "@/components/page";
import { PageHeader } from "@/components/page-header";
import { PageSkeleton } from "@/components/skeletons";
import { isNotFound } from "@/lib/api/client";
import { useAuth } from "@/lib/session";
import { useLibrary, useLibraryFileSource } from "./api";
import { LibraryUsageIndicator } from "./usage-indicator";

interface LibrarySearch {
	path?: string;
}

/** A library's label: its owner's display name and the kind, never the username. */
function libraryLabel(library: LibraryView, i18n: ReturnType<typeof useLingui>["i18n"]): string {
	const name = library.ownerDisplayName || library.ownerName;
	return library.ownerKind === "user"
		? i18n._(msg`User {name}'s library`.id, { name })
		: i18n._(msg`Group {name}'s library`.id, { name });
}

/**
 * One library at `/library/$library?path=…` (doc/design/webui.md "Library page"): the shared file
 * manager over the library, one control for the user's own and their groups' libraries (any user or
 * group for an administrator), and the usage against the limits in the toolbar.
 */
export function LibraryPage() {
	const { t, i18n } = useLingui();
	const params = useParams({ strict: false }) as { library?: string };
	const ref = params.library ?? "";
	const search = useSearch({ strict: false }) as LibrarySearch;
	const path = typeof search.path === "string" ? search.path : "";
	const navigate = useNavigate();
	const admin = useAuth().user?.kind === "admin";
	const library = useLibrary(ref);
	const source = useLibraryFileSource(ref);

	const open = (next: string, nextPath = "") => {
		void navigate({
			to: "/library/$library",
			params: { library: next },
			search: nextPath === "" ? {} : { path: nextPath },
		});
	};

	if (library.isError) {
		return (
			<Page data-testid="library-page">
				<PageHeader title={<Trans>Library</Trans>} />
				{isNotFound(library.error) ? (
					<ErrorState error={t`This library doesn't exist or you don't have access.`} />
				) : (
					<ErrorState error={library.error} retry={() => void library.refetch()} />
				)}
			</Page>
		);
	}
	if (!library.data) {
		return (
			<Page data-testid="library-page">
				<PageSkeleton />
			</Page>
		);
	}

	const current = library.data;
	const label = libraryLabel(current, i18n);

	return (
		<Page data-testid="library-page">
			<PageHeader
				title={<Trans>Library</Trans>}
				actions={
					<EntityPicker
						kind={admin ? "libraryOwner" : "library"}
						label={t`Library`}
						value={current.ref}
						onChange={(next) => {
							if (next !== null) open(next);
						}}
						trigger={
							<>
								<span className="min-w-0 flex-1 truncate text-left">{label}</span>
								<ChevronsUpDownIcon className="pointer-events-none size-4 shrink-0 text-muted-foreground" />
							</>
						}
						className="w-64"
						testId="library-selector"
					/>
				}
			/>

			<FileManager
				source={source}
				path={path}
				onPathChange={(next) => open(ref, next)}
				rootLabel={label}
				toolbarActions={<LibraryUsageIndicator usage={current.usage} limits={current.limits} />}
			/>
		</Page>
	);
}
