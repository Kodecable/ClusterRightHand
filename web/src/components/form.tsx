import { type ReactNode, useId } from "react";
import { type Control, type FieldPath, type FieldValues, useController } from "react-hook-form";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";

interface FieldShellProps {
	id: string;
	label: ReactNode;
	description?: ReactNode;
	error?: string;
	className?: string;
	children: ReactNode;
}

/** The label, control, description and error line around one form field. */
export function FieldShell({ id, label, description, error, className, children }: FieldShellProps) {
	return (
		<div data-slot="field" className={cn("grid content-start gap-1.5", className)}>
			<Label htmlFor={id}>{label}</Label>
			{children}
			{description !== undefined && (
				<p className="text-xs text-muted-foreground" id={`${id}-description`}>
					{description}
				</p>
			)}
			{error !== undefined && error !== "" && (
				<p role="alert" className="text-xs text-danger" id={`${id}-error`}>
					{error}
				</p>
			)}
		</div>
	);
}

export interface BaseFieldProps<T extends FieldValues> {
	control: Control<T>;
	name: FieldPath<T>;
	label: ReactNode;
	description?: ReactNode;
	placeholder?: string;
	disabled?: boolean;
	className?: string;
	autoComplete?: string;
}

type BaseProps = {
	description?: ReactNode;
	disabled?: boolean;
	className?: string;
};

function useField<T extends FieldValues>(control: Control<T>, name: FieldPath<T>) {
	const { field, fieldState } = useController({ control, name });
	return { field, error: fieldState.error?.message };
}

/** A single-line text input bound to react-hook-form. */
export function TextField<T extends FieldValues>({
	control,
	name,
	label,
	description,
	placeholder,
	disabled,
	className,
	autoComplete,
	type = "text",
	onBlur,
	autoFocus,
}: BaseFieldProps<T> & {
	type?: "text" | "password" | "email" | "url" | "search" | "tel";
	onBlur?: () => void;
	autoFocus?: boolean;
}) {
	const id = useId();
	const { field, error } = useField(control, name);
	return (
		<FieldShell id={id} label={label} description={description} error={error} className={className}>
			<Input
				id={id}
				type={type}
				placeholder={placeholder}
				disabled={disabled}
				autoComplete={autoComplete}
				autoFocus={autoFocus}
				aria-invalid={error !== undefined || undefined}
				aria-describedby={description !== undefined ? `${id}-description` : undefined}
				{...field}
				value={(field.value ?? "") as string}
				onBlur={() => {
					field.onBlur();
					onBlur?.();
				}}
			/>
		</FieldShell>
	);
}

/** A multi-line text input bound to react-hook-form. */
export function TextareaField<T extends FieldValues>({
	control,
	name,
	label,
	description,
	placeholder,
	disabled,
	className,
	rows = 4,
}: BaseFieldProps<T> & { rows?: number }) {
	const id = useId();
	const { field, error } = useField(control, name);
	return (
		<FieldShell id={id} label={label} description={description} error={error} className={className}>
			<Textarea
				id={id}
				rows={rows}
				placeholder={placeholder}
				disabled={disabled}
				aria-invalid={error !== undefined || undefined}
				{...field}
				value={(field.value ?? "") as string}
			/>
		</FieldShell>
	);
}

export interface SelectOption {
	value: string;
	label: ReactNode;
	disabled?: boolean;
}

/** A Base UI select bound to react-hook-form. */
export function SelectField<T extends FieldValues>({
	control,
	name,
	label,
	description,
	placeholder,
	disabled,
	className,
	options,
}: BaseFieldProps<T> & { options: readonly SelectOption[] }) {
	const id = useId();
	const { field, error } = useField(control, name);
	const value = typeof field.value === "string" ? field.value : "";
	return (
		<FieldShell id={id} label={label} description={description} error={error} className={className}>
			<Select
				value={value === "" ? null : value}
				onValueChange={(next) => field.onChange(next ?? "")}
				disabled={disabled}
			>
				<SelectTrigger id={id} className="w-full" aria-invalid={error !== undefined || undefined}>
					<SelectValue placeholder={placeholder}>
						{(selected: string | null) => options.find((option) => option.value === selected)?.label ?? placeholder}
					</SelectValue>
				</SelectTrigger>
				<SelectContent>
					{options.map((option) => (
						<SelectItem key={option.value} value={option.value} disabled={option.disabled}>
							{option.label}
						</SelectItem>
					))}
				</SelectContent>
			</Select>
		</FieldShell>
	);
}

/** A checkbox bound to react-hook-form (the label text lives beside the box). */
export function CheckboxField<T extends FieldValues>({
	control,
	name,
	label,
	description,
	disabled,
	className,
}: BaseFieldProps<T> & BaseProps) {
	const id = useId();
	const { field, error } = useField(control, name);
	return (
		<div className={cn("grid content-start gap-1.5", className)}>
			<div className="flex items-start gap-2">
				<Checkbox
					id={id}
					className="mt-0.5"
					checked={Boolean(field.value)}
					onCheckedChange={(checked) => field.onChange(Boolean(checked))}
					disabled={disabled}
					aria-invalid={error !== undefined || undefined}
				/>
				<Label htmlFor={id}>{label}</Label>
			</div>
			{description !== undefined && <p className="text-xs text-muted-foreground">{description}</p>}
			{error !== undefined && (
				<p role="alert" className="text-xs text-danger">
					{error}
				</p>
			)}
		</div>
	);
}

/** The action row at the end of a page form (a dialog uses `DialogFooter` instead). */
export function FormActions({ className, children }: { className?: string; children: ReactNode }) {
	return <div className={cn("flex flex-wrap items-center justify-end gap-2", className)}>{children}</div>;
}
