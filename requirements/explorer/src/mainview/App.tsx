import { useEffect, useMemo, useState } from "react";
import type { ConvertFormat, SpecBlock, SpecDoc } from "../shared/rpcSchema";
import { emptySpec } from "../shared/rpcSchema";
import { ipc } from "./ipc";
import Modal from "./components/Modal";
import NavTree from "./components/NavTree";
import SpecTable, { type EditField } from "./components/SpecTable";

type ModalKind = "import" | "export" | null;

const EMPTY_TEXT = "";

function nextReqId(blocks: SpecBlock[]): string {
	let max = 0;
	for (const b of blocks) {
		if (b.type === "item") {
			const m = /^REQ(\d+)$/.exec(b.id.trim());
			if (m) max = Math.max(max, parseInt(m[1], 10));
		}
	}
	return `REQ${String(max + 1).padStart(4, "0")}`;
}

/** Per-block indent depth, same logic as SpecTable. */
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

/** Block indices removed when deleting block at `index` (heading removes its subtree). */
function deleteRange(blocks: SpecBlock[], index: number): number[] {
	const block = blocks[index];
	if (block.type !== "heading") return [index];
	const level = block.level;
	let end = index + 1;
	while (end < blocks.length) {
		const b = blocks[end];
		if (b.type === "heading" && b.level <= level) break;
		end += 1;
	}
	return Array.from({ length: end - index }, (_, k) => index + k);
}

export default function App() {
	const [spec, setSpec] = useState<SpecDoc>(emptySpec());
	const [path, setPath] = useState("");
	const [dirty, setDirty] = useState(false);
	const [selected, setSelected] = useState<number | null>(null);
	const [modal, setModal] = useState<ModalKind>(null);
	const [busy, setBusy] = useState(false);
	const [status, setStatus] = useState("");
	const [error, setError] = useState<string | null>(null);

	const blocks = spec.blocks;
	const indents = useMemo(() => computeIndents(blocks), [blocks]);
	const counts = useMemo(() => {
		let headings = 0;
		let requirements = 0;
		let comments = 0;
		for (const b of blocks) {
			if (b.type === "heading") headings += 1;
			else if (b.kind === "requirement") requirements += 1;
			else comments += 1;
		}
		return { headings, requirements, comments };
	}, [blocks]);

	// ------------------------------------------------------------------ state

	const mutate = (fn: (prev: SpecBlock[]) => SpecBlock[]) => {
		setSpec((prev) => ({ ...prev, blocks: fn(prev.blocks) }));
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

	const selectRow = (i: number) => {
		setSelected(i);
		document.getElementById(`spec-row-${i}`)?.scrollIntoView({ block: "nearest" });
	};

	const commitEdit = (index: number, field: EditField, value: string) => {
		mutate((prev) =>
			prev.map((b, i) => {
				if (i !== index) return b;
				if (b.type === "heading") {
					return field === "title" ? { ...b, title: value } : b;
				}
				if (field === "id") return { ...b, id: value };
				if (field === "text") return { ...b, text: value };
				return b;
			}),
		);
	};

	// ------------------------------------------------------------ mutations

	const addBelow = (index: number) => {
		const insertAt = index + 1;
		const item: SpecBlock = {
			type: "item",
			kind: "requirement",
			id: nextReqId(blocks),
			text: EMPTY_TEXT,
		};
		mutate((prev) => [...prev.slice(0, insertAt), item, ...prev.slice(insertAt)]);
		setSelected(insertAt);
		flash(`Added requirement ${item.id}`);
	};

	const addHeadingBelow = (index: number | null) => {
		const insertAt = index === null ? blocks.length : index + 1;
		const level = index === null ? 1 : Math.min(9, indents[index] + 1);
		const heading: SpecBlock = { type: "heading", level, title: "" };
		mutate((prev) => [...prev.slice(0, insertAt), heading, ...prev.slice(insertAt)]);
		setSelected(insertAt);
	};

	const requestDelete = async (index: number) => {
		const range = deleteRange(blocks, index);
		const block = blocks[index];
		const what =
			block.type === "heading"
				? `heading "${block.title || "(untitled)"}"${range.length > 1 ? ` and its ${range.length - 1} item(s)` : ""}`
				: block.id
					? `requirement ${block.id}`
					: "this item";
		const { confirmed } = await ipc["dialog:confirm"]({
			title: "Delete row",
			message: `Delete ${what}?`,
			detail: "This cannot be undone.",
			confirmLabel: "Delete",
		});
		if (!confirmed) return;
		const removed = new Set(range);
		mutate((prev) => prev.filter((_, i) => !removed.has(i)));
		if (selected !== null && removed.has(selected)) setSelected(null);
		flash(`Deleted ${what}`);
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
			setSelected(null);
			flash(`Opened ${p}`);
		} catch (e) {
			fail(String(e));
		}
		setBusy(false);
	};

	const newDoc = async () => {
		const { confirmed } = await ipc["dialog:confirm"]({
			title: "New specification",
			message: dirty ? "Discard unsaved changes and start a new specification?" : "Start a new empty specification?",
			confirmLabel: "New",
		});
		if (!confirmed) return;
		const st = await ipc["spec:new"]();
		setSpec(st.spec);
		setPath("");
		setDirty(false);
		setSelected(null);
		flash("New empty specification");
	};

	// ------------------------------------------------------------ import/export

	const doImport = async (format: ConvertFormat, importPath: string) => {
		setBusy(true);
		try {
			const res = await ipc["spec:import"]({ format, path: importPath });
			if (!res.ok || !res.spec) return fail(res.error ?? "import failed");
			setSpec(res.spec);
			setDirty(true);
			setSelected(null);
			flash(`Imported ${importPath}`);
			setModal(null);
		} catch (e) {
			fail(String(e));
		}
		setBusy(false);
	};

	const doExport = async (format: ConvertFormat, exportPath: string) => {
		setBusy(true);
		try {
			const res = await ipc["spec:export"]({ format, path: exportPath, spec });
			if (!res.ok) return fail(res.error ?? "export failed");
			flash(`Exported ${res.output ?? exportPath}`);
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
					Import…
				</button>
				<button onClick={() => setModal("export")} disabled={busy || blocks.length === 0}>
					Export…
				</button>
				<span className="toolbar-sep"></span>
				<button onClick={() => addHeadingBelow(selected)} disabled={busy} title="Add heading below selection">
					+ Heading
				</button>
				<button onClick={() => selected !== null && addBelow(selected)} disabled={busy || selected === null} title="Add requirement below selection">
					+ Requirement
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

			<div className="main">
				<NavTree blocks={blocks} selectedIndex={selected} onSelect={selectRow} />
				<SpecTable
					blocks={blocks}
					selectedIndex={selected}
					onSelect={selectRow}
					onCommitEdit={commitEdit}
					onAddBelow={addBelow}
					onDelete={requestDelete}
				/>
			</div>

			<div className="status-bar">
				<span>{counts.headings} headings</span>
				<span>{counts.requirements} requirements</span>
				<span>{counts.comments} comments</span>
				<span>{blocks.length} rows</span>
				<span className="spacer"></span>
				{status && <span>{status}</span>}
				{error && <span className="err">{error}</span>}
			</div>

			{modal === "import" && (
				<IoModal
					mode="import"
					onClose={() => setModal(null)}
					onSubmit={doImport}
				/>
			)}
			{modal === "export" && (
				<IoModal
					mode="export"
					currentPath={path}
					onClose={() => setModal(null)}
					onSubmit={doExport}
				/>
			)}
		</div>
	);
}

// ---------------------------------------------------------------------------
// Import / Export modal
// ---------------------------------------------------------------------------

function IoModal({
	mode,
	currentPath,
	onClose,
	onSubmit,
}: {
	mode: "import" | "export";
	currentPath?: string;
	onClose: () => void;
	onSubmit: (format: ConvertFormat, path: string) => void;
}) {
	const [format, setFormat] = useState<ConvertFormat>("docx");
	const [filePath, setFilePath] = useState(
		mode === "export"
			? (currentPath || "spec").replace(/\.json$/, "") + ".docx"
			: "",
	);

	const browse = async () => {
		if (mode === "import") {
			const { path } = await ipc["dialog:pickOpen"]({ filter: format });
			if (path) setFilePath(path);
		} else {
			const { path } = await ipc["dialog:pickSave"]({ filter: format });
			if (path) setFilePath(path);
		}
	};

	const switchFormat = (f: ConvertFormat) => {
		setFormat(f);
		if (mode === "export" && filePath) {
			setFilePath(filePath.replace(/\.(docx|xlsx|json)$/i, "") + "." + f);
		}
	};

	return (
		<Modal title={mode === "import" ? "Import specification" : "Export specification"} onClose={onClose}>
			<div className="field">
				<label>Format</label>
				<div className="io-grid">
					<label className="io-option">
						<input
							type="radio"
							name="io-format"
							checked={format === "docx"}
							onChange={() => switchFormat("docx")}
						/>
						<span>
							<span className="io-title">Word document (.docx)</span>
							<span className="io-desc">
								{mode === "import"
									? "Headings and [REQ####] tokens become items; heading levels are preserved."
									: "Headings use Word styles; requirement IDs are written as [REQ####] tokens."}
							</span>
						</span>
					</label>
					<label className="io-option">
						<input
							type="radio"
							name="io-format"
							checked={format === "xlsx"}
							onChange={() => switchFormat("xlsx")}
						/>
						<span>
							<span className="io-title">Excel workbook (.xlsx)</span>
							<span className="io-desc">
								{mode === "import"
									? "4-column spec sheet (Title, Type, External ID, Text). Heading levels are flattened."
									: "Writes the same 4-column sheet produced by the legacy converter."}
							</span>
						</span>
					</label>
				</div>
			</div>
			<div className="field">
				<label>{mode === "import" ? "File to import" : "Output file"}</label>
				<div style={{ display: "flex", gap: 8 }}>
					<input
						type="text"
						value={filePath}
						placeholder={mode === "import" ? "/path/to/spec.docx" : "/path/to/out.docx"}
						onChange={(e) => setFilePath(e.target.value)}
					/>
					<button onClick={browse}>Browse…</button>
				</div>
			</div>
			<div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 16 }}>
				<button onClick={onClose}>Cancel</button>
				<button
					className="primary"
					disabled={!filePath.trim()}
					onClick={() => onSubmit(format, filePath.trim())}
				>
					{mode === "import" ? "Import" : "Export"}
				</button>
			</div>
		</Modal>
	);
}
