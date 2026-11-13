import { HouseIcon } from "lucide-react";
import { Fragment, type ReactNode } from "react";
import {
	Breadcrumb,
	BreadcrumbItem,
	BreadcrumbLink,
	BreadcrumbList,
	BreadcrumbPage,
	BreadcrumbSeparator,
} from "@/components/ui/breadcrumb";
import { pathSegments } from "./types";

export interface FileToolbarProps {
	/** The directory prefix on display; the root is "". */
	path: string;
	onPathChange: (path: string) => void;
	/** The accessible name of the root crumb, e.g. a library's label. */
	rootLabel: string;
	/** Controls on the right of the row, e.g. a usage indicator and the upload button. */
	actions?: ReactNode;
}

/**
 * The file browser's top row (doc/design/webui.md "Shared components"): a home icon for the source's root and
 * the path's breadcrumb on the left, the caller's actions on the right. The library and node file
 * pages share it with the FileList.
 */
export function FileToolbar({ path, onPathChange, rootLabel, actions }: FileToolbarProps) {
	const segments = pathSegments(path);
	return (
		<div className="flex flex-wrap items-center justify-between gap-2">
			<Breadcrumb>
				<BreadcrumbList>
					<BreadcrumbItem>
						{path === "" ? (
							<BreadcrumbPage aria-label={rootLabel} className="flex items-center">
								<HouseIcon className="size-4" aria-hidden="true" />
							</BreadcrumbPage>
						) : (
							<BreadcrumbLink
								aria-label={rootLabel}
								render={
									<button type="button" className="flex cursor-pointer items-center" onClick={() => onPathChange("")} />
								}
							>
								<HouseIcon className="size-4" aria-hidden="true" />
							</BreadcrumbLink>
						)}
					</BreadcrumbItem>
					{segments.map((segment, index) => {
						const target = segments.slice(0, index + 1).join("/");
						return (
							<Fragment key={target}>
								<BreadcrumbSeparator />
								<BreadcrumbItem>
									{target === path ? (
										<BreadcrumbPage>{segment}</BreadcrumbPage>
									) : (
										<BreadcrumbLink
											render={<button type="button" className="cursor-pointer" onClick={() => onPathChange(target)} />}
										>
											{segment}
										</BreadcrumbLink>
									)}
								</BreadcrumbItem>
							</Fragment>
						);
					})}
				</BreadcrumbList>
			</Breadcrumb>
			{actions !== undefined && <div className="flex min-w-0 flex-wrap items-center gap-2">{actions}</div>}
		</div>
	);
}
