import { type FormEvent, useCallback, useEffect, useState } from "react";
import { type AuditEvent, type AuditQuery, api, type VerifyResult } from "../api.ts";
import { useUser } from "../auth.tsx";
import { Badge, ErrorText, Loading } from "../components/Feedback.tsx";
import { errMsg, useAction, useDirectory } from "../hooks.ts";
import { formatTime } from "../lib.ts";

const PAGE = 50;

function TargetCell({ type, id }: { type: string | null; id: string | null }) {
	if (!type || !id) return <span className="muted">-</span>;
	const href = type === "task" ? `#/tasks/${id}` : type === "node" ? `#/nodes/${id}` : undefined;
	return (
		<>
			{type}:{href ? <a href={href}>{id}</a> : <span className="mono">{id}</span>}
		</>
	);
}

/** Users by name; other actors (tokens, the system) by type and id. */
function actorName(e: AuditEvent, userName: (id: string) => string | undefined) {
	const name = e.actorType === "user" ? userName(e.actorId) : undefined;
	return name ?? <span className="mono">{`${e.actorType}:${e.actorId}`}</span>;
}

function Row({ e, userName }: { e: AuditEvent; userName: (id: string) => string | undefined }) {
	const [open, setOpen] = useState(false);
	return (
		<>
			<tr>
				<td>{formatTime(e.ts)}</td>
				<td className="mono">{e.action}</td>
				<td>{actorName(e, userName)}</td>
				<td>{e.onBehalfOfUserId ? (userName(e.onBehalfOfUserId) ?? e.onBehalfOfUserId) : "-"}</td>
				<td>
					<TargetCell type={e.targetType} id={e.targetId} />
				</td>
				<td className="actions">
					<button type="button" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
						{open ? "Hide detail" : "Detail"}
					</button>
				</td>
			</tr>
			{open && (
				<tr>
					<td colSpan={6}>
						<section aria-label={`Detail of event ${e.seq}`}>
							<pre className="output">{JSON.stringify(e.detail, null, 2)}</pre>
						</section>
					</td>
				</tr>
			)}
		</>
	);
}

function Verify() {
	const [result, setResult] = useState<VerifyResult>();
	const { busy, error, run } = useAction();
	return (
		<div className="row wrap">
			<button
				type="button"
				disabled={busy}
				onClick={async () => {
					setResult(undefined);
					setResult(await run(() => api.verifyAudit()));
				}}
			>
				Verify chain
			</button>
			{result?.ok && <Badge kind="ok">{`chain intact, ${result.count} events`}</Badge>}
			{result && !result.ok && (
				<Badge kind="bad">{`chain broken at seq ${result.brokenAt} (${result.reason}) after ${result.count} verified`}</Badge>
			)}
			<ErrorText error={error} />
		</div>
	);
}

export function Audit() {
	const user = useUser();
	const { userName } = useDirectory();
	const [action, setAction] = useState("");
	const [targetType, setTargetType] = useState("");
	const [targetId, setTargetId] = useState("");
	const [applied, setApplied] = useState<AuditQuery>({});
	const [events, setEvents] = useState<AuditEvent[]>([]);
	const [more, setMore] = useState(false);
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState<string>();

	const fetchPage = useCallback(async (q: AuditQuery, append: boolean, before?: number) => {
		setLoading(true);
		setError(undefined);
		try {
			const page = await api.listAudit({ ...q, limit: PAGE, ...(before ? { beforeSeq: before } : {}) });
			setEvents((prev) => (append ? [...prev, ...page] : page));
			setMore(page.length === PAGE);
		} catch (e) {
			setError(errMsg(e));
		} finally {
			setLoading(false);
		}
	}, []);

	useEffect(() => {
		void fetchPage(applied, false);
	}, [applied, fetchPage]);

	const apply = (e: FormEvent) => {
		e.preventDefault();
		setApplied({
			action: action.trim() || undefined,
			targetType: targetType.trim() || undefined,
			targetId: targetId.trim() || undefined,
		});
	};
	const last = events[events.length - 1];
	return (
		<>
			<h1>Audit</h1>
			<form onSubmit={apply} className="row wrap end" aria-label="Audit filters">
				<label>
					Action (a trailing "." matches a prefix, e.g. "task.")
					<input value={action} onChange={(e) => setAction(e.target.value)} placeholder="task.approval" />
				</label>
				<label>
					Target type
					<input value={targetType} onChange={(e) => setTargetType(e.target.value)} placeholder="task" size={14} />
				</label>
				<label>
					Target id
					<input value={targetId} onChange={(e) => setTargetId(e.target.value)} />
				</label>
				<button type="submit">Filter</button>
				<button type="button" onClick={() => setApplied({ ...applied })}>
					Refresh
				</button>
			</form>
			{user.kind === "admin" && <Verify />}
			<ErrorText error={error} />
			<Loading loading={loading && events.length === 0} />
			{!loading && !error && events.length === 0 && <p className="muted">No events.</p>}
			{events.length > 0 && (
				<div className="scroll-x">
					<table aria-label="Audit events">
						<thead>
							<tr>
								<th>Time</th>
								<th>Action</th>
								<th>Actor</th>
								<th>On behalf of</th>
								<th>Target</th>
								<th />
							</tr>
						</thead>
						<tbody>
							{events.map((e) => (
								<Row key={e.seq} e={e} userName={userName} />
							))}
						</tbody>
					</table>
				</div>
			)}
			{more && last && (
				<div className="row">
					<button type="button" disabled={loading} onClick={() => fetchPage(applied, true, last.seq)}>
						Load older
					</button>
				</div>
			)}
		</>
	);
}
