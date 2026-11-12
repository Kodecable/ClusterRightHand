import { chmod, readFile, stat, writeFile } from "node:fs/promises";
import { z } from "zod";

/** A refused setup step: bad answers, a refused answers file or a failed system command. */
export class SetupError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "SetupError";
	}
}

const listen = z.strictObject({
	host: z.string().min(1).optional(),
	port: z.number().int().min(0).max(65535).optional(),
});

const database = z.strictObject({
	driver: z.enum(["sqlite", "postgres"]).optional(),
	path: z.string().min(1).optional(),
	url: z.string().min(1).optional(),
});

const admin = z.strictObject({
	username: z.string().min(1).optional(),
	display_name: z.string().min(1).optional(),
	password: z.string().min(1).optional(),
});

const service = z.strictObject({
	install: z.boolean().optional(),
	start: z.boolean().optional(),
});

/** `--answers <file>`: every field is optional, so the file may answer only some questions. */
export const answersSchema = z.strictObject({
	version: z.literal(1),
	listen: listen.optional(),
	database: database.optional(),
	public_url: z.string().optional(),
	admin: admin.optional(),
	service: service.optional(),
});

export type Answers = z.infer<typeof answersSchema>;

/** Parses and validates an answers object; unknown fields, wrong types and other versions are errors. */
export function parseAnswers(input: unknown): Answers {
	const result = answersSchema.safeParse(input);
	if (!result.success) {
		const issues = result.error.issues.map((issue) => {
			const path = issue.path.join(".");
			return `${path === "" ? "(root)" : path}: ${issue.message}`;
		});
		throw new SetupError(`invalid answers: ${issues.join("; ")}`);
	}
	return result.data;
}

/** True when the answers carry one of the secret fields (passwords and database URLs). */
export function answersContainSecret(answers: Answers): boolean {
	return answers.admin?.password !== undefined || answers.database?.url !== undefined;
}

/**
 * Reads `--answers <file>`. A file that holds a secret is refused unless only its owner can read it
 * (mode & 0o077 == 0), because a password or database URL next to world-readable data would leak.
 */
export async function loadAnswersFile(path: string): Promise<Answers> {
	let text: string;
	try {
		text = await readFile(path, "utf8");
	} catch (err) {
		const code = (err as NodeJS.ErrnoException).code;
		throw new SetupError(
			code === "ENOENT"
				? `answers file ${path} not found`
				: `cannot read answers file ${path}: ${(err as Error).message}`,
		);
	}
	let raw: unknown;
	try {
		raw = JSON.parse(text);
	} catch (err) {
		throw new SetupError(`${path}: not valid JSON: ${(err as Error).message}`);
	}
	const answers = parseAnswers(raw);
	if (answersContainSecret(answers)) {
		const info = await stat(path);
		if ((info.mode & 0o077) !== 0) {
			throw new SetupError(
				`answers file ${path} contains a secret and must not be accessible by group or others (chmod 600)`,
			);
		}
	}
	return answers;
}

/** A copy without `admin.password` and `database.url`; the fields `--save-answers` must never write. */
export function withoutSecrets(answers: Answers): Answers {
	const clean = structuredClone(answers);
	if (clean.admin) delete clean.admin.password;
	if (clean.database) delete clean.database.url;
	return clean;
}

/** Writes `--save-answers <file>`: the answers without secrets, readable only by their owner. */
export async function saveAnswersFile(path: string, answers: Answers): Promise<void> {
	await writeFile(path, `${JSON.stringify(withoutSecrets(answers), null, 2)}\n`, { mode: 0o600 });
	// writeFile's mode applies only when it creates the file; an existing file keeps its old mode.
	await chmod(path, 0o600);
}
