import { addJump, editHop, emptyHop, type Hop, moveJump, removeJump } from "../sshHops.ts";

function HopFields({ hop, onChange }: { hop: Hop; onChange: (p: Partial<Omit<Hop, "hostKey">>) => void }) {
	return (
		<div className="row wrap">
			<label>
				Host
				<input value={hop.host} onChange={(e) => onChange({ host: e.target.value })} />
			</label>
			<label>
				Port
				<input value={hop.port} inputMode="numeric" size={5} onChange={(e) => onChange({ port: e.target.value })} />
			</label>
			<label>
				User
				<input value={hop.user} onChange={(e) => onChange({ user: e.target.value })} />
			</label>
		</div>
	);
}

/** Wizard step 2: target, node name and groups, and the ordered jump hosts (hops = jumps then target). */
export function SshRouteStep(props: {
	hops: Hop[];
	onHops: (h: Hop[]) => void;
	name: string;
	onName: (s: string) => void;
	groups: string;
	onGroups: (s: string) => void;
}) {
	const { hops, onHops } = props;
	const last = hops.length - 1;
	return (
		<div className="stack">
			{hops.slice(0, last).map((h, i) => (
				// biome-ignore lint/suspicious/noArrayIndexKey: jumps have no identity beyond their position
				<div key={i} className="hop stack">
					<div className="row">
						<strong>Jump host {i + 1}</strong>
						<span className="spacer" />
						<button type="button" disabled={i === 0} onClick={() => onHops(moveJump(hops, i, -1))}>
							Up
						</button>
						<button type="button" disabled={i === last - 1} onClick={() => onHops(moveJump(hops, i, 1))}>
							Down
						</button>
						<button type="button" className="danger" onClick={() => onHops(removeJump(hops, i))}>
							Remove
						</button>
					</div>
					<HopFields hop={h} onChange={(p) => onHops(editHop(hops, i, p))} />
				</div>
			))}
			<button type="button" onClick={() => onHops(addJump(hops, emptyHop((hops[last] as Hop).user)))}>
				Add jump host
			</button>
			<div className="hop stack">
				<strong>Target</strong>
				<HopFields hop={hops[last] as Hop} onChange={(p) => onHops(editHop(hops, last, p))} />
			</div>
			<label>
				Node name (optional, defaults to the host)
				<input value={props.name} onChange={(e) => props.onName(e.target.value)} />
			</label>
			<label>
				Groups (comma separated)
				<input value={props.groups} onChange={(e) => props.onGroups(e.target.value)} />
			</label>
		</div>
	);
}
