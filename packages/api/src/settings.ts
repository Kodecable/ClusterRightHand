/**
 * Runtime system settings (`GET/PATCH /api/settings`): the low-frequency crhs settings that
 * administrators edit on the System settings page and that apply without a restart
 * (doc/guide/reference/crhs-config.md).
 *
 * Durations use the crhs.toml syntax (`"60s"`, `"5m"`, `"1d"`); retention values are also `"off"`.
 */

import type { LibraryLimits, SystemSettingsLibrary } from "./libraries.ts";

/** How long crhs keeps finished tasks and authorizations, audit events and durable tool tasks. */
export interface SystemSettingsRetention {
	/** Terminal tasks, terminal task groups and expired authorizations. */
	tasks: string;
	/** Audit events. */
	audit: string;
	/** Terminal durable agent tasks (pi_tasks). */
	piTasks: string;
}

/** Passkey settings; `rpId` null with empty `origins` derives the relying party from each request. */
export interface SystemSettingsWebauthn {
	rpId: string | null;
	rpName: string;
	origins: string[];
}

/** Login hashing and proof-of-work settings. */
export interface SystemSettingsAuth {
	captcha: "cap" | "none";
	argon2Concurrency: number;
	argon2Queue: number;
}

/** Chat attachments: how much short text is inlined into the model content (doc/design/library.md "Chat attachments"). */
export interface SystemSettingsAttachments {
	/** The largest file whose text content is appended to its attachment block. */
	inlineTextBytes: number;
	/** The most text inlined over one message. */
	inlineTotalBytes: number;
}

/** The image cache and its time to live (doc/design/library.md "Image cache"). */
export interface SystemSettingsImageCache {
	/** Bytes kept on crhs's local disk. */
	diskBytes: number;
	/** A duration such as "7d"; an entry unused for longer is swept. */
	ttl: string;
}

/** The settings administrators edit in System settings. */
export interface SystemSettings {
	/** Absolute public base URL for links crhs generates; null uses the request URL. */
	publicUrl: string | null;
	/** Warn when a node's clock differs from crhs's by more than this; `"0s"` disables the warning. */
	clockWarn: string;
	retention: SystemSettingsRetention;
	webauthn: SystemSettingsWebauthn;
	auth: SystemSettingsAuth;
	/** Header such as `X-Forwarded-For` whose first value is the client address; null uses the socket. */
	realIpHeader: string | null;
	/** The limits new user and user group libraries copy when they are created. */
	library: SystemSettingsLibrary;
	/** How much attachment text is inlined into the model content. */
	attachments: SystemSettingsAttachments;
	/** The image cache's sizes and its time to live. */
	imageCache: SystemSettingsImageCache;
}

export interface SystemSettingsResponse {
	settings: SystemSettings;
	/** The defaults a setting falls back to when it was never stored. */
	defaults: SystemSettings;
}

/** A partial update; omitted fields and groups keep their current value. */
export interface SystemSettingsPatch {
	publicUrl?: string | null;
	clockWarn?: string;
	retention?: {
		tasks?: string;
		audit?: string;
		piTasks?: string;
	};
	webauthn?: {
		/** Set rpId and origins together; null with an empty origins list clears them. */
		rpId?: string | null;
		rpName?: string;
		origins?: string[];
	};
	auth?: {
		captcha?: "cap" | "none";
		argon2Concurrency?: number;
		argon2Queue?: number;
	};
	realIpHeader?: string | null;
	library?: {
		user?: Partial<LibraryLimits>;
		group?: Partial<LibraryLimits>;
	};
	attachments?: {
		inlineTextBytes?: number;
		inlineTotalBytes?: number;
	};
	imageCache?: {
		diskBytes?: number;
		ttl?: string;
	};
}
