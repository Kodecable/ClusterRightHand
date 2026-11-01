// biome-ignore-all lint/suspicious/noArrayIndexKey: skeletons are static placeholders; their order never changes.
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";

/** The loading state of a whole page: a title bar and a few rows. */
export function PageSkeleton({ rows = 5, className }: { rows?: number; className?: string }) {
	return (
		<div data-slot="page-skeleton" className={cn("space-y-4", className)} aria-busy="true">
			<div className="space-y-2">
				<Skeleton className="h-6 w-48" />
				<Skeleton className="h-4 w-72" />
			</div>
			<div className="space-y-2">
				{Array.from({ length: rows }, (_, index) => (
					<Skeleton key={index} className="h-10 w-full" />
				))}
			</div>
		</div>
	);
}

/** Placeholder rows for a list or a table body. */
export function ListSkeleton({ rows = 6, className }: { rows?: number; className?: string }) {
	return (
		<div data-slot="list-skeleton" className={cn("space-y-2", className)} aria-busy="true">
			{Array.from({ length: rows }, (_, index) => (
				<Skeleton key={index} className="h-12 w-full" />
			))}
		</div>
	);
}

export function CardSkeleton({ className }: { className?: string }) {
	return (
		<div data-slot="card-skeleton" className={cn("space-y-2 rounded-lg border p-4", className)} aria-busy="true">
			<Skeleton className="h-5 w-40" />
			<Skeleton className="h-4 w-full" />
			<Skeleton className="h-4 w-3/4" />
		</div>
	);
}
