/**
 * API tokens and their rules (doc/access-control.md "api-token").
 */

import type { RefMap } from "./common.ts";
import type { StoredRuleSet } from "./policy.ts";

export interface ApiTokenView {
	id: string;
	name: string;
	userId: string;
	createdAt: string;
	/** null: never expires. */
	expiresAt: string | null;
	revokedAt: string | null;
	lastUsedAt: string | null;
	rules: StoredRuleSet | null;
	/** Display names for the UUIDs referenced by `rules`; null means the object was deleted. */
	refs: RefMap;
}
