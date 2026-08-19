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

/** Section number per block: headings only ("1", "1.1", …); items get none. */
function computeSections(blocks: SpecBlock[]): (string | null)[] {
	const out: (string | null)[] = [];
	const counters: number[] = [];
	for (const b of blocks) {
		if (b.type === "heading") {
			const level = b.level;
			counters[level] = (counters[level] ?? 0) + 1;
			for (let l = level + 1; l < counters.length; l++) counters[l] = 0;
			const parts: number[] = [];
			for (let l = 1; l <= level; l++) parts.push(counters[l] ?? 0);
			out.push(parts.join("."));
		} else {
			out.push(null);
		}
	}
	return out;
}

export default function SpecTable({
	blocks,
	selectedIndex,
	onSelect,
	onCommitEdit,
	onAddBelow,
	onDelete,
}: SpecTableProps) {
	const sections = computeSections(blocks);

	return (
		<div className="table-wrap">
			<table className="spec">
				<thead>
					<tr>
						<th className="col-section">Section</th>
						<th>ID</th>
						<th>Title</th>
						<th className="col-type">Type</th>
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

						return (
							<tr
								key={i}
								id={`spec-row-${i}`}
								className={rowClass}
								onClick={() => onSelect(i)}
							>
								<td className="col-section">{sections[i] ?? ""}</td>
								<td className="col-id">
									{block.type === "heading" ? (
										<span className="placeholder-text">—</span>
									) : (
										<EditableCell
											value={block.id}
											placeholder=""
											onCommit={(v) => onCommitEdit(i, "id", v)}
										/>
									)}
								</td>
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
								colSpan={6}
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