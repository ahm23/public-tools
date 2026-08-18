import { useMemo, useState } from "react";
import type { SpecBlock } from "../../shared/rpcSchema";

interface TreeNode {
	index: number;
	block: SpecBlock;
	children: TreeNode[];
	itemCount: number;
}

interface NavTreeProps {
	blocks: SpecBlock[];
	selectedIndex: number | null;
	onSelect: (index: number) => void;
}

/** Build the heading tree from the flat block list. */
function buildTree(blocks: SpecBlock[]): TreeNode[] {
	const roots: TreeNode[] = [];
	const stack: TreeNode[] = [];

	const attach = (node: TreeNode) => {
		let parent: TreeNode | undefined;
		while (stack.length > 0) {
			const top = stack[stack.length - 1];
			if (top.block.type === "heading" && top.block.level < (node.block as { level: number }).level) {
				parent = top;
				break;
			}
			stack.pop();
		}
		if (parent) parent.children.push(node);
		else roots.push(node);
		stack.push(node);
	};

	for (let i = 0; i < blocks.length; i++) {
		const block = blocks[i];
		const node: TreeNode = { index: i, block, children: [], itemCount: 0 };
		if (block.type === "heading") {
			attach(node);
		} else {
			let parent: TreeNode | undefined;
			while (stack.length > 0) {
				const top = stack[stack.length - 1];
				if (top.block.type === "heading") {
					parent = top;
					break;
				}
				stack.pop();
			}
			if (parent) {
				parent.children.push(node);
				parent.itemCount += 1;
			} else {
				roots.push(node);
			}
		}
	}
	return roots;
}

function itemLabel(block: SpecBlock): string {
	if (block.type !== "item") return "";
	const firstLine = block.text.split("\n")[0].trim();
	if (block.id) return firstLine ? `[${block.id}] ${firstLine}` : `[${block.id}]`;
	return firstLine || "(empty)";
}

function NodeRow({
	node,
	depth,
	selectedIndex,
	collapsed,
	onToggle,
	onSelect,
}: {
	node: TreeNode;
	depth: number;
	selectedIndex: number | null;
	collapsed: Set<number>;
	onToggle: (index: number) => void;
	onSelect: (index: number) => void;
}) {
	const block = node.block;
	const isHeading = block.type === "heading";
	const isCollapsed = collapsed.has(node.index);
	const hasChildren = node.children.length > 0;
	const cls = [
		"tree-row",
		isHeading ? "heading" : "item",
		block.type === "item" && block.kind === "requirement" ? "req" : "",
		selectedIndex === node.index ? "active" : "",
	].join(" ");

	return (
		<li className="tree-node">
			<div
				className={cls}
				style={{ paddingLeft: `${8 + depth * 14}px` }}
				onClick={() => onSelect(node.index)}
			>
				{hasChildren ? (
					<span className="chevron" onClick={(e) => { e.stopPropagation(); onToggle(node.index); }}>
						{isCollapsed ? "▸" : "▾"}
					</span>
				) : (
					<span className="chevron placeholder">•</span>
				)}
				{isHeading ? (
					<>
						<span className="label">{block.title || "(untitled)"}</span>
						{node.itemCount > 0 && <span className="badge">{node.itemCount}</span>}
					</>
				) : block.type === "item" && block.kind === "requirement" ? (
					<>
						{block.id && <span className="req-id">{block.id}</span>}
						<span className="label">{itemLabel(block)}</span>
					</>
				) : (
					<span className="label">{itemLabel(block)}</span>
				)}
			</div>
			{hasChildren && !isCollapsed && (
				<ul className="tree-children">
					{node.children.map((child) => (
						<NodeRow
							key={child.index}
							node={child}
							depth={depth + 1}
							selectedIndex={selectedIndex}
							collapsed={collapsed}
							onToggle={onToggle}
							onSelect={onSelect}
						/>
					))}
				</ul>
			)}
		</li>
	);
}

export default function NavTree({ blocks, selectedIndex, onSelect }: NavTreeProps) {
	const tree = useMemo(() => buildTree(blocks), [blocks]);
	const [collapsed, setCollapsed] = useState<Set<number>>(new Set());

	const toggle = (index: number) => {
		setCollapsed((prev) => {
			const next = new Set(prev);
			if (next.has(index)) next.delete(index);
			else next.add(index);
			return next;
		});
	};

	return (
		<nav className="nav-pane">
			<h2>Document Outline</h2>
			<ul style={{ listStyle: "none" }}>
				{tree.map((node) => (
					<NodeRow
						key={node.index}
						node={node}
						depth={0}
						selectedIndex={selectedIndex}
						collapsed={collapsed}
						onToggle={toggle}
						onSelect={onSelect}
					/>
				))}
			</ul>
			{tree.length === 0 && (
				<div style={{ color: "var(--text-dim)", padding: "8px", fontSize: "12px" }}>
					No headings yet. Add one with the toolbar button.
				</div>
			)}
		</nav>
	);
}
