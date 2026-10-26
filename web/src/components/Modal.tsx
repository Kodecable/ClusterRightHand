import { type ReactNode, useEffect, useRef } from "react";

export function Modal({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
	const ref = useRef<HTMLDialogElement>(null);
	useEffect(() => {
		const d = ref.current;
		if (d && !d.open) d.showModal();
	}, []);
	return (
		<dialog ref={ref} onClose={onClose} onCancel={onClose}>
			<h2>{title}</h2>
			{children}
		</dialog>
	);
}
