import { useLingui } from "@lingui/react/macro";
import { toast } from "sonner";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import type { User, UserKind } from "@/lib/api/types";
import { useUpdateUser } from "./api";

/** The inline administrator/member switch of a user row; your own kind cannot change. */
export function KindSelect({ user, self }: { user: User; self: boolean }) {
	const { t } = useLingui();
	const update = useUpdateUser();
	return (
		<span className="inline-flex" title={self ? t`You cannot change your own kind.` : undefined}>
			<Select
				value={user.kind}
				disabled={update.isPending || self}
				onValueChange={(next) =>
					update.mutate(
						{ id: user.id, patch: { kind: next as UserKind } },
						{ onSuccess: () => toast.success(t`User updated.`) },
					)
				}
			>
				<SelectTrigger aria-label={t`Kind of ${user.username}`} className="h-7 w-40">
					<SelectValue>{(current: string | null) => (current === "admin" ? t`Administrator` : t`Member`)}</SelectValue>
				</SelectTrigger>
				<SelectContent>
					<SelectItem value="member">{t`Member`}</SelectItem>
					<SelectItem value="admin">{t`Administrator`}</SelectItem>
				</SelectContent>
			</Select>
		</span>
	);
}
