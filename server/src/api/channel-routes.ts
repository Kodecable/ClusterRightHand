import type { ChannelInput, ChannelPublicView } from "@crh/api";
import {
	ChannelAccountListResponseSchema,
	ChannelAccountParamSchema,
	ChannelInputSchema,
	ChannelLinkCodeBodySchema,
	ChannelLinkCodeResponseSchema,
	ChannelListResponseSchema,
	ChannelNameParamSchema,
	ChannelResponseSchema,
	ChannelSettingsResponseSchema,
	ChannelSettingsUpdateSchema,
	OkResponseSchema,
} from "@crh/api/schemas";
import type { Audit } from "../audit/audit.ts";
import { userActor } from "../audit/audit.ts";
import type { ChannelManager } from "../channels/manager.ts";
import { channelPublicView, getChannelById } from "../channels/store.ts";
import type { Db } from "../storage/db.ts";
import { UserError } from "../util/errors.ts";
import { requireAdmin } from "./middleware.ts";
import { apiRouter, defineRoute, json } from "./openapi.ts";

const TAGS = ["Channels"];

const listRoute = defineRoute({
	method: "get",
	path: "/channels",
	tags: TAGS,
	summary: "List the chat channels with their connection state (administrators)",
	agent: "deny",
	middleware: [requireAdmin],
	responses: { 200: { description: "The channels", ...json(ChannelListResponseSchema) } },
});

const saveRoute = defineRoute({
	method: "put",
	path: "/channels/{name}",
	tags: TAGS,
	summary: "Create or update a chat channel; the bot token is write-only (administrators)",
	agent: "deny",
	middleware: [requireAdmin],
	request: { params: ChannelNameParamSchema, body: { required: true, ...json(ChannelInputSchema) } },
	responses: { 200: { description: "The saved channel", ...json(ChannelResponseSchema) } },
});

const deleteRoute = defineRoute({
	method: "delete",
	path: "/channels/{name}",
	tags: TAGS,
	summary: "Delete a chat channel, its linked accounts and threads (administrators)",
	agent: "deny",
	middleware: [requireAdmin],
	request: { params: ChannelNameParamSchema },
	responses: { 200: { description: "Deleted", ...json(OkResponseSchema) } },
});

const accountsRoute = defineRoute({
	method: "get",
	path: "/channel-accounts",
	tags: TAGS,
	summary: "The caller's linked chat accounts and the channels they may link on",
	agent: "allow",
	responses: { 200: { description: "The accounts and channels", ...json(ChannelAccountListResponseSchema) } },
});

const linkCodeRoute = defineRoute({
	method: "post",
	path: "/channel-link-codes",
	tags: TAGS,
	summary: "Create a one-time link code, valid for 10 minutes; send it with /link in the chat",
	agent: "deny",
	request: { body: { required: true, ...json(ChannelLinkCodeBodySchema) } },
	responses: {
		200: {
			description: "The code, its expiry and the channel it was made for",
			...json(ChannelLinkCodeResponseSchema),
		},
	},
});

const unlinkRoute = defineRoute({
	method: "delete",
	path: "/channel-accounts/{id}",
	tags: TAGS,
	summary: "Unlink one of the caller's chat accounts",
	agent: "deny",
	request: { params: ChannelAccountParamSchema },
	responses: { 200: { description: "Unlinked", ...json(OkResponseSchema) } },
});

const settingsRoute = defineRoute({
	method: "get",
	path: "/channel-settings",
	tags: TAGS,
	summary: "The caller's chat settings: the default notification account and the progress toggle",
	agent: "allow",
	responses: { 200: { description: "The settings", ...json(ChannelSettingsResponseSchema) } },
});

const saveSettingsRoute = defineRoute({
	method: "put",
	path: "/channel-settings",
	tags: TAGS,
	summary: "Change the caller's default notification account or progress toggle",
	agent: "deny",
	request: { body: { required: true, ...json(ChannelSettingsUpdateSchema) } },
	responses: { 200: { description: "The settings", ...json(ChannelSettingsResponseSchema) } },
});

export interface ChannelRoutesOptions {
	db: Db;
	channels: ChannelManager;
	audit: Audit;
}

/**
 * Chat channels (doc/design/channels.md): administrators manage bots; users link their own chat accounts and
 * choose where notifications go. Credentials are never returned, and every admin change is audited without them.
 */
export function channelRoutes(options: ChannelRoutesOptions) {
	const { db, channels, audit } = options;
	const app = apiRouter();

	app.openapi(listRoute, async (c) => c.json({ channels: await channels.listViews() }, 200));

	app.openapi(saveRoute, async (c) => {
		const { name } = c.req.valid("param");
		const input = c.req.valid("json") as ChannelInput;
		const channel = await channels.saveChannel(c.get("user"), name, input);
		return c.json({ channel }, 200);
	});

	app.openapi(deleteRoute, async (c) => {
		const { name } = c.req.valid("param");
		await channels.deleteChannel(c.get("user"), name);
		return c.json({ ok: true as const }, 200);
	});

	app.openapi(accountsRoute, async (c) => {
		const user = c.get("user");
		return c.json({ accounts: await channels.accounts(user.userId), channels: await channels.linkChannels() }, 200);
	});

	app.openapi(linkCodeRoute, async (c) => {
		const user = c.get("user");
		const { channelId } = c.req.valid("json");
		let channel: ChannelPublicView | undefined;
		if (channelId !== undefined) {
			const row = await getChannelById(db, channelId);
			if (!row || row.enabled !== 1) throw new UserError("no such enabled channel");
			channel = channelPublicView(row, channels.status(row.name).account);
		}
		const code = await channels.createLinkCode(user.userId);
		await audit.record({
			actor: userActor(user),
			action: "channel_account.link_code",
			target: { type: "user", id: user.userId },
			detail: { expires_at: code.expiresAt },
		});
		return c.json({ ...code, ...(channel ? { channel } : {}) }, 200);
	});

	app.openapi(unlinkRoute, async (c) => {
		const { id } = c.req.valid("param");
		await channels.unlink(c.get("user"), id);
		return c.json({ ok: true as const }, 200);
	});

	app.openapi(settingsRoute, async (c) => c.json({ settings: await channels.settings(c.get("user").userId) }, 200));

	app.openapi(saveSettingsRoute, async (c) => {
		const settings = await channels.saveSettings(c.get("user"), c.req.valid("json"));
		return c.json({ settings }, 200);
	});

	return app;
}
