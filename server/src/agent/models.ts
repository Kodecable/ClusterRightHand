// The model registry. Model references and custom provider types live in model-types.ts, input validation in
// model-validate.ts, stored providers in model-providers.ts and the pi-ai adapters in custom-provider.ts; this module
// re-exports what the rest of the server uses.

import type { AvailableModel } from "@crh/api";
import type {
	Api,
	AssistantMessage,
	Context,
	Model,
	ModelsSimpleStreamOptions,
	ModelThinkingLevel,
} from "@earendil-works/pi-ai";
import {
	clampThinkingLevel,
	createModels,
	getSupportedThinkingLevels,
	type Models,
	type MutableModels,
	type Provider,
} from "@earendil-works/pi-ai/models";
import { builtinProviders } from "@earendil-works/pi-ai/providers/all";
import { secretAad } from "../keys/export.ts";
import type { MasterKey } from "../keys/master-key.ts";
import type { Db } from "../storage/db.ts";
import { UserError } from "../util/errors.ts";
import { customProvider, type ProviderSessionResolver, withKey } from "./custom-provider.ts";
import { type CompleteMeter, meteredModels } from "./metering.ts";
import { parseJson } from "./model-providers.ts";
import { type CustomModel, levelDisplayName, type ModelRef, type ThinkingLevelLabels } from "./model-types.ts";

export type { ProviderSessionResolver } from "./custom-provider.ts";
export {
	deleteModelProvider,
	listModelProviders,
	type ModelProviderView,
	saveModelProvider,
} from "./model-providers.ts";
export {
	type CustomApi,
	type CustomModel,
	levelDisplayName,
	levelIsHidden,
	type ModelRef,
	modelRefView,
	parseModelRef,
	type SessionIdConfig,
	THINKING_FORMATS,
	THINKING_LEVELS,
	type ThinkingBodyConfig,
	type ThinkingConfig,
	type ThinkingFormatConfig,
	type ThinkingLevelLabels,
	thinkingLevelOf,
} from "./model-types.ts";
export { builtinProviderIds, type ModelProviderFields } from "./model-validate.ts";

/**
 * The model registry for the agent runtime, from the configured providers. Rebuilt when an administrator
 * changes the configuration (`reload`). The pi-ai registry is private: callers inside the agent directory ask
 * this class for the few operations they need, so the boundary test can keep pi imports in this directory.
 */
export class ModelConfig {
	readonly #db: Db;
	readonly #masterKey: MasterKey;
	readonly #models: MutableModels;
	/** Tests: providers added in code (e.g. pi-ai's faux provider), kept across reloads. */
	readonly #extra: Provider[] = [];
	/** Custom models by `provider/modelId`, for their per-level display names (`available`). */
	readonly #customModels = new Map<string, CustomModel>();
	/** Installed by the runtime: provider session id -> crh session id (doc/agent-runtime.md#自定义提供方). */
	#providerSessionId: ProviderSessionResolver = () => undefined;
	#providerSessionFor: (sessionId: string) => string | undefined = () => undefined;
	/** Tail of the reload queue: a reload starts only after the one before it has finished. */
	#reloadTail: Promise<void> = Promise.resolve();

	constructor(db: Db, masterKey: MasterKey) {
		this.#db = db;
		this.#masterKey = masterKey;
		this.#models = createModels();
	}

	/** Installs the runtime's provider-session mapping, used for custom providers' session id fields. */
	setSessionResolver(
		resolve: ProviderSessionResolver,
		providerSessionIdFor: (sessionId: string) => string | undefined,
	): void {
		this.#providerSessionId = resolve;
		this.#providerSessionFor = providerSessionIdFor;
	}

	/** The crh session id of a provider session id, or undefined when the mapping is not known (yet). */
	resolveProviderSession(providerSessionId: string | undefined): string | undefined {
		if (!providerSessionId) return undefined;
		return this.#providerSessionId(providerSessionId);
	}

	/** The provider session id of a crh session, for callers outside a durable conversation (Auto Review). */
	providerSessionIdFor(sessionId: string): string | undefined {
		return this.#providerSessionFor(sessionId);
	}

	addProvider(provider: Provider): void {
		this.#extra.push(provider);
		this.#models.setProvider(provider);
	}

	/** One configured model, or undefined when no enabled provider offers it. */
	getModel(provider: string, modelId: string): Model<Api> | undefined {
		return this.#models.getModel(provider, modelId);
	}

	/** The one-shot completion Auto Review and title generation use, on the configured registry. */
	completeSimple(model: Model<Api>, context: Context, options?: ModelsSimpleStreamOptions): Promise<AssistantMessage> {
		return this.#models.completeSimple(model, context, options);
	}

	/** The registry the Harness gets, wrapped so its compaction calls are metered (doc/agent-runtime.md#配额). */
	metered(onComplete: CompleteMeter): Models {
		return meteredModels(this.#models, onComplete);
	}

	/**
	 * Rebuilds the registry from the stored providers.
	 *
	 * Everything asynchronous (rows, decrypted keys) is read first and the complete provider list and
	 * custom-model map are built, then the registry is replaced without an await in between: a resolve during a
	 * reload sees the previous configuration or the new one, never an empty registry. Reloads run one after
	 * another, so a reload requested while another runs reads the database only after that reload has finished.
	 */
	async reload(): Promise<void> {
		const run = this.#reloadTail.then(() => this.#rebuild());
		// A failed reload must not block the next one; its caller still sees this reload's error.
		this.#reloadTail = run.catch(() => {});
		await run;
	}

	async #rebuild(): Promise<void> {
		const rows = await this.#db.selectFrom("model_providers").selectAll().where("enabled", "=", 1).execute();
		const builtins = new Map(builtinProviders().map((p) => [p.id, p]));
		const providers: Provider[] = [];
		const customModels = new Map<string, CustomModel>();
		for (const row of rows) {
			let key: string | undefined;
			if (row.secret_id) {
				const secret = await this.#db
					.selectFrom("secrets")
					.selectAll()
					.where("id", "=", row.secret_id)
					.executeTakeFirst();
				if (secret)
					key = this.#masterKey.decrypt(secret.ciphertext, secretAad(secret.id, secret.kind)).toString("utf8");
			}
			if (row.kind === "builtin") {
				const base = builtins.get(row.builtin ?? "");
				if (base) providers.push(withKey(base, key, row.base_url));
			} else {
				for (const model of parseJson<CustomModel[]>(row.models) ?? []) {
					customModels.set(`${row.provider_id}/${model.id}`, model);
				}
				providers.push(customProvider(row, key, (id) => this.resolveProviderSession(id)));
			}
		}
		// From here to the end there is no await: the registry changes in one step. Providers added in code are
		// read here rather than before the waits, so one added while a reload is reading is kept.
		const all = [...this.#extra, ...providers];
		this.#models.clearProviders();
		for (const provider of all) this.#models.setProvider(provider);
		this.#customModels.clear();
		for (const [ref, model] of customModels) this.#customModels.set(ref, model);
	}

	/** Models sessions may pick: those of enabled providers, with their levels and input kinds. */
	available(): AvailableModel[] {
		return this.#models.getModels().map((m) => {
			const custom = this.#customModels.get(`${m.provider}/${m.id}`);
			const thinkingLevels = getSupportedThinkingLevels(m);
			return {
				provider: m.provider,
				providerName: this.#models.getProvider(m.provider)?.name ?? m.provider,
				modelId: m.id,
				name: m.name,
				contextWindow: m.contextWindow,
				thinkingLevels,
				...(custom
					? {
							thinkingLabels: Object.fromEntries(
								thinkingLevels.map((level) => [level, levelDisplayName(custom.thinking?.labels, level)]),
							) as ThinkingLevelLabels,
						}
					: {}),
				input: [...m.input],
			};
		});
	}

	assertAvailable(ref: ModelRef): void {
		if (!this.#models.getModel(ref.provider, ref.modelId)) {
			throw new UserError(`model ${ref.provider}/${ref.modelId} is not configured`);
		}
	}

	/**
	 * Resolves a model reference to the level it runs at (doc/agent-runtime.md#思考档位): an explicit level must be
	 * supported by the model, otherwise a model change keeps the previous level, clamped to the nearest supported
	 * one. The returned ref omits `off`, the stored convention; callers use `thinkingLevelOf` for the durable config.
	 */
	resolveRef(ref: ModelRef, previousLevel?: ModelThinkingLevel): ModelRef {
		const model = this.#models.getModel(ref.provider, ref.modelId);
		if (!model) throw new UserError(`model ${ref.provider}/${ref.modelId} is not configured`);
		let level: ModelThinkingLevel;
		if (ref.thinkingLevel !== undefined) {
			const supported = getSupportedThinkingLevels(model);
			if (!supported.includes(ref.thinkingLevel)) {
				throw new UserError(
					`thinking level ${ref.thinkingLevel} is not supported by ${ref.provider}/${ref.modelId}; supported: ${supported.join(", ")}`,
				);
			}
			level = ref.thinkingLevel;
		} else {
			level = clampThinkingLevel(model, previousLevel ?? "off");
		}
		return {
			provider: ref.provider,
			modelId: ref.modelId,
			...(level === "off" ? {} : { thinkingLevel: level }),
		};
	}
}
