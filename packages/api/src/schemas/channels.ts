/**
 * Runtime schemas for chat channels (doc/design/channels.md). A channel's credentials are write-only; the
 * administrator's view says only whether they are set.
 */
import { z } from "zod";

/** The chat platforms crhs can talk to; Satori is the later kind. */
export const ChannelKindSchema = z.enum(["telegram", "satori"]);

/** What a channel's connection is doing (the admin page's state). */
export const ChannelStateSchema = z.enum(["disabled", "connecting", "connected", "unavailable"]);

export const ChannelStatusSchema = z
	.object({
		state: ChannelStateSchema,
		lastError: z.string().nullable().describe("Why the last connection attempt failed; null when it succeeded."),
		nextAttemptAt: z.string().nullable().describe("When the next automatic attempt happens while unavailable."),
		account: z.string().nullable().describe("The bot's username or another platform label, once connected."),
	})
	.meta({ id: "ChannelStatus" });

/** A channel as administrators see it; the bot token is never returned. */
export const ChannelViewSchema = z
	.object({
		id: z.string(),
		name: z.string(),
		kind: ChannelKindSchema,
		enabled: z.boolean(),
		hasCredentials: z.boolean().describe("Whether credentials are stored; their values are never returned."),
		status: ChannelStatusSchema,
		createdAt: z.string(),
		updatedAt: z.string(),
	})
	.meta({ id: "ChannelView" });

/** A channel as a user's link instructions see it. */
export const ChannelPublicViewSchema = z
	.object({
		id: z.string(),
		name: z.string(),
		kind: ChannelKindSchema,
		account: z.string().nullable().describe("The bot's username, when the channel is connected."),
	})
	.meta({ id: "ChannelPublicView" });

/** `PUT /api/channels/{name}`; omitted fields keep their value. */
export const ChannelInputSchema = z.object({
	kind: ChannelKindSchema.optional(),
	enabled: z.boolean().optional(),
	token: z.string().nullable().optional().describe("Telegram bot token; write-only and encrypted with the master key."),
});

export const ChannelNameParamSchema = z.object({ name: z.string() });

export const ChannelListResponseSchema = z.object({ channels: z.array(ChannelViewSchema) });

export const ChannelResponseSchema = z.object({ channel: ChannelViewSchema });

/** One linked platform account as its owner sees it. */
export const ChannelAccountViewSchema = z
	.object({
		id: z.string(),
		channelId: z.string(),
		channelName: z.string(),
		platform: z.string(),
		platformUserId: z.string(),
		displayName: z.string().nullable(),
		linkedAt: z.string(),
		isDefault: z.boolean().describe("Whether notifications go to this account when the WebUI is not open."),
	})
	.meta({ id: "ChannelAccountView" });

/** `GET /api/channel-accounts`: the caller's accounts and the channels they may link on. */
export const ChannelAccountListResponseSchema = z.object({
	accounts: z.array(ChannelAccountViewSchema),
	channels: z.array(ChannelPublicViewSchema),
});

/** `POST /api/channel-link-codes`: for which channel the instructions are; the code itself works on any. */
export const ChannelLinkCodeBodySchema = z.object({
	channelId: z.string().optional(),
});

export const ChannelLinkCodeResponseSchema = z
	.object({
		code: z.string().describe("The one-time code to send with /link; valid for 10 minutes and single use."),
		expiresAt: z.string(),
		channel: ChannelPublicViewSchema.optional(),
	})
	.meta({ id: "ChannelLinkCodeResponse" });

/** Path parameter of `DELETE /api/channel-accounts/{id}`. */
export const ChannelAccountParamSchema = z.object({ id: z.string() });
