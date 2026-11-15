/**
 * Chat channels (doc/design/channels.md): administrators connect a bot; users link a chat account, choose the
 * account notifications fall back to and toggle progress.
 */

import type { z } from "zod";
import type {
	ChannelAccountListResponseSchema,
	ChannelAccountViewSchema,
	ChannelInputSchema,
	ChannelKindSchema,
	ChannelLinkCodeResponseSchema,
	ChannelListResponseSchema,
	ChannelPublicViewSchema,
	ChannelResponseSchema,
	ChannelSettingsSchema,
	ChannelSettingsUpdateSchema,
	ChannelStateSchema,
	ChannelStatusSchema,
	ChannelViewSchema,
} from "./schemas/channels.ts";

export type ChannelKind = z.infer<typeof ChannelKindSchema>;

export type ChannelState = z.infer<typeof ChannelStateSchema>;

export type ChannelStatus = z.infer<typeof ChannelStatusSchema>;

/** A channel as administrators see it; credentials are never returned. */
export type ChannelView = z.infer<typeof ChannelViewSchema>;

/** A channel as a user's link instructions see it. */
export type ChannelPublicView = z.infer<typeof ChannelPublicViewSchema>;

/** Body of `PUT /api/channels/{name}`; omitted fields keep their value. */
export type ChannelInput = z.infer<typeof ChannelInputSchema>;

export type ChannelListResponse = z.infer<typeof ChannelListResponseSchema>;

export type ChannelResponse = z.infer<typeof ChannelResponseSchema>;

export type ChannelAccountView = z.infer<typeof ChannelAccountViewSchema>;

export type ChannelAccountListResponse = z.infer<typeof ChannelAccountListResponseSchema>;

export type ChannelLinkCodeResponse = z.infer<typeof ChannelLinkCodeResponseSchema>;

export type ChannelSettings = z.infer<typeof ChannelSettingsSchema>;

export type ChannelSettingsUpdate = z.infer<typeof ChannelSettingsUpdateSchema>;
