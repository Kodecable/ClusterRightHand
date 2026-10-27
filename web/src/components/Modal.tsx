import { type ReactNode, useEffect, useId, useRef } from "react";

export function Modal({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
	const ref = useRef<HTMLDialogElement>(null);
	const titleId = useId();
	useEffect(() => {
		const d = ref.current;
		if (d && !d.open) d.showModal();
	}, []);
	return (
		<dialog ref={ref} aria-labelledby={titleId} onClose={onClose} onCancel={onClose}>
			<h2 id={titleId}>{title}</h2>
			{children}
		</dialog>
	);
}
