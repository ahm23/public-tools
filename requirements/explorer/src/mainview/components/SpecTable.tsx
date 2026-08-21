import { useState, type DragEvent, type MouseEvent as ReactMouseEvent } from "react";
import type { WcNode } from "../../shared/rpcSchema";
import { computeSections } from "../../shared/rpcSchema";
import EditableCell from "./EditableCell";
import RichTextEditor from "./RichTextEditor";

export type EditField = "title" | "reqId" | "text";

/** Where a dragged block should be inserted, relative to an anchor row that survives the move. */
export type MoveTarget =
	| { parentId: string | null; anchorId: string; pos: "before" | "after" }
	| { parentId: string | null; anchorId: null; pos: "end" };

interface FlatRow {
	node: WcNode;
	parentId: string | null;
	index: number;
}

interface SpecTableProps {
	nodes: WcNode[];
	selectedIds: string[];
	onSelectOne: (id: string) => void;
	onSelectToggle: (id: string) => void;
	onSelectRange: (ids: string[]) => void;
	onCommitEdit: (id: string, field: EditField, value: string) => void;
	onMoveNodes: (nodeIds: string[], target: MoveTarget) => void;
	matchIds: Set<string>;
	activeMatchId: string | null;
}

/** Depth-first flatten with parent + sibling index; collapsed sections are skipped. */
function flatten(nodes: WcNode[], collapsed: Set<string>): FlatRow[] {
	const out: FlatRow[] = [];
	const walk = (list: WcNode[], parentId: string | null) => {
		list.forEach((node, index) => {
			out.push({ node, parentId, index });
			if (!collapsed.has(node.id)) walk(node.children, node.id);
		});
	};
	walk(nodes, null);
	return out;
}

function chipClass(category: string): string {
	if (category === "Heading") return "type-heading";
	if (category === "Comment") return "type-comment";
	return "type-req";
}

/** Sentinel used for the "after the last row" drop zone. */
const END_ZONE = "__end__";

export default function SpecTable({
	nodes,
	selectedIds,
	onSelectOne,
	onSelectToggle,
	onSelectRange,
	onCommitEdit,
	onMoveNodes,
	matchIds,
	activeMatchId,
}: SpecTableProps) {
	const sections = computeSections(nodes);
	const [draggingIds, setDraggingIds] = useState<Set<string> | null>(null);
	const [anchorId, setAnchorId] = useState<string | null>(null);
	const [dragHover, setDragHover] = useState<{
		targetId: string;
		pos: "before" | "after" | "child";
	} | null>(null);
	const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
	const [editingText, setEditingText] = useState<{ id: string; html: string } | null>(null);
	const rows = flatten(nodes, collapsed);

	const parentOf = new Map<string, string | null>();
	for (const r of rows) parentOf.set(r.node.id, r.parentId);

	const toggleCollapse = (id: string) => {
		setCollapsed((prev) => {
			const next = new Set(prev);
			if (next.has(id)) next.delete(id);
			else next.add(id);
			return next;
		});
	};

	/** True when `targetId` sits inside the currently dragged node's subtree. */
	const isDescendantOfDragged = (targetId: string): boolean => {
		if (!draggingIds) return false;
		let cur = parentOf.get(targetId) ?? null;
		while (cur !== null) {
			if (draggingIds.has(cur)) return true;
			cur = parentOf.get(cur) ?? null;
		}
		return false;
	};

	/** Clicking a row: plain replaces the selection, ctrl/cmd toggles, shift range-selects. */
	const handleRowClick = (e: ReactMouseEvent, nodeId: string) => {
		if (e.shiftKey) {
			if (anchorId && anchorId !== nodeId) {
				const flatIds = rows.map((r) => r.node.id);
				const a = flatIds.indexOf(anchorId);
				const b = flatIds.indexOf(nodeId);
				if (a >= 0 && b >= 0) {
					const [lo, hi] = a < b ? [a, b] : [b, a];
					onSelectRange(flatIds.slice(lo, hi + 1));
					setAnchorId(nodeId);
					return;
				}
			}
			onSelectOne(nodeId);
			setAnchorId(nodeId);
			return;
		}
		if (e.ctrlKey || e.metaKey) {
			onSelectToggle(nodeId);
			setAnchorId(nodeId);
			return;
		}
		onSelectOne(nodeId);
		setAnchorId(nodeId);
	};

	/** Drag the row alone if it is not selected, otherwise drag the whole selection. */
	const handleDragStart = (e: DragEvent<HTMLSpanElement>, nodeId: string) => {
		const dragSet = new Set(
			selectedIds.includes(nodeId) ? selectedIds : [nodeId],
		);
		if (!selectedIds.includes(nodeId)) onSelectOne(nodeId);
		e.dataTransfer.setData("text/plain", JSON.stringify([...dragSet]));
		e.dataTransfer.effectAllowed = "move";
		setDraggingIds(dragSet);
	};

	const handleDragEnd = () => {
		setDraggingIds(null);
		setDragHover(null);
	};

	const clearHover = () => setDragHover(null);

	const handleRowDragOver = (e: DragEvent<HTMLDivElement>, row: FlatRow) => {
		if (!draggingIds || draggingIds.has(row.node.id)) return;
		if (isDescendantOfDragged(row.node.id)) return;
		e.preventDefault();
		e.dataTransfer.dropEffect = "move";
		const rect = e.currentTarget.getBoundingClientRect();
		const pos =
			e.clientY > rect.top + rect.height / 2 ? "after" : "before";
		setDragHover((prev) =>
			prev && prev.targetId === row.node.id && prev.pos === pos
				? prev
				: { targetId: row.node.id, pos },
		);
	};

	const handleRowDrop = (e: DragEvent<HTMLDivElement>, row: FlatRow) => {
		e.preventDefault();
		const ids = draggingIds ? [...draggingIds] : [];
		if (
			ids.length === 0 ||
			ids.includes(row.node.id) ||
			isDescendantOfDragged(row.node.id)
		) {
			setDraggingIds(null);
			setDragHover(null);
			return;
		}
		const rect = e.currentTarget.getBoundingClientRect();
		const pos =
			dragHover && dragHover.targetId === row.node.id
				? dragHover.pos
				: e.clientY > rect.top + rect.height / 2
					? "after"
					: "before";
		onMoveNodes(ids, {
			parentId: row.parentId,
			anchorId: row.node.id,
			pos,
		});
		setDraggingIds(null);
		setDragHover(null);
	};

	const handleEndDragOver = (e: DragEvent<HTMLDivElement>) => {
		if (!draggingIds) return;
		e.preventDefault();
		e.dataTransfer.dropEffect = "move";
		setDragHover((prev) =>
			prev && prev.targetId === END_ZONE
				? prev
				: { targetId: END_ZONE, pos: "after" },
		);
	};

	const handleEndDrop = (e: DragEvent<HTMLDivElement>) => {
		e.preventDefault();
		const ids = draggingIds ? [...draggingIds] : [];
		if (ids.length === 0) {
			setDraggingIds(null);
			setDragHover(null);
			return;
		}
		// Anchor on the last visible row that is not part of the drag, so the
		// block lands at the true end of the list.
		const surviving = [...rows]
			.reverse()
			.find(
				(r) =>
					!ids.includes(r.node.id) &&
					!isDescendantOfDragged(r.node.id),
			);
		if (surviving) {
			onMoveNodes(ids, {
				parentId: surviving.parentId,
				anchorId: surviving.node.id,
				pos: "after",
			});
		} else {
			onMoveNodes(ids, { parentId: null, anchorId: null, pos: "end" });
		}
		setDraggingIds(null);
		setDragHover(null);
	};

	const handleHandleDragOver = (e: DragEvent<HTMLSpanElement>, node: WcNode) => {
		if (!draggingIds || draggingIds.has(node.id)) return;
		if (isDescendantOfDragged(node.id)) return;
		e.preventDefault();
		e.stopPropagation();
		e.dataTransfer.dropEffect = "move";
		setDragHover((prev) =>
			prev && prev.targetId === node.id && prev.pos === "child"
				? prev
				: { targetId: node.id, pos: "child" },
		);
	};

	const handleHandleDrop = (e: DragEvent<HTMLSpanElement>, node: WcNode) => {
		e.preventDefault();
		e.stopPropagation();
		const ids = draggingIds ? [...draggingIds] : [];
		if (
			ids.length === 0 ||
			ids.includes(node.id) ||
			isDescendantOfDragged(node.id)
		) {
			setDraggingIds(null);
			setDragHover(null);
			return;
		}
		onMoveNodes(ids, { parentId: node.id, anchorId: null, pos: "end" });
		setDraggingIds(null);
		setDragHover(null);
	};

	return (
		<div className="table-wrap">
			<div className="grid-table">
				<div className="grid-head">
					<div className="gc col-section">Section</div>
					<div className="gc col-id">WCID</div>
					<div className="gc col-reqid">Req. ID</div>
					<div className="gc col-title">Title</div>
					<div className="gc col-type">Category</div>
					<div className="gc col-text">Text</div>
					<div className="gc col-actions"></div>
				</div>
				{rows.map((row) => {
					const { node } = row;
					const hasChildren = node.children.length > 0;
					const category = node.category || "Requirement";
					const hoverPos =
						dragHover && dragHover.targetId === node.id
							? dragHover.pos
							: null;
					const rowClass = [
						"grid-row",
						hasChildren ? "row-heading" : "row-item",
						selectedIds.includes(node.id) ? "selected" : "",
						draggingIds?.has(node.id) ? "dragging" : "",
						matchIds.has(node.id) ? "find-match" : "",
						activeMatchId === node.id ? "find-match-active" : "",
						hoverPos === "before"
							? "drop-before"
							: hoverPos === "after"
								? "drop-after"
								: hoverPos === "child"
									? "drop-child"
									: "",
					].join(" ");
					return (
						<div
							key={node.id}
							id={`wc-row-${node.id}`}
							className={rowClass}
							onClick={(e) => handleRowClick(e, node.id)}
							onDragOver={(e) => handleRowDragOver(e, row)}
							onDrop={(e) => handleRowDrop(e, row)}
							onDragLeave={(e) => {
								const rel = e.relatedTarget as Node | null;
								if (!rel || !e.currentTarget.contains(rel)) clearHover();
							}}
						>
							<div className="gc col-section">
								{hasChildren && (
									<span
										className="collapse-chevron"
										title={
											collapsed.has(node.id)
												? "Expand section"
												: "Collapse section"
										}
										onClick={(e) => {
											e.stopPropagation();
											toggleCollapse(node.id);
										}}
									>
										{collapsed.has(node.id) ? "▸" : "▾"}
									</span>
								)}
								{sections.get(node.id) ?? ""}
							</div>
							<div className="gc col-id" title={node.id}>
								{node.id}
							</div>
							<div className="gc col-reqid">
								<EditableCell
									value={node.reqId}
									placeholder=""
									onCommit={(v) => onCommitEdit(node.id, "reqId", v)}
								/>
							</div>
							<div className="gc col-title">
								<EditableCell
									value={node.title}
									placeholder="Title"
									onCommit={(v) => onCommitEdit(node.id, "title", v)}
								/>
							</div>
							<div className="gc col-type">
								<span className={chipClass(category)}>{category}</span>
							</div>
							<div
								className="gc col-text"
								title="Click to edit"
								onClick={(e) => {
									e.stopPropagation();
									setEditingText({ id: node.id, html: node.text });
								}}
							>
								{node.text ? (
									<div
										className="rich-content"
										dangerouslySetInnerHTML={{ __html: node.text }}
									/>
								) : (
									<span className="placeholder-text">Text…</span>
								)}
							</div>
							<div className="gc col-actions">
								<span
									className="drag-handle"
									draggable
									title="Drag to reorder (all selected rows move together); drop here to make it a child"
									onDragStart={(e) => handleDragStart(e, node.id)}
									onDragEnd={handleDragEnd}
									onDragOver={(e) => handleHandleDragOver(e, node)}
									onDrop={(e) => handleHandleDrop(e, node)}
								>
									⠿
								</span>
							</div>
						</div>
					);
				})}
				<div
					className={`grid-drop-end${dragHover && dragHover.targetId === END_ZONE ? " drop-active" : ""}`}
					onDragOver={handleEndDragOver}
					onDrop={handleEndDrop}
					onDragLeave={clearHover}
				/>
				{rows.length === 0 && (
					<div
						style={{
							padding: 24,
							color: "var(--text-dim)",
							textAlign: "center",
						}}
					>
						No data yet. Import a Windchill document or add a node.
					</div>
				)}
				{editingText && (
					<RichTextEditor
						initialHtml={editingText.html}
						nodes={nodes}
						onClose={() => setEditingText(null)}
						onSave={(html) => {
							onCommitEdit(editingText.id, "text", html);
							setEditingText(null);
						}}
					/>
				)}
			</div>
		</div>
	);
}