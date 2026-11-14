import type { McpServerGrant, McpServerView } from "@crh/api";
import { Trans, useLingui } from "@lingui/react/macro";
import { PlusIcon, XIcon } from "lucide-react";
import { type ComponentProps, useState } from "react";
import { FormDialog } from "@/components/dialogs";
import { type EntityOption, EntityPicker } from "@/components/entity-picker";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useDirectory } from "@/features/users/api";
import { useSaveMcpServer } from "./api";

interface HeaderRow {
	id: string;
	name: string;
	value: string;
}

function headerRows(server: McpServerView | undefined): HeaderRow[] {
	return (server?.headerNames ?? []).map((name) => ({ id: crypto.randomUUID(), name, value: "" }));
}

/**
 * The MCP server editor (doc/design/extensions.md "MCP servers"): every field of a server, with the request
 * headers write-only. The stored names are listed, but their values never come back; changing the URL of a
 * server with stored headers requires entering them again or removing them.
 */
export function McpServerDialog({
	existing,
	onClose,
	onSaved,
}: {
	existing: McpServerView | undefined;
	onClose: () => void;
	onSaved: () => void;
}) {
	const { t } = useLingui();
	const save = useSaveMcpServer();
	const directory = useDirectory();
	const [name, setName] = useState(existing?.name ?? "");
	const [description, setDescription] = useState(existing?.description ?? "");
	const [url, setUrl] = useState(existing?.url ?? "");
	const [timeoutSeconds, setTimeoutSeconds] = useState(String(existing?.timeoutSeconds ?? 300));
	const [enabled, setEnabled] = useState(existing?.enabled ?? true);
	const [listDirectly, setListDirectly] = useState(existing?.listDirectly ?? false);
	const [trustAnnotations, setTrustAnnotations] = useState(existing?.trustAnnotations ?? true);
	const [identityUsername, setIdentityUsername] = useState(existing?.identityHeaders.username ?? "");
	const [identitySession, setIdentitySession] = useState(existing?.identityHeaders.session ?? "");
	const [removeHeaders, setRemoveHeaders] = useState(false);
	const [headers, setHeaders] = useState<HeaderRow[]>(headerRows(existing));
	const [grants, setGrants] = useState<McpServerGrant[]>(existing?.grants ?? []);
	const [grantee, setGrantee] = useState("");
	const [granteeType, setGranteeType] = useState<"user" | "user_group">("user");
	const [error, setError] = useState<string>();

	const directoryNames = new Map<string, string>([
		...(directory.data?.users ?? []).map((user) => [`user:${user.id}`, user.displayName || user.username] as const),
		...(directory.data?.userGroups ?? []).map((group) => [`user_group:${group.id}`, group.name] as const),
	]);

	const addGrant = () => {
		if (grantee === "") return;
		if (grants.some((grant) => grant.granteeType === granteeType && grant.granteeId === grantee)) return;
		setGrants([...grants, { granteeType, granteeId: grantee }]);
		setGrantee("");
	};

	const changedHeaders = headers.filter((header) => header.name.trim() !== "" || header.value !== "");
	const urlChanged = existing !== undefined && existing.url !== url.trim();
	const submit = () => {
		setError(undefined);
		const seconds = Number(timeoutSeconds);
		if (!Number.isInteger(seconds) || seconds < 1 || seconds > 3600) {
			setError(t`The timeout must be a whole number of seconds from 1 to 3600.`);
			return;
		}
		if (existing?.hasHeaders && urlChanged && !removeHeaders && changedHeaders.length === 0) {
			setError(t`Changing the URL requires entering the headers again or removing them.`);
			return;
		}
		const body = {
			description: description.trim() === "" ? null : description.trim(),
			url: url.trim(),
			identityHeaders: { username: identityUsername.trim() || null, session: identitySession.trim() || null },
			enabled,
			listDirectly,
			trustAnnotations,
			timeoutSeconds: seconds,
			grants,
			...(removeHeaders ? { headers: null } : changedHeaders.length > 0 ? { headers: changedHeaders } : {}),
		};
		save.mutate(
			{ name: existing?.name ?? name.trim(), body },
			{
				onSuccess: () => {
					onSaved();
					onClose();
				},
			},
		);
	};

	const text = (props: ComponentProps<typeof Input>) => <Input {...props} />;

	return (
		<FormDialog
			open
			onOpenChange={(open) => {
				if (!open) onClose();
			}}
			title={existing ? t`Edit MCP server ${existing.name}` : t`New MCP server`}
			description={
				<Trans>
					A server is reached over Streamable HTTP with static headers. Only administrators connect servers; the grants
					decide which sessions may use it.
				</Trans>
			}
			onSubmit={submit}
			busy={save.isPending}
			error={error ?? (save.error === null || save.error === undefined ? undefined : (save.error as Error).message)}
			testId="mcp-server-dialog"
		>
			<div className="grid gap-1.5">
				<Label htmlFor="mcp-server-name">{t`Name`}</Label>
				<Input
					id="mcp-server-name"
					value={name}
					disabled={existing !== undefined}
					placeholder="github"
					onChange={(event) => setName(event.target.value)}
				/>
				<p className="text-xs text-muted-foreground">
					<Trans>Lowercase letters, digits and "-", not starting with a digit. Tools and rules use it.</Trans>
				</p>
			</div>
			<div className="grid gap-1.5">
				<Label htmlFor="mcp-server-description">{t`Description`}</Label>
				<Input
					id="mcp-server-description"
					value={description}
					placeholder={t`Shown to the model; the server's own instructions otherwise`}
					onChange={(event) => setDescription(event.target.value)}
				/>
			</div>
			<div className="grid gap-1.5">
				<Label htmlFor="mcp-server-url">{t`URL`}</Label>
				{text({
					id: "mcp-server-url",
					value: url,
					placeholder: "https://mcp.example.com/mcp",
					onChange: (event) => setUrl(event.target.value),
				})}
			</div>
			<div className="grid gap-1.5">
				<Label htmlFor="mcp-server-timeout">{t`Timeout (seconds)`}</Label>
				{text({
					id: "mcp-server-timeout",
					type: "number",
					min: 1,
					max: 3600,
					value: timeoutSeconds,
					onChange: (event) => setTimeoutSeconds(event.target.value),
				})}
			</div>
			<fieldset className="grid gap-2">
				<legend className="text-sm font-medium">{t`Request headers`}</legend>
				<p className="text-xs text-muted-foreground">
					<Trans>
						Sent on every request and stored encrypted; the values are never shown again. Changing the URL requires
						entering them again or removing them.
					</Trans>
				</p>
				{existing?.hasHeaders && (
					<p className="text-xs">
						<Trans>Stored headers: {existing.headerNames.join(", ")}</Trans>
					</p>
				)}
				{headers.map((header, index) => (
					<div key={header.id} className="grid grid-cols-[1fr_1fr_auto] gap-2">
						<Input
							aria-label={t`Header ${index + 1} name`}
							placeholder={t`Header`}
							value={header.name}
							onChange={(event) =>
								setHeaders(headers.map((entry, i) => (i === index ? { ...entry, name: event.target.value } : entry)))
							}
						/>
						<Input
							aria-label={t`Header ${index + 1} value`}
							placeholder={t`Value`}
							value={header.value}
							onChange={(event) =>
								setHeaders(headers.map((entry, i) => (i === index ? { ...entry, value: event.target.value } : entry)))
							}
						/>
						<Button
							type="button"
							size="icon-xs"
							variant="ghost"
							aria-label={t`Remove header ${index + 1}`}
							onClick={() => setHeaders(headers.filter((_, i) => i !== index))}
						>
							<XIcon />
						</Button>
					</div>
				))}
				<div className="flex flex-wrap items-center gap-2">
					<Button
						type="button"
						size="sm"
						variant="outline"
						onClick={() => setHeaders([...headers, { id: crypto.randomUUID(), name: "", value: "" }])}
					>
						<PlusIcon />
						<Trans>Add header</Trans>
					</Button>
					{existing?.hasHeaders && (
						<label htmlFor="mcp-remove-headers" className="flex items-center gap-1.5 text-xs">
							<Checkbox
								id="mcp-remove-headers"
								checked={removeHeaders}
								onCheckedChange={(checked) => setRemoveHeaders(Boolean(checked))}
							/>
							<Trans>Remove stored headers</Trans>
						</label>
					)}
				</div>
			</fieldset>
			<fieldset className="grid gap-2">
				<legend className="text-sm font-medium">{t`Identity headers`}</legend>
				<p className="text-xs text-muted-foreground">
					<Trans>
						Optional header names that receive the CRH username and session id. They are not authentication.
					</Trans>
				</p>
				<div className="grid gap-2 sm:grid-cols-2">
					<div className="grid gap-1.5">
						<Label htmlFor="mcp-identity-username">{t`Username header`}</Label>
						<Input
							id="mcp-identity-username"
							value={identityUsername}
							placeholder="X-CRH-User"
							onChange={(event) => setIdentityUsername(event.target.value)}
						/>
					</div>
					<div className="grid gap-1.5">
						<Label htmlFor="mcp-identity-session">{t`Session id header`}</Label>
						<Input
							id="mcp-identity-session"
							value={identitySession}
							placeholder="X-CRH-Session"
							onChange={(event) => setIdentitySession(event.target.value)}
						/>
					</div>
				</div>
			</fieldset>
			<fieldset className="grid gap-2">
				<legend className="text-sm font-medium">{t`Behavior`}</legend>
				<label htmlFor="mcp-enabled" className="flex items-center gap-2 text-sm">
					<Checkbox id="mcp-enabled" checked={enabled} onCheckedChange={(checked) => setEnabled(Boolean(checked))} />
					<Trans>Enabled (a disabled server is invisible to sessions)</Trans>
				</label>
				<label htmlFor="mcp-list-directly" className="flex items-center gap-2 text-sm">
					<Checkbox
						id="mcp-list-directly"
						checked={listDirectly}
						onCheckedChange={(checked) => setListDirectly(Boolean(checked))}
					/>
					<Trans>List its tools directly in the model's tool list</Trans>
				</label>
				<label htmlFor="mcp-trust-annotations" className="flex items-center gap-2 text-sm">
					<Checkbox
						id="mcp-trust-annotations"
						checked={trustAnnotations}
						onCheckedChange={(checked) => setTrustAnnotations(Boolean(checked))}
					/>
					<Trans>Trust the server's annotations (a readOnly tool passes as mcp.read)</Trans>
				</label>
			</fieldset>
			<fieldset className="grid gap-2">
				<legend className="text-sm font-medium">{t`Access`}</legend>
				<p className="text-xs text-muted-foreground">
					<Trans>Only granted users and members of granted user groups reach this server.</Trans>
				</p>
				{grants.length > 0 && (
					<ul className="flex flex-wrap gap-1.5">
						{grants.map((grant) => {
							const key = `${grant.granteeType}:${grant.granteeId}`;
							return (
								<li key={key} className="flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs">
									{directoryNames.get(key) ?? grant.granteeId}
									<button
										type="button"
										aria-label={t`Remove ${directoryNames.get(key) ?? grant.granteeId}`}
										onClick={() => setGrants(grants.filter((entry) => entry !== grant))}
									>
										<XIcon className="size-3" />
									</button>
								</li>
							);
						})}
					</ul>
				)}
				<div className="flex flex-wrap items-end gap-2">
					<div className="min-w-48 flex-1">
						<EntityPicker
							kind="directory"
							label={t`Grantee`}
							value={grantee === "" ? null : grantee}
							onChange={(id, option: EntityOption | null) => {
								setGrantee(id ?? "");
								if (option !== null) setGranteeType(option.kind === "userGroup" ? "user_group" : "user");
							}}
						/>
					</div>
					<Button type="button" size="sm" variant="outline" onClick={addGrant}>
						<PlusIcon />
						<Trans>Grant</Trans>
					</Button>
				</div>
			</fieldset>
		</FormDialog>
	);
}
