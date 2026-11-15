/**
 * Chat channels (doc/design/channels.md): administrators connect a bot; users link a chat account and
 * choose the account notifications fall back to in their own settings.
 */

import type { z } from "zod";
import type {
	ChannelAccountListResponseSchema,
	ChannelAccountViewSchema,
	ChannelConfigSchema,
	ChannelInputSchema,
	ChannelKindSchema,
	ChannelLinkCodeResponseSchema,
	ChannelListResponseSchema,
	ChannelLoginSchema,
	ChannelPublicViewSchema,
	ChannelResponseSchema,
	ChannelStateSchema,
	ChannelStatusSchema,
	ChannelViewSchema,
} from "./schemas/channels.ts";

export type ChannelKind = z.infer<typeof ChannelKindSchema>;

export type ChannelState = z.infer<typeof ChannelStateSchema>;

export type ChannelLogin = z.infer<typeof ChannelLoginSchema>;

export type ChannelStatus = z.infer<typeof ChannelStatusSchema>;

/** The non-secret settings of a Satori channel. */
export type ChannelConfig = z.infer<typeof ChannelConfigSchema>;

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
