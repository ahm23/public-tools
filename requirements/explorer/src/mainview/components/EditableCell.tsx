import { useEffect, useRef, useState, type ChangeEvent, type RefObject } from "react";

interface EditableCellProps {
	value: string;
	onCommit: (value: string) => void;
	multiline?: boolean;
	placeholder?: string;
	className?: string;
}

/**
 * A table cell that turns into an input/textarea on double-click.
 * Enter commits, Escape cancels, blur commits.
 */
export default function EditableCell({
	value,
	onCommit,
	multiline = false,
	placeholder,
	className,
}: EditableCellProps) {
	const [editing, setEditing] = useState(false);
	const [draft, setDraft] = useState(value);
	const inputRef = useRef<HTMLInputElement | HTMLTextAreaElement>(null);

	useEffect(() => {
		if (editing) {
			inputRef.current?.focus();
			inputRef.current?.select();
		}
	}, [editing]);

	const begin = () => {
		setDraft(value);
		setEditing(true);
	};

	const commit = () => {
		setEditing(false);
		if (draft !== value) onCommit(draft);
	};

	const cancel = () => {
		setEditing(false);
		setDraft(value);
	};

	if (editing) {
		const common = {
			className: "cell editing",
			value: draft,
			onChange: (e: ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) =>
				setDraft(e.target.value),
			onBlur: commit,
		};
		return multiline ? (
			<textarea
				{...common}
				ref={inputRef as unknown as RefObject<HTMLTextAreaElement>}
				onKeyDown={(e) => {
					if (e.key === "Enter" && !e.shiftKey) {
						e.preventDefault();
						commit();
					}
					if (e.key === "Escape") cancel();
				}}
			/>
		) : (
			<input
				{...common}
				ref={inputRef as unknown as RefObject<HTMLInputElement>}
				placeholder={placeholder}
				onKeyDown={(e) => {
					if (e.key === "Enter") {
						e.preventDefault();
						commit();
					}
					if (e.key === "Escape") cancel();
				}}
			/>
		);
	}

	return (
		<div
			className={`cell ${className ?? ""}`}
			onClick={begin}
			title="click to edit"
		>
			{value || <span className="placeholder-text">{placeholder ?? ""}</span>}
		</div>
	);
}