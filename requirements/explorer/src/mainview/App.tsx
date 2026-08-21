import { useEffect, useMemo, useRef, useState } from "react";
import type { SpecDoc, WcNode } from "../shared/rpcSchema";
import { emptySpec } from "../shared/rpcSchema";
import { ipc } from "./ipc";
import FindBar from "./components/FindBar";
import Modal from "./components/Modal";
import NavTree from "./components/NavTree";
import SpecTable, { type EditField, type MoveTarget } from "./components/SpecTable";
import {
	findMatches,
	replaceAll as replaceAllInField,
	replaceFirst as replaceFirstInField,
	type FindColumn,
} from "./search";
import { postEdit, postEdits, postMove, type EditEvent } from "./editPost";

type ModalKind = "import" | null;

let localIdCounter = 0;
function nextLocalId(): string {
	localIdCounter += 1;
	return `LOCAL${localIdCounter}`;
}

/** Immutable tree helpers, keyed by node id. */
function mapNode(
	nodes: WcNode[],
	id: string,
	fn: (n: WcNode) => WcNode,
): WcNode[] {
	return nodes.map((n) =>
		n.id === id ? fn(n) : { ...n, children: mapNode(n.children, id, fn) },
	);
}

function removeNode(nodes: WcNode[], id: string): WcNode[] {
	return nodes
		.filter((n) => n.id !== id)
		.map((n) => ({ ...n, children: removeNode(n.children, id) }));
}

/** Remove `id` from the tree, returning the removed node and the new tree. */
function extractNode(
	nodes: WcNode[],
	id: string,
): {
	node: WcNode;
	without: WcNode[];
	oldParentId: string | null;
	oldIndex: number;
} | null {
	for (let i = 0; i < nodes.length; i++) {
		const n = nodes[i];
		if (n.id === id) {
			return {
				node: n,
				without: [...nodes.slice(0, i), ...nodes.slice(i + 1)],
				oldParentId: null,
				oldIndex: i,
			};
		}
		const sub = extractNode(n.children, id);
		if (sub) {
			return {
				...sub,
				oldParentId: sub.oldParentId ?? n.id,
				without: nodes.map((m, k) =>
					k === i ? { ...n, children: sub.without } : m,
				),
			};
		}
	}
	return null;
}

/** Insert `block` into `parentId`'s children at `index` (null parent = roots). */
function insertNodesAt(
	nodes: WcNode[],
	parentId: string | null,
	index: number,
	block: WcNode[],
): WcNode[] {
	if (block.length === 0) return nodes;
	if (parentId === null) {
		const copy = [...nodes];
		const at = Math.max(0, Math.min(index, copy.length));
		copy.splice(at, 0, ...block);
		return copy;
	}
	return nodes.map((n) =>
		n.id === parentId
			? { ...n, children: insertNodesAt(n.children, null, index, block) }
			: { ...n, children: insertNodesAt(n.children, parentId, index, block) },
	);
}

/** Insert a single `node` into `parentId`'s children at `index`. */
function insertNodeAt(
	nodes: WcNode[],
	parentId: string | null,
	index: number,
	node: WcNode,
): WcNode[] {
	return insertNodesAt(nodes, parentId, index, [node]);
}

/** id -> parent id for the whole tree. */
function buildParentMap(
	nodes: WcNode[],
	map: Map<string, string | null> = new Map(),
	parent: string | null = null,
): Map<string, string | null> {
	for (const n of nodes) {
		map.set(n.id, parent);
		buildParentMap(n.children, map, n.id);
	}
	return map;
}

/** Keep only ids that are not inside another id's subtree. */
function topmostIds(nodes: WcNode[], ids: string[]): string[] {
	const parentMap = buildParentMap(nodes);
	const set = new Set(ids);
	return ids.filter((id) => {
		let cur = parentMap.get(id) ?? null;
		while (cur !== null) {
			if (set.has(cur)) return false;
			cur = parentMap.get(cur) ?? null;
		}
		return true;
	});
}

/** Find a node by id anywhere in the tree. */
function findNode(nodes: WcNode[], id: string): WcNode | null {
	for (const n of nodes) {
		if (n.id === id) return n;
		const sub = findNode(n.children, id);
		if (sub) return sub;
	}
	return null;
}

/** Apply a batch of title/text edits to the tree in a single pass. */
function applyUpdates(
	nodes: WcNode[],
	updates: Map<string, { title?: string; text?: string }>,
): WcNode[] {
	return nodes.map((n) => {
		const u = updates.get(n.id);
		const next = u
			? {
					...n,
					...(u.title !== undefined ? { title: u.title } : {}),
					...(u.text !== undefined ? { text: u.text } : {}),
				}
			: n;
		return { ...next, children: applyUpdates(n.children, updates) };
	});
}

/** Parent + sibling index of `id`, or null if not found. */
function findPosition(
	nodes: WcNode[],
	id: string,
): { parentId: string | null; index: number } | null {
	for (let i = 0; i < nodes.length; i++) {
		if (nodes[i].id === id) return { parentId: null, index: i };
		const sub = findPosition(nodes[i].children, id);
		if (sub) return { parentId: nodes[i].id, index: sub.index };
	}
	return null;
}

interface MoveInfo {
	nodeIds: string[];
	oldPositions: { parentId: string | null; index: number }[];
	target: MoveTarget;
}

function countNodes(nodes: WcNode[]): {
	total: number;
	headings: number;
	requirements: number;
	comments: number;
} {
	const c = { total: 0, headings: 0, requirements: 0, comments: 0 };
	const walk = (list: WcNode[]) => {
		for (const n of list) {
			c.total += 1;
			if (n.category === "Heading") c.headings += 1;
			else if (n.category === "Comment") c.comments += 1;
			else c.requirements += 1;
			walk(n.children);
		}
	};
	walk(nodes);
	return c;
}

export default function App() {
	const [spec, setSpec] = useState<SpecDoc>(emptySpec());
	const [path, setPath] = useState("");
	const [dirty, setDirty] = useState(false);
	const [selectedIds, setSelectedIds] = useState<string[]>([]);
	const [findOpen, setFindOpen] = useState(false);
	const [findQuery, setFindQuery] = useState("");
	const [replaceQuery, setReplaceQuery] = useState("");
	const [findScope, setFindScope] = useState({ title: true, text: true, caseSensitive: false, raw: false });
	const [matchIndex, setMatchIndex] = useState(0);
	const findInputRef = useRef<HTMLInputElement>(null);
	const [modal, setModal] = useState<ModalKind>(null);
	const [busy, setBusy] = useState(false);
	const [status, setStatus] = useState("");
	const [error, setError] = useState<string | null>(null);

	const counts = useMemo(() => countNodes(spec.nodes), [spec.nodes]);
	const primaryId =
		selectedIds.length > 0 ? selectedIds[selectedIds.length - 1] : null;

	const mutate = (fn: (nodes: WcNode[]) => WcNode[]) => {
		setSpec((prev) => ({ ...prev, nodes: fn(prev.nodes) }));
		setDirty(true);
		setError(null);
	};

	const flash = (msg: string) => {
		setStatus(msg);
		window.setTimeout(() => setStatus((s) => (s === msg ? "" : s)), 4000);
	};

	const fail = (msg: string) => {
		setError(msg);
		setBusy(false);
	};

	const scrollToRow = (id: string) => {
		document
			.getElementById(`wc-row-${id}`)
			?.scrollIntoView({ block: "nearest" });
	};

	const selectOne = (id: string) => {
		setSelectedIds([id]);
		scrollToRow(id);
	};

	const selectToggle = (id: string) => {
		setSelectedIds((prev) =>
			prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id],
		);
		scrollToRow(id);
	};

	const selectRange = (ids: string[]) => {
		setSelectedIds(ids);
		if (ids.length > 0) scrollToRow(ids[ids.length - 1]);
	};

	const commitEdit = (id: string, field: EditField, value: string) => {
		postEdit(id, field, value);
		mutate((nodes) =>
			mapNode(nodes, id, (n) => {
				if (field === "title") return { ...n, title: value };
				if (field === "reqId") return { ...n, reqId: value };
				return { ...n, text: value };
			}),
		);
	};

	// ------------------------------------------------------------ find

	const findMatchesList = useMemo(
		() => findMatches(spec.nodes, findQuery, findScope),
		[spec.nodes, findQuery, findScope.title, findScope.text, findScope.caseSensitive, findScope.raw],
	);
	const activeMatch =
		findMatchesList.length > 0
			? findMatchesList[Math.min(matchIndex, findMatchesList.length - 1)]
			: null;
	const matchIds = useMemo(
		() =>
			findOpen
				? new Set(findMatchesList.map((m) => m.nodeId))
				: new Set<string>(),
		[findOpen, findMatchesList],
	);

	// Reset to the first match when the query or scope changes.
	useEffect(() => {
		setMatchIndex(0);
	}, [findQuery, findScope.title, findScope.text, findScope.caseSensitive, findScope.raw]);

	// Keep the active match in view while the find bar is open.
	useEffect(() => {
		if (findOpen && activeMatch) scrollToRow(activeMatch.nodeId);
	}, [findOpen, activeMatch?.nodeId]);

	// Focus the find input when the bar opens.
	useEffect(() => {
		if (findOpen) findInputRef.current?.focus();
	}, [findOpen]);

	// Ctrl/Cmd+F opens the find bar.
	useEffect(() => {
		const onKey = (e: KeyboardEvent) => {
			if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "f") {
				e.preventDefault();
				setFindOpen(true);
			}
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, []);

	const findNext = () => {
		if (findMatchesList.length === 0) return;
		setMatchIndex((i) => (i + 1) % findMatchesList.length);
	};

	const findPrev = () => {
		if (findMatchesList.length === 0) return;
		setMatchIndex(
			(i) => (i - 1 + findMatchesList.length) % findMatchesList.length,
		);
	};

	const replaceCurrent = () => {
		if (!activeMatch || !findQuery.trim()) return;
		const node = findNode(spec.nodes, activeMatch.nodeId);
		if (!node) return;
		const field: FindColumn = activeMatch.column;
		const current = field === "title" ? node.title : node.text;
		const next = replaceFirstInField(field, current, findQuery, replaceQuery, findScope.caseSensitive, findScope.raw);
		if (next !== current) {
			commitEdit(activeMatch.nodeId, field, next);
			flash(field === "title" ? "Replaced in Title" : "Replaced in Text");
		}
		// Advance; the match list shrinks if the active field no longer matches.
		setMatchIndex((i) => Math.min(i, findMatchesList.length - 1));
	};

	const replaceEverywhere = () => {
		const q = findQuery.trim();
		if (!q || findMatchesList.length === 0) return;
		const updates = new Map<string, { title?: string; text?: string }>();
		let total = 0;
		for (const m of findMatchesList) {
			const node = findNode(spec.nodes, m.nodeId);
			if (!node) continue;
			const field: FindColumn = m.column;
			const current = field === "title" ? node.title : node.text;
			const res = replaceAllInField(field, current, q, replaceQuery, findScope.caseSensitive, findScope.raw);
			if (res.count > 0) {
				const prev = updates.get(m.nodeId) ?? {};
				updates.set(m.nodeId, { ...prev, [field]: res.value });
				total += res.count;
			}
		}
		if (total === 0) return;
		const edits: EditEvent[] = [];
		for (const [nodeId, u] of updates) {
			if (u.title !== undefined) {
				edits.push({ nodeId, field: "title", value: u.title });
			}
			if (u.text !== undefined) {
				edits.push({ nodeId, field: "text", value: u.text });
			}
		}
		mutate((nodes) => applyUpdates(nodes, updates));
		postEdits(edits);
		setMatchIndex(0);
		flash(`Replaced ${total} occurrence${total === 1 ? "" : "s"}`);
	};

	const addBelow = (id: string | null) => {
		const child: WcNode = {
			id: nextLocalId(),
			category: "Requirement",
			title: "",
			text: "",
			reqId: "",
			children: [],
		};
		if (id === null) {
			mutate((nodes) => [...nodes, child]);
		} else {
			const pos = findPosition(spec.nodes, id);
			if (!pos) return;
			mutate((nodes) =>
				insertNodeAt(nodes, pos.parentId, pos.index + 1, child),
			);
		}
		setSelectedIds([child.id]);
		flash(`Added ${child.id}`);
	};

	const requestDelete = async (ids: string[]) => {
		const topmost = topmostIds(spec.nodes, ids);
		const n = topmost.length;
		if (n === 0) return;
		const { confirmed } = await ipc["dialog:confirm"]({
			title: n === 1 ? "Delete node" : `Delete ${n} nodes`,
			message:
				n === 1
					? `Delete node ${topmost[0]}?`
					: `Delete ${n} selected nodes?`,
			detail: "Their children are deleted too. This cannot be undone.",
			confirmLabel: "Delete",
		});
		if (!confirmed) return;
		mutate((nodes) =>
			topmost.reduce((acc, id) => removeNode(acc, id), nodes),
		);
		setSelectedIds((prev) => prev.filter((id) => !topmost.includes(id)));
		flash(n === 1 ? `Deleted ${topmost[0]}` : `Deleted ${n} nodes`);
	};

	/**
	 * Called after rows are moved in the tree.
	 * TODO(user): commit the move to the database (Windchill RV&S) here.
	 */
	const commitMove = (info: MoveInfo) => {
		console.log("[move]", JSON.stringify(info));
		const n = info.nodeIds.length;
		flash(`Moved ${n} node${n === 1 ? "" : "s"}`);
	};

	/** Move a block of nodes as one contiguous unit, keeping their relative order. */
	const moveNodes = (nodeIds: string[], target: MoveTarget) => {
		if (nodeIds.length === 0) return;
		const topmost = topmostIds(spec.nodes, nodeIds);
		if (topmost.length === 0) return;

		// Depth-first order, so the block keeps its on-screen order.
		const order = new Map<string, number>();
		let k = 0;
		const walkOrder = (list: WcNode[]) => {
			for (const n of list) {
				order.set(n.id, k++);
				walkOrder(n.children);
			}
		};
		walkOrder(spec.nodes);
		const sorted = [...topmost].sort((a, b) => order.get(a)! - order.get(b)!);

		// Extract one by one; the anchor row is never part of the drag, so it
		// survives and its position in the pruned tree is the insertion point.
		let tree = spec.nodes;
		const extracted: {
			node: WcNode;
			oldParentId: string | null;
			oldIndex: number;
		}[] = [];
		for (const id of sorted) {
			const ex = extractNode(tree, id);
			if (!ex) continue;
			tree = ex.without;
			extracted.push(ex);
		}
		if (extracted.length === 0) return;

		const block = extracted.map((e) => e.node);
		if (target.pos === "end") {
			tree = insertNodesAt(tree, target.parentId, Number.MAX_SAFE_INTEGER, block);
		} else {
			const anchorPos = findPosition(tree, target.anchorId);
			if (!anchorPos) return;
			const idx = anchorPos.index + (target.pos === "after" ? 1 : 0);
			tree = insertNodesAt(tree, anchorPos.parentId, idx, block);
		}

		if (JSON.stringify(tree) === JSON.stringify(spec.nodes)) {
			return; // dropped back where it was
		}
		mutate(() => tree);
		commitMove({
			nodeIds: sorted,
			oldPositions: extracted.map((e) => ({
				parentId: e.oldParentId,
				index: e.oldIndex,
			})),
			target,
		});
		postMove({ nodeIds: sorted, target, documentId: spec.documentId });
	};

	// ------------------------------------------------------------ file ops

	const save = async () => {
		if (!path) return saveAs();
		setBusy(true);
		try {
			const res = await ipc["spec:save"]({ path, spec });
			if (res.ok) {
				setDirty(false);
				flash(`Saved ${path}`);
			} else fail(res.error ?? "save failed");
		} catch (e) {
			fail(String(e));
		}
		setBusy(false);
	};

	const saveAs = async () => {
		const { path: p } = await ipc["dialog:pickSave"]({ filter: "json" });
		if (!p) return;
		setBusy(true);
		try {
			const res = await ipc["spec:save"]({ path: p, spec });
			if (res.ok) {
				setPath(p);
				setDirty(false);
				flash(`Saved ${p}`);
			} else fail(res.error ?? "save failed");
		} catch (e) {
			fail(String(e));
		}
		setBusy(false);
	};

	const open = async () => {
		const { path: p } = await ipc["dialog:pickOpen"]({ filter: "json" });
		if (!p) return;
		setBusy(true);
		try {
			const st = await ipc["spec:load"]({ path: p });
			setSpec(st.spec);
			setPath(st.path);
			setDirty(false);
			setSelectedIds([]);
			flash(`Opened ${p}`);
		} catch (e) {
			fail(String(e));
		}
		setBusy(false);
	};

	const newDoc = async () => {
		const { confirmed } = await ipc["dialog:confirm"]({
			title: "New specification",
			message: dirty
				? "Discard unsaved changes and start a new specification?"
				: "Start a new empty specification?",
			confirmLabel: "New",
		});
		if (!confirmed) return;
		const st = await ipc["spec:new"]();
		setSpec(st.spec);
		setPath("");
		setDirty(false);
		setSelectedIds([]);
		flash("New empty specification");
	};

	// ------------------------------------------------------------ windchill

	const doImport = async (documentId: string) => {
		setBusy(true);
		try {
			const res = await ipc["spec:importWindchill"]({ documentId });
			if (!res.ok || !res.spec) return fail(res.error ?? "import failed");
			setSpec(res.spec);
			setPath("");
			setDirty(true);
			setSelectedIds([]);
			flash(`Imported ${res.output ?? documentId}`);
			setModal(null);
		} catch (e) {
			fail(String(e));
		}
		setBusy(false);
	};

	// Escape closes modals
	useEffect(() => {
		if (!modal) return;
		const onKey = (e: KeyboardEvent) => {
			if (e.key === "Escape") setModal(null);
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, [modal]);

	// -------------------------------------------------------------------- UI

	return (
		<div className="app">
			<div className="toolbar">
				<button onClick={() => open()} disabled={busy}>
					Open
				</button>
				<button onClick={() => save()} disabled={busy || !dirty}>
					Save
				</button>
				<button onClick={() => saveAs()} disabled={busy}>
					Save As…
				</button>
				<span className="toolbar-sep"></span>
				<button onClick={() => setModal("import")} disabled={busy}>
					Import Windchill…
				</button>
				<span className="toolbar-sep"></span>
				<button
					onClick={() => addBelow(primaryId)}
					disabled={busy}
					title="Add a node below the selected node (or a root node)"
				>
					+ Node
				</button>
				<button
					onClick={() => primaryId !== null && requestDelete(selectedIds)}
					disabled={busy || primaryId === null}
					title="Delete the selected node(s)"
				>
					Delete
				</button>
				<span className="toolbar-sep"></span>
				<button
					onClick={() => setFindOpen((o) => !o)}
					disabled={busy}
					title="Find & replace (Ctrl+F)"
				>
					Find
				</button>
				<span className="spacer"></span>
				<button onClick={() => newDoc()} disabled={busy}>
					New
				</button>
				{path && (
					<span className={`doc-path${dirty ? " dirty" : ""}`} title={path}>
						{path}
						{dirty ? " •" : ""}
					</span>
				)}
			</div>

			{findOpen && (
				<FindBar
					query={findQuery}
					onQueryChange={setFindQuery}
					replaceQuery={replaceQuery}
					onReplaceQueryChange={setReplaceQuery}
					scopeTitle={findScope.title}
					scopeText={findScope.text}
					onScopeChange={(title, text) => setFindScope({ title, text })}
					caseSensitive={findScope.caseSensitive}
					onCaseChange={(v) => setFindScope((s) => ({ ...s, caseSensitive: v }))}
					raw={findScope.raw}
					onRawChange={(v) => setFindScope((s) => ({ ...s, raw: v }))}
					total={findMatchesList.length}
					activeIndex={
						findMatchesList.length > 0
							? Math.min(matchIndex, findMatchesList.length - 1)
							: -1
					}
					onPrev={findPrev}
					onNext={findNext}
					onReplace={replaceCurrent}
					onReplaceAll={replaceEverywhere}
					onClose={() => setFindOpen(false)}
					inputRef={findInputRef}
				/>
			)}

			<div className="main">
				<NavTree
					nodes={spec.nodes}
					selectedId={primaryId}
					onSelect={selectOne}
				/>
				<SpecTable
					nodes={spec.nodes}
					selectedIds={selectedIds}
					onSelectOne={selectOne}
					onSelectToggle={selectToggle}
					onSelectRange={selectRange}
					onCommitEdit={commitEdit}
					onMoveNodes={moveNodes}
					matchIds={matchIds}
					activeMatchId={activeMatch ? activeMatch.nodeId : null}
				/>
			</div>

			<div className="status-bar">
				<span>{counts.total} nodes</span>
				<span>{counts.headings} headings</span>
				<span>{counts.requirements} requirements</span>
				<span>{counts.comments} comments</span>
				<span className="spacer"></span>
				{status && <span>{status}</span>}
				{error && <span className="err">{error}</span>}
			</div>

			{modal === "import" && (
				<ImportModal onClose={() => setModal(null)} onSubmit={doImport} />
			)}
		</div>
	);
}

// ---------------------------------------------------------------------------
// Import modal
// ---------------------------------------------------------------------------

function ImportModal({
	onClose,
	onSubmit,
}: {
	onClose: () => void;
	onSubmit: (documentId: string) => void;
}) {
	const [docId, setDocId] = useState("");

	return (
		<Modal title="Import from Windchill RV&S" onClose={onClose}>
			<div className="field">
				<label>Document ID</label>
				<input
					type="text"
					value={docId}
					placeholder="e.g. 2601094"
					onChange={(e) => setDocId(e.target.value)}
					onKeyDown={(e) => {
						if (e.key === "Enter" && docId.trim()) onSubmit(docId.trim());
					}}
				/>
				<div style={{ fontSize: 12, color: "var(--text-dim)", marginTop: 4 }}>
					Loads the document and its items from Windchill RV&amp;S. Currently
					returns the bundled sample data until the request is implemented.
				</div>
			</div>
			<div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 16 }}>
				<button onClick={onClose}>Cancel</button>
				<button
					className="primary"
					disabled={!docId.trim()}
					onClick={() => onSubmit(docId.trim())}
				>
					Import
				</button>
			</div>
		</Modal>
	);
}