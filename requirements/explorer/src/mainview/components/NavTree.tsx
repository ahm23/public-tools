import { useState } from "react";
import type { WcNode } from "../../shared/rpcSchema";

interface NavTreeProps {
	nodes: WcNode[];
	selectedId: string | null;
	onSelect: (id: string) => void;
}

function NodeRow({
	node,
	selectedId,
	collapsed,
	onToggle,
	onSelect,
}: {
	node: WcNode;
	selectedId: string | null;
	collapsed: Set<string>;
	onToggle: (id: string) => void;
	onSelect: (id: string) => void;
}) {
	const hasChildren = node.children.length > 0;
	const cls = [
		"tree-row",
		hasChildren ? "heading" : "item",
		selectedId === node.id ? "active" : "",
	].join(" ");
	const label = node.title || node.text.split("\n")[0].trim() || "(untitled)";

	return (
		<li className="tree-node">
			<div className={cls} onClick={() => onSelect(node.id)}>
				{hasChildren ? (
					<span
						className="chevron"
						onClick={(e) => {
							e.stopPropagation();
							onToggle(node.id);
						}}
					>
						{collapsed.has(node.id) ? "▸" : "▾"}
					</span>
				) : (
					<span className="chevron placeholder">•</span>
				)}
				{node.id && <span className="req-id">{node.id}</span>}
				<span className="label">{label}</span>
				{hasChildren && <span className="badge">{node.children.length}</span>}
			</div>
			{hasChildren && !collapsed.has(node.id) && (
				<ul className="tree-children">
					{node.children.map((child) => (
						<NodeRow
							key={child.id}
							node={child}
							selectedId={selectedId}
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

export default function NavTree({ nodes, selectedId, onSelect }: NavTreeProps) {
	const [collapsed, setCollapsed] = useState<Set<string>>(new Set());

	const toggle = (id: string) => {
		setCollapsed((prev) => {
			const next = new Set(prev);
			if (next.has(id)) next.delete(id);
			else next.add(id);
			return next;
		});
	};

	return (
		<nav className="nav-pane">
			<h2>Document Outline</h2>
			<ul style={{ listStyle: "none" }}>
				{nodes.map((node) => (
					<NodeRow
						key={node.id}
						node={node}
						selectedId={selectedId}
						collapsed={collapsed}
						onToggle={toggle}
						onSelect={onSelect}
					/>
				))}
			</ul>
			{nodes.length === 0 && (
				<div style={{ color: "var(--text-dim)", padding: "8px", fontSize: "12px" }}>
					No data yet. Import a Windchill document to get started.
				</div>
			)}
		</nav>
	);
}
