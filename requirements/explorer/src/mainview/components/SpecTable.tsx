import type { CSSProperties } from "react";
import type { SpecBlock } from "../../shared/rpcSchema";
import { itemKind } from "../../shared/rpcSchema";
import EditableCell from "./EditableCell";

export type EditField = "title" | "id" | "text";

interface SpecTableProps {
	blocks: SpecBlock[];
	selectedIndex: number | null;
	onSelect: (index: number) => void;
	onCommitEdit: (index: number, field: EditField, value: string) => void;
	onAddBelow: (index: number) => void;
	onDelete: (index: number) => void;
}

/** Per-block indentation depth (heading level minus one, items inherit current section). */
function computeIndents(blocks: SpecBlock[]): number[] {
	const indents: number[] = [];
	let depth = 0;
	for (const b of blocks) {
		if (b.type === "heading") {
			depth = Math.max(0, b.level - 1);
			indents.push(depth);
		} else {
			indents.push(depth);
		}
	}
	return indents;
}

export default function SpecTable({
	blocks,
	selectedIndex,
	onSelect,
	onCommitEdit,
	onAddBelow,
	onDelete,
}: SpecTableProps) {
	const indents = computeIndents(blocks);

	return (
		<div className="table-wrap">
			<table className="spec">
				<thead>
					<tr>
						<th>Title</th>
						<th>Type</th>
						<th>External ID</th>
						<th>Text</th>
						<th style={{ width: 60 }}></th>
					</tr>
				</thead>
				<tbody>
					{blocks.map((block, i) => {
						const isHeading = block.type === "heading";
						const kind = isHeading ? "heading" : itemKind(block.id, block.text);
						const isComment = !isHeading && kind === "comment";
						const rowClass = [
							"spec-row",
							isHeading ? "row-heading" : "row-item",
							isComment ? "row-comment" : "",
							selectedIndex === i ? "selected" : "",
						].join(" ");
						const indent = `${indents[i] * 14}px`;

						return (
							<tr
								key={i}
								id={`spec-row-${i}`}
								className={rowClass}
								style={{ "--indent": indent } as CSSProperties}
								onClick={() => onSelect(i)}
							>
								<td className="col-title">
									{block.type === "heading" ? (
										<EditableCell
											value={block.title}
											placeholder="Heading title"
											onCommit={(v) => onCommitEdit(i, "title", v)}
										/>
									) : (
										<span className="placeholder-text"></span>
									)}
								</td>
								<td className="col-type">
									<span
										className={
											isHeading ? "type-heading" : isComment ? "type-comment" : "type-req"
										}
									>
										{isHeading ? "Heading" : kind === "requirement" ? "Requirement" : "Comment"}
									</span>
								</td>
								<td className="col-id">
									{block.type === "heading" ? (
										<span className="placeholder-text">—</span>
									) : (
										<EditableCell
											value={block.id}
											placeholder="REQ1234"
											onCommit={(v) => onCommitEdit(i, "id", v)}
										/>
									)}
								</td>
								<td className="col-text">
									{block.type === "heading" ? (
										<span className="placeholder-text"></span>
									) : (
										<EditableCell
											value={block.text}
											multiline
											placeholder="Requirement text…"
											onCommit={(v) => onCommitEdit(i, "text", v)}
										/>
									)}
								</td>
								<td className="col-actions">
									<div className="row-actions">
										<button
											className="icon"
											title="Add requirement below"
											onClick={(e) => {
												e.stopPropagation();
												onAddBelow(i);
											}}
										>
											+
										</button>
										<button
											className="icon"
											title="Delete row"
											onClick={(e) => {
												e.stopPropagation();
												onDelete(i);
											}}
										>
											×
										</button>
									</div>
								</td>
							</tr>
						);
					})}
					{blocks.length === 0 && (
						<tr>
							<td
								colSpan={5}
								style={{ padding: 24, color: "var(--text-dim)", textAlign: "center" }}
							>
								Empty specification. Import a DOCX/XLSX or add a heading to start.
							</td>
						</tr>
					)}
				</tbody>
			</table>
		</div>
	);
}
