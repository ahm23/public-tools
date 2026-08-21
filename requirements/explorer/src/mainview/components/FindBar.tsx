import type { RefObject } from "react";

export interface FindBarProps {
	query: string;
	onQueryChange: (q: string) => void;
	replaceQuery: string;
	onReplaceQueryChange: (q: string) => void;
	scopeTitle: boolean;
	scopeText: boolean;
	onScopeChange: (title: boolean, text: boolean) => void;
	caseSensitive: boolean;
	onCaseChange: (v: boolean) => void;
	raw: boolean;
	onRawChange: (v: boolean) => void;
	total: number;
	activeIndex: number; // 0-based into matches; -1 when there are none
	onPrev: () => void;
	onNext: () => void;
	onReplace: () => void;
	onReplaceAll: () => void;
	onClose: () => void;
	inputRef?: RefObject<HTMLInputElement>;
}

export default function FindBar({
	query,
	onQueryChange,
	replaceQuery,
	onReplaceQueryChange,
	scopeTitle,
	scopeText,
	onScopeChange,
	caseSensitive,
	onCaseChange,
	raw,
	onRawChange,
	total,
	activeIndex,
	onPrev,
	onNext,
	onReplace,
	onReplaceAll,
	onClose,
	inputRef,
}: FindBarProps) {
	const canAct = query.trim() !== "" && total > 0;
	const countLabel = total > 0 ? `${activeIndex + 1} / ${total}` : "No matches";

	return (
		<div className="find-bar">
			<input
				ref={inputRef}
				type="text"
				className="find-input"
				value={query}
				placeholder="Find…"
				spellCheck={false}
				autoFocus
				onChange={(e) => onQueryChange(e.target.value)}
				onKeyDown={(e) => {
					if (e.key === "Enter") {
						e.preventDefault();
						if (e.shiftKey) onPrev();
						else onNext();
					} else if (e.key === "Escape") {
						e.preventDefault();
						onClose();
					}
				}}
			/>
			<input
				type="text"
				className="find-input find-replace-input"
				value={replaceQuery}
				placeholder="Replace with…"
				spellCheck={false}
				onChange={(e) => onReplaceQueryChange(e.target.value)}
				onKeyDown={(e) => {
					if (e.key === "Enter") {
						e.preventDefault();
						if (e.shiftKey) onReplace();
						else onReplaceAll();
					} else if (e.key === "Escape") {
						e.preventDefault();
						onClose();
					}
				}}
			/>
			<span className="find-scopes">
				<label className="find-scope">
					<input
						type="checkbox"
						checked={scopeTitle}
						onChange={(e) => onScopeChange(e.target.checked, scopeText)}
					/>
					Title
				</label>
				<label className="find-scope">
					<input
						type="checkbox"
						checked={scopeText}
						onChange={(e) => onScopeChange(scopeTitle, e.target.checked)}
					/>
					Text
				</label>
				<label className="find-scope" title="Match the exact case">
					<input
						type="checkbox"
						checked={caseSensitive}
						onChange={(e) => onCaseChange(e.target.checked)}
					/>
					Match case
				</label>
				<label
					className="find-scope"
					title="Search the raw HTML source of the Text column — lets you find/replace markup such as <a> tags"
				>
					<input
						type="checkbox"
						checked={raw}
						onChange={(e) => onRawChange(e.target.checked)}
					/>
					Raw
				</label>
			</span>
			<span className="find-count">{countLabel}</span>
			<button
				className="icon"
				onClick={onPrev}
				disabled={!canAct}
				title="Previous match (Shift+Enter)"
			>
				↑
			</button>
			<button
				className="icon"
				onClick={onNext}
				disabled={!canAct}
				title="Next match (Enter)"
			>
				↓
			</button>
			<span className="find-sep"></span>
			<button onClick={onReplace} disabled={!canAct} title="Replace the active match">
				Replace
			</button>
			<button onClick={onReplaceAll} disabled={!canAct} title="Replace every match">
				Replace All
			</button>
			<span className="find-sep"></span>
			<button className="icon" onClick={onClose} title="Close (Esc)">
				×
			</button>
		</div>
	);
}
