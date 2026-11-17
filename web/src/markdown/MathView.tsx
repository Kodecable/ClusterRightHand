// biome-ignore-all lint/security/noDangerouslySetInnerHtml: with trust off Temml emits MathML only (no links, images or raw HTML), and the markup is its own escaped output.
import { useEffect, useState } from "react";
import { cn } from "@/lib/utils";

/**
 * A formula rendered as browser-native MathML with Temml
 * (doc/design/webui.md "SafeMarkdown"). Temml and its local font stylesheet are
 * a dynamic import, so a page whose messages contain no math never downloads
 * them; while the module loads, and when the TeX cannot be rendered, the source
 * is shown in a monospace span.
 */

type TemmlModule = typeof import("temml");

let temmlPromise: Promise<TemmlModule["default"]> | null = null;

function loadTemml(): Promise<TemmlModule["default"]> {
	// One shared promise: every formula on the page waits for the same chunk.
	temmlPromise ??= Promise.all([import("temml"), import("temml/dist/Temml-Local.css")]).then(
		([module]) => module.default,
	);
	return temmlPromise;
}

export function MathView({ tex, display }: { tex: string; display: boolean }) {
	const [html, setHtml] = useState<string | null>(null);
	const [failed, setFailed] = useState(false);

	useEffect(() => {
		let alive = true;
		// A formula can change while streaming; never leave a previous rendering (or its error) behind.
		setHtml(null);
		setFailed(false);
		void loadTemml()
			.then((temml) => {
				if (!alive) return;
				try {
					const rendered = temml.renderToString(tex, {
						displayMode: display,
						throwOnError: false,
						// MathML only: with trust off, Temml cannot emit links, images or raw HTML, so the
						// generated string is safe to pass through dangerouslySetInnerHTML.
						trust: false,
						annotate: true,
						maxExpand: 1000,
					});
					// `throwOnError: false` renders a `.temml-error` span instead of throwing; show the source.
					if (rendered.includes("temml-error")) setFailed(true);
					else setHtml(rendered);
				} catch {
					setFailed(true);
				}
			})
			.catch(() => {
				if (alive) setFailed(true);
			});
		return () => {
			alive = false;
		};
	}, [tex, display]);

	if (html === null || failed) {
		return (
			<span
				className={cn("font-mono", display ? "block overflow-x-auto text-center text-sm whitespace-pre" : "text-sm")}
				data-testid="math-source"
				data-math-display={display || undefined}
			>
				{tex}
			</span>
		);
	}

	if (display) {
		return (
			<div
				className="math-display my-2 overflow-x-auto text-center"
				data-testid="math"
				dangerouslySetInnerHTML={{ __html: html }}
			/>
		);
	}
	return <span className="math-inline" data-testid="math" dangerouslySetInnerHTML={{ __html: html }} />;
}
