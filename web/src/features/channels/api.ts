import type { ChannelAccountListResponse, ChannelInput, ChannelLinkCodeResponse, ChannelView } from "@crh/api";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { userSettingsKey } from "@/hooks/use-user-settings";
import { enc, http } from "@/lib/api/client";

export const channelKeys = {
	all: ["channels"] as const,
	list: () => ["channels", "list"] as const,
	accounts: () => ["channels", "accounts"] as const,
};

/** The administrator's channels (doc/design/channels.md "Channels"). */
export function useChannels() {
	return useQuery({
		queryKey: channelKeys.list(),
		queryFn: ({ signal }) => http.get<{ channels: ChannelView[] }>("/channels", { signal }).then((r) => r.channels),
		// The connection state and next attempt change in the background.
		refetchInterval: 5_000,
	});
}

export function useSaveChannel() {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: ({ name, body }: { name: string; body: ChannelInput }) =>
			http.put<{ channel: ChannelView }>(`/channels/${enc(name)}`, body).then((r) => r.channel),
		onSuccess: () => void queryClient.invalidateQueries({ queryKey: channelKeys.all }),
	});
}

export function useDeleteChannel() {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: (name: string) => http.del<{ ok: true }>(`/channels/${enc(name)}`),
		onSuccess: () => void queryClient.invalidateQueries({ queryKey: channelKeys.all }),
	});
}

/** The caller's linked chat accounts and the channels they may link on. */
export function useChannelAccounts() {
	return useQuery({
		queryKey: channelKeys.accounts(),
		queryFn: ({ signal }) => http.get<ChannelAccountListResponse>("/channel-accounts", { signal }),
	});
}

export function useCreateLinkCode() {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: (channelId?: string) =>
			http.post<ChannelLinkCodeResponse>("/channel-link-codes", channelId === undefined ? {} : { channelId }),
		onSuccess: () => void queryClient.invalidateQueries({ queryKey: channelKeys.accounts() }),
	});
}

export function useUnlinkAccount() {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: (id: string) => http.del<{ ok: true }>(`/channel-accounts/${enc(id)}`),
		onSuccess: () => {
			void queryClient.invalidateQueries({ queryKey: channelKeys.accounts() });
			// Unlinking the account notifications fell back to also clears that default on the server.
			void queryClient.invalidateQueries({ queryKey: userSettingsKey });
		},
	});
}
