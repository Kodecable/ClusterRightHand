import { useEffect, useState } from "react";
import { Input } from "@/components/ui/input";
import { formatByteSize, parseByteSize } from "@/lib/byte-size";

export interface ByteSizeInputProps {
	id?: string;
	value: number;
	onChange: (value: number) => void;
	onBlur?: () => void;
	disabled?: boolean;
	className?: string;
	autoFocus?: boolean;
	"aria-invalid"?: boolean;
	"aria-describedby"?: string;
}

/**
 * A text input whose form value is a byte count: `32M` and `33554432` are the same value. The
 * typed text stays as it is until the input loses focus; a parseable size is then shown with
 * `formatByteSize`, and an unparseable one leaves the form value NaN for validation to reject.
 */
export function ByteSizeInput({ value, onChange, onBlur, ...props }: ByteSizeInputProps) {
	const [draft, setDraft] = useState<string | null>(null);
	const [editing, setEditing] = useState(false);
	const formatted = Number.isFinite(value) ? formatByteSize(value) : "";

	// A reset or server response changes the value while the input is not being edited; show it
	// formatted. An unparseable draft stays so the person can fix it.
	useEffect(() => {
		if (!editing && Number.isFinite(value)) setDraft(null);
	}, [editing, value]);

	return (
		<Input
			{...props}
			type="text"
			value={draft ?? formatted}
			onFocus={(event) => {
				const text = event.currentTarget.value;
				setEditing(true);
				setDraft((current) => current ?? text);
			}}
			onChange={(event) => {
				const text = event.currentTarget.value;
				setDraft(text);
				onChange(parseByteSize(text) ?? Number.NaN);
			}}
			onBlur={(event) => {
				const parsed = parseByteSize(event.currentTarget.value);
				setEditing(false);
				if (parsed === undefined) {
					onChange(Number.NaN);
				} else {
					onChange(parsed);
					setDraft(null);
				}
				onBlur?.();
			}}
		/>
	);
}
