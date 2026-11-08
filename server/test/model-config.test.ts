import { afterEach, beforeEach, expect, it } from "vitest";
import { deleteModelProvider } from "../src/agent/model-providers.ts";
import { ModelConfig, saveModelProvider } from "../src/agent/models.ts";
import { MasterKey } from "../src/keys/master-key.ts";
import type { Db } from "../src/storage/db.ts";
import { describeBackends, openTestDb } from "./helpers/db.ts";

const KEY = "sk-reload-test";

/**
 * A Db whose queries against `table` pause before their terminal call. `gate` supplies the promise to wait on
 * and `entered` is called as the wait starts, so a test can act while a reload is between its reads and its
 * registry update. Chained builder methods stay wrapped, so the pause applies at the end of the chain.
 */
function dbWithDelayedTable(db: Db, table: string, gate: () => Promise<void>, entered: () => void): Db {
	const delay = <T extends object>(builder: T): T =>
		new Proxy(builder, {
			get(target, property, receiver) {
				const value = Reflect.get(target, property, receiver) as unknown;
				if (typeof value !== "function") return value;
				const call = value as (...args: unknown[]) => unknown;
				if (property === "execute" || property === "executeTakeFirst" || property === "executeTakeFirstOrThrow") {
					return async (...args: unknown[]) => {
						entered();
						await gate();
						return call.apply(target, args);
					};
				}
				return (...args: unknown[]) => {
					const result = call.apply(target, args);
					return result !== null && typeof result === "object" && "execute" in result
						? delay(result as object)
						: result;
				};
			},
		});
	return new Proxy(db, {
		get(target, property, receiver) {
			const value = Reflect.get(target, property, receiver) as unknown;
			if (property === "selectFrom") {
				return (name: string) => {
					const query = (target.selectFrom as (name: string) => object)(name);
					return name === table ? delay(query) : query;
				};
			}
			return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(target) : value;
		},
	});
}

describeBackends("model config reload", (backend) => {
	let db: Db;
	let masterKey: MasterKey;
	let models: ModelConfig;
	/** The delay of the next secret read; resolved unless a test calls pauseSecretReads. */
	let gate: Promise<void> = Promise.resolve();
	let release: () => void = () => {};
	let markEntered: () => void = () => {};
	let entered: Promise<void> = Promise.resolve();

	const pauseSecretReads = (): void => {
		gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		entered = new Promise<void>((resolve) => {
			markEntered = resolve;
		});
	};

	const save = (providerId: string, modelId: string, apiKey?: string | null) =>
		saveModelProvider(db, masterKey, {
			kind: "custom",
			providerId,
			name: providerId,
			baseUrl: "http://127.0.0.1:9/v1",
			apiKey,
			models: [{ id: modelId, api: "openai-completions", input: ["text"], contextWindow: 4096, maxTokens: 512 }],
		});

	const ref = (provider: string, modelId: string) => ({ provider, modelId });

	beforeEach(async () => {
		db = await openTestDb(backend);
		masterKey = MasterKey.generate();
		gate = Promise.resolve();
		release = () => {};
		entered = Promise.resolve();
		markEntered = () => {};
		models = new ModelConfig(
			dbWithDelayedTable(
				db,
				"secrets",
				() => gate,
				() => markEntered(),
			),
			masterKey,
		);
	});

	afterEach(async () => {
		await db.destroy();
	});

	it("keeps the current models resolvable while a reload reads secrets", async () => {
		await save("existing", "m-1", KEY);
		await models.reload();
		expect(models.resolveRef(ref("existing", "m-1"))).toMatchObject({ provider: "existing", modelId: "m-1" });

		pauseSecretReads();
		const reloading = models.reload();
		await entered;
		// The reload has read the provider row and is waiting for its secret; the previous registry is still live.
		expect(models.resolveRef(ref("existing", "m-1"))).toMatchObject({ provider: "existing", modelId: "m-1" });

		release();
		await reloading;
		expect(models.resolveRef(ref("existing", "m-1"))).toMatchObject({ provider: "existing", modelId: "m-1" });
	});

	it("serializes concurrent reloads and ends with the last database state", async () => {
		await save("old", "m-old", KEY);
		await models.reload();
		expect(models.getModel("old", "m-old")).toBeDefined();

		pauseSecretReads();
		const first = models.reload();
		await entered;
		// While the first reload is paused, replace the configuration; the second reload has no secret to read.
		await deleteModelProvider(db, "old");
		await save("new", "m-new");
		const second = models.reload();
		await sleep(20);
		// The second reload waits for the first: nothing of the new configuration is visible yet.
		expect(models.getModel("old", "m-old")).toBeDefined();
		expect(models.getModel("new", "m-new")).toBeUndefined();

		release();
		await Promise.all([first, second]);
		expect(models.getModel("old", "m-old")).toBeUndefined();
		expect(models.getModel("new", "m-new")).toBeDefined();
		expect(models.available().map((model) => `${model.provider}/${model.modelId}`)).toEqual(["new/m-new"]);
	});
});

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
