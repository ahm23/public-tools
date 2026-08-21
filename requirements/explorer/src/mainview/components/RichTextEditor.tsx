import {
	useEffect,
	useMemo,
	useRef,
	useState,
	type MouseEvent as ReactMouseEvent,
	type ReactNode,
} from "react";
import type { WcNode } from "../../shared/rpcSchema";
import Modal from "./Modal";

interface RichTextEditorProps {
	initialHtml: string;
	nodes: WcNode[];
	onSave: (html: string) => void;
	onClose: () => void;
}

/** App theme colors: text is near-white, background near-black. */
const DEFAULT_TEXT_COLOR = "#e4e6ea";
const DEFAULT_BG = "#1e1f24";
const DEFAULT_BORDER_COLOR = "#000000";

const BORDER_SIDES = ["top", "right", "bottom", "left"] as const;
type BorderSide = (typeof BORDER_SIDES)[number];

/** A cell's position in the computed table grid (rowspan/colspan aware). */
interface GridCell {
	cell: HTMLTableCellElement;
	row: number;
	col: number;
	rowSpan: number;
	colSpan: number;
}

/** Normalize a CSS color (rgb()/named) to #rrggbb, or null if unparseable. */
function toHex(color: string | null | undefined): string | null {
	if (!color) return null;
	if (/^#[0-9a-f]{6}$/i.test(color)) return color.toLowerCase();
	const m = color.match(/\d+/g);
	if (!m || m.length < 3) return null;
	return (
		"#" +
		m
			.slice(0, 3)
			.map((n) => parseInt(n, 10).toString(16).padStart(2, "0"))
			.join("")
	);
}

/** Copy per-side border inline styles from one cell to another. */
function copyBorderStyles(src: HTMLElement, dst: HTMLElement) {
	const props = [
		"border-top-width",
		"border-top-style",
		"border-top-color",
		"border-right-width",
		"border-right-style",
		"border-right-color",
		"border-bottom-width",
		"border-bottom-style",
		"border-bottom-color",
		"border-left-width",
		"border-left-style",
		"border-left-color",
	];
	for (const p of props) {
		const v = src.style.getPropertyValue(p);
		if (v) dst.style.setProperty(p, v);
	}
}

/**
 * Compute the grid of a table: every cell is placed at (row, col) and fills
 * its rowspan x colspan rectangle, so operations can work in grid
 * coordinates even when cells are merged.
 */
function computeGrid(table: HTMLTableElement): {
	rows: HTMLTableRowElement[];
	grid: (HTMLTableCellElement | null)[][];
	cols: number;
	cells: GridCell[];
} {
	const rows = Array.from(table.rows);
	const grid: (HTMLTableCellElement | null)[][] = [];
	const cells: GridCell[] = [];
	for (let r = 0; r < rows.length; r++) {
		// keep rowspan fills written by rows above (don't reset)
		if (!grid[r]) grid[r] = [];
		let c = 0;
		for (const cell of Array.from(rows[r].cells)) {
			while (grid[r][c]) c++; // skip columns occupied by rowspans from above
			const rs = cell.rowSpan || 1;
			const cs = cell.colSpan || 1;
			for (let rr = r; rr < r + rs; rr++) {
				if (!grid[rr]) grid[rr] = [];
				for (let cc = c; cc < c + cs; cc++) grid[rr][cc] = cell;
			}
			cells.push({ cell, row: r, col: c, rowSpan: rs, colSpan: cs });
			c += cs;
		}
	}
	const cols = Math.max(0, ...grid.map((row) => row.length));
	return { rows, grid, cols, cells };
}

function findCell(
	cell: HTMLTableCellElement,
	grid: (HTMLTableCellElement | null)[][],
): GridCell | null {
	for (let r = 0; r < grid.length; r++) {
		for (let c = 0; c < grid[r].length; c++) {
			if (grid[r][c] === cell) {
				return {
					cell,
					row: r,
					col: c,
					rowSpan: cell.rowSpan || 1,
					colSpan: cell.colSpan || 1,
				};
			}
		}
	}
	return null;
}

/**
 * Split a merged cell at column `p` (interior). `removeColumn` means the
 * column at `p` is being deleted, otherwise it is being inserted.
 * Returns the new right-hand cell, or null when there is nothing left of it.
 */
function splitCellAt(
	cell: HTMLTableCellElement,
	pos: GridCell,
	p: number,
	removeColumn: boolean,
): HTMLTableCellElement | null {
	const leftSpan = p - pos.col;
	const rightSpan = pos.colSpan - leftSpan - (removeColumn ? 1 : 0);
	if (rightSpan <= 0) return null;
	cell.colSpan = leftSpan;
	const right = document.createElement("td");
	right.colSpan = rightSpan;
	right.rowSpan = cell.rowSpan;
	copyBorderStyles(cell, right);
	// no interior border between the two halves
	cell.style.setProperty("border-right-style", "none");
	right.style.setProperty("border-left-style", "none");
	cell.after(right);
	return right;
}

/**
 * Minimal rich-text editor: a contentEditable body plus toolbars built on
 * document.execCommand and small DOM helpers. The stored value is raw HTML,
 * matching Windchill's F522 field.
 *
 * Main toolbar: bold/italic/underline, lists, headings, text color, tables.
 * Table toolbar (shown when the caret is inside a table): add/delete row and
 * column (grid-aware), merge selected cells, cell background color, borders.
 * Cells can be selected as a rectangle with shift+click (HTML text selection
 * cannot span vertically).
 */
export default function RichTextEditor({
	initialHtml,
	nodes,
	onSave,
	onClose,
}: RichTextEditorProps) {
	const bodyRef = useRef<HTMLDivElement>(null);
	const rawRef = useRef<HTMLTextAreaElement>(null);
	const selAnchorRef = useRef<GridCell | null>(null);
	const [inTable, setInTable] = useState(false);
	const [textColor, setTextColorState] = useState(DEFAULT_TEXT_COLOR);
	const [cellColor, setCellColorState] = useState(DEFAULT_BG);
	const [borderColor, setBorderColorState] = useState(DEFAULT_BORDER_COLOR);
	const [rawMode, setRawMode] = useState(false);
	const [linkPickerOpen, setLinkPickerOpen] = useState(false);
	const [linkFilter, setLinkFilter] = useState("");
	const savedRangeRef = useRef<Range | null>(null);
	const [cellSelection, setCellSelection] = useState<
		Set<HTMLTableCellElement> | null
	>(null);

	useEffect(() => {
		bodyRef.current?.focus();
	}, []);

	// Escape cancels without saving (or closes the link picker first)
	useEffect(() => {
		const onKey = (e: KeyboardEvent) => {
			if (e.key !== "Escape") return;
			e.preventDefault();
			if (linkPickerOpen) closeLinkPicker();
			else onClose();
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, [onClose, linkPickerOpen]);

	// Keep the toolbars and color swatches in sync with the caret position.
	useEffect(() => {
		const update = () => {
			try {
				const cell = currentCell();
				setInTable(cell !== null);
				if (cell) {
					const cc = toHex(cell.style.backgroundColor);
					if (cc) setCellColorState(cc);
				}
				const fg = toHex(document.queryCommandValue("foreColor"));
				if (fg) setTextColorState(fg);
			} catch {
				/* ignore */
			}
		};
		document.addEventListener("selectionchange", update);
		return () => document.removeEventListener("selectionchange", update);
	}, []);

	// Paint the shift+click cell selection.
	useEffect(() => {
		const body = bodyRef.current;
		if (!body) return;
		body
			.querySelectorAll(".rte-cell-selected")
			.forEach((el) => el.classList.remove("rte-cell-selected"));
		if (cellSelection) {
			for (const c of cellSelection) c.classList.add("rte-cell-selected");
		}
	}, [cellSelection]);

	// Snapshot the rendered HTML into the raw view when it is opened.
	useEffect(() => {
		if (rawMode && rawRef.current) {
			rawRef.current.value = bodyRef.current?.innerHTML ?? "";
		}
	}, [rawMode]);

	const toggleRaw = () => {
		if (rawMode && rawRef.current) {
			bodyRef.current!.innerHTML = rawRef.current.value;
		}
		setRawMode(!rawMode);
	};

	// ------------------------------------------------------------------ utils

	const exec = (command: string, value?: string) => {
		bodyRef.current?.focus();
		document.execCommand(command, false, value);
	};

	const currentCell = (): HTMLTableCellElement | null => {
		const sel = window.getSelection();
		if (!sel || sel.rangeCount === 0) return null;
		const node = sel.anchorNode;
		if (!node) return null;
		let el: Element | null =
			node.nodeType === Node.ELEMENT_NODE
				? (node as Element)
				: node.parentElement;
		while (el && el !== bodyRef.current) {
			if (el instanceof HTMLTableCellElement) return el;
			el = el.parentElement;
		}
		return null;
	};

	const currentTable = (): HTMLTableElement | null => {
		return currentCell()?.closest("table") ?? null;
	};

	const selectedCells = (): HTMLTableCellElement[] => {
		const sel = window.getSelection();
		if (!sel || sel.rangeCount === 0) return [];
		const range = sel.getRangeAt(0);
		const table = currentTable();
		if (!table) return [];
		return Array.from(table.querySelectorAll("td, th")).filter((c) =>
			range.intersectsNode(c),
		) as HTMLTableCellElement[];
	};

	const clearCellSelection = () => {
		selAnchorRef.current = null;
		setCellSelection(null);
	};

	/** Cells an operation applies to: manual selection, else the text selection, else the caret cell. */
	const cellTargets = (): HTMLTableCellElement[] => {
		if (cellSelection && cellSelection.size > 0) return Array.from(cellSelection);
		const cells = selectedCells();
		return cells.length > 0 ? cells : currentCell() ? [currentCell()!] : [];
	};

	// ------------------------------------------------------ cell selection

	/**
	 * Plain click: place the caret, remember the cell as the selection anchor.
	 * Shift+click: select the rectangle between the anchor cell and this one
	 * (HTML text selection cannot span vertically across rows).
	 */
	const handleBodyMouseDown = (e: ReactMouseEvent<HTMLDivElement>) => {
		const target = e.target as HTMLElement | null;
		const cell = target
			? (target.closest("td, th") as HTMLTableCellElement | null)
			: null;
		if (!cell) {
			clearCellSelection();
			return;
		}
		if (!e.shiftKey) {
			selAnchorRef.current = cellPos(cell);
			setCellSelection(null);
			return;
		}
		e.preventDefault(); // don't extend the text selection
		const table = currentTable();
		if (!table) return;
		const info = computeGrid(table);
		const clicked = cellPos(cell);
		if (!clicked) return;
		const anchor = selAnchorRef.current;
		if (!anchor) {
			selAnchorRef.current = clicked;
			setCellSelection(new Set([clicked.cell]));
			return;
		}
		const minR = Math.min(anchor.row, clicked.row);
		const minC = Math.min(anchor.col, clicked.col);
		const maxR = Math.max(
			anchor.row + anchor.rowSpan - 1,
			clicked.row + clicked.rowSpan - 1,
		);
		const maxC = Math.max(
			anchor.col + anchor.colSpan - 1,
			clicked.col + clicked.colSpan - 1,
		);
		const selected = new Set<HTMLTableCellElement>();
		for (const g of info.cells) {
			const overlaps =
				g.row <= maxR &&
				g.row + g.rowSpan - 1 >= minR &&
				g.col <= maxC &&
				g.col + g.colSpan - 1 >= minC;
			if (overlaps) selected.add(g.cell);
		}
		setCellSelection(selected);
	};

	const cellPos = (cell: HTMLTableCellElement): GridCell | null => {
		const table = cell.closest("table");
		if (!table) return null;
		const info = computeGrid(table);
		return findCell(cell, info.grid);
	};

	// --------------------------------------------------------------- content

	const insertTable = () => {
		bodyRef.current?.focus();
		document.execCommand(
			"insertHTML",
			false,
			'<table><tbody><tr><td>Cell</td><td>Cell</td></tr><tr><td>Cell</td><td>Cell</td></tr></tbody></table><p><br/></p>',
		);
		clearCellSelection();
	};

	const applyTextColor = (color: string) => {
		setTextColorState(color);
		exec("foreColor", color);
	};

	// --------------------------------------------------------- table editing

	const addRow = () => {
		const cell = currentCell();
		if (!cell) return;
		const table = currentTable();
		if (!table) return;
		const info = computeGrid(table);
		const pos = findCell(cell, info.grid);
		if (!pos) return;
		// If the caret's row is covered by a vertical merge, extend it so the
		// new row becomes part of the merge; otherwise insert a plain row.
		const merged = info.grid[pos.row].find(
			(c): c is HTMLTableCellElement => !!c && (c.rowSpan || 1) > 1,
		);
		if (merged) merged.rowSpan += 1;
		const insertAfter = info.rows[pos.row];
		const tr = document.createElement("tr");
		for (let c = 0; c < info.cols; c++) {
			// columns covered by the (extended) merge get no cell here
			if (merged && info.grid[pos.row][c] === merged) continue;
			const td = document.createElement("td");
			const above = info.grid[pos.row][c];
			if (above) copyBorderStyles(above, td);
			tr.appendChild(td);
		}
		insertAfter.after(tr);
		clearCellSelection();
	};

	const deleteRow = () => {
		const cell = currentCell();
		if (!cell) return;
		const table = currentTable();
		if (!table) return;
		const info = computeGrid(table);
		const pos = findCell(cell, info.grid);
		if (!pos) return;
		const row = info.rows[pos.row];
		if (!row) return;
		// shrink any merge from above that covers this row
		for (const g of info.cells) {
			if (g.row >= pos.row) continue;
			if (g.row + g.rowSpan - 1 >= pos.row) {
				g.cell.rowSpan -= 1;
				if (g.cell.rowSpan <= 1) g.cell.removeAttribute("rowspan");
			}
		}
		row.remove();
		// drop rows left without cells
		for (const r of Array.from(table.rows)) {
			if (r.cells.length === 0) r.remove();
		}
		clearCellSelection();
	};

	const addColumn = () => {
		const cell = currentCell();
		if (!cell) return;
		const table = currentTable();
		if (!table) return;
		const info = computeGrid(table);
		const pos = findCell(cell, info.grid);
		if (!pos) return;
		const p = pos.col + pos.colSpan; // insert after the caret cell's range
		const posOf = new Map<HTMLTableCellElement, GridCell>(
			info.cells.map((g) => [g.cell, g] as const),
		);
		for (let r = 0; r < info.rows.length; r++) {
			const row = info.rows[r];
			const cover = p < info.cols ? info.grid[r][p] : null;
			const td = document.createElement("td");
			if (cover && cover.closest("tr") === row && cover.colSpan > 1) {
				const cp = posOf.get(cover)!;
				if (cp.col === p) {
					cover.before(td); // new column goes before the merge
				} else {
					// split the merge; the new column sits between the halves
					splitCellAt(cover, cp, p, false);
					cover.after(td);
				}
			} else {
				// insert after the last cell that ends at or before p
				let anchor: HTMLTableCellElement | null = null;
				for (const c of Array.from(row.cells)) {
					const pc = posOf.get(c);
					if (pc && pc.col + pc.colSpan <= p) anchor = c;
				}
				if (anchor) anchor.after(td);
				else row.insertBefore(td, row.firstChild);
			}
		}
		clearCellSelection();
	};

	const deleteColumn = () => {
		const cell = currentCell();
		if (!cell) return;
		const table = currentTable();
		if (!table) return;
		const info = computeGrid(table);
		const pos = findCell(cell, info.grid);
		if (!pos) return;
		const p = pos.col;
		const posOf = new Map<HTMLTableCellElement, GridCell>(
			info.cells.map((g) => [g.cell, g] as const),
		);
		const seen = new Set<HTMLTableCellElement>();
		for (let r = 0; r < info.rows.length; r++) {
			const row = info.rows[r];
			const cover = info.grid[r][p];
			if (!cover || seen.has(cover)) continue;
			seen.add(cover);
			if (cover.closest("tr") !== row) continue; // rowspan from above stays
			const cp = posOf.get(cover)!;
			if (cover.colSpan > 1) {
				if (cp.col === p) {
					cover.colSpan -= 1; // the merge loses its first column
				} else {
					// split the merge around the removed column
					splitCellAt(cover, cp, p, true);
				}
			} else {
				cover.remove();
			}
		}
		// drop rows left without cells
		for (const row of Array.from(table.rows)) {
			if (row.cells.length === 0) row.remove();
		}
		clearCellSelection();
	};

	const mergeCells = () => {
		const targets = cellTargets();
		if (targets.length < 2) return;
		const table = currentTable();
		if (!table) return;
		const info = computeGrid(table);
		const posOf = new Map<HTMLTableCellElement, GridCell>(
			info.cells.map((g) => [g.cell, g] as const),
		);
		// anchor = the selected cell with the smallest grid position
		let anchor: GridCell | null = null;
		for (const c of targets) {
			const p = posOf.get(c);
			if (!p) continue;
			if (!anchor || p.row < anchor.row || (p.row === anchor.row && p.col < anchor.col)) {
				anchor = p;
			}
		}
		if (!anchor) return;
		const minR = anchor.row;
		const minC = anchor.col;
		let maxR = anchor.row + anchor.rowSpan - 1;
		let maxC = anchor.col + anchor.colSpan - 1;
		for (const c of targets) {
			const p = posOf.get(c);
			if (!p || p === anchor) continue;
			maxR = Math.max(maxR, p.row + p.rowSpan - 1);
			maxC = Math.max(maxC, p.col + p.colSpan - 1);
		}
		const inside = (g: GridCell) =>
			g.row >= minR &&
			g.row + g.rowSpan - 1 <= maxR &&
			g.col >= minC &&
			g.col + g.colSpan - 1 <= maxC;
		// bail if any cell is only partially covered by the merge box
		for (const g of info.cells) {
			if (g === anchor) continue;
			const overlaps =
				g.row <= maxR &&
				g.row + g.rowSpan - 1 >= minR &&
				g.col <= maxC &&
				g.col + g.colSpan - 1 >= minC;
			if (overlaps && !inside(g)) return;
		}
		anchor.cell.colSpan = maxC - minC + 1;
		anchor.cell.rowSpan = maxR - minR + 1;
		for (const g of info.cells) {
			if (g === anchor) continue;
			if (inside(g)) g.cell.remove();
		}
		clearCellSelection();
	};

	const setCellColor = (color: string) => {
		setCellColorState(color);
		for (const c of cellTargets()) c.style.backgroundColor = color;
	};

	// ----------------------------------------------------------------- border

	const toggleBorder = (side: BorderSide) => {
		for (const c of cellTargets()) {
			const prop = `border-${side}-style`;
			const cur = c.style.getPropertyValue(prop);
			if (cur && cur !== "none") {
				c.style.setProperty(prop, "none");
			} else {
				c.style.setProperty(prop, "solid");
				c.style.setProperty(`border-${side}-width`, "1px");
				c.style.setProperty(`border-${side}-color`, borderColor);
			}
		}
	};

	/** Toggle all four borders on/off at once. */
	const toggleAllBorders = () => {
		for (const c of cellTargets()) {
			const allSet = BORDER_SIDES.every((s) => {
				const v = c.style.getPropertyValue(`border-${s}-style`);
				return v && v !== "none";
			});
			for (const s of BORDER_SIDES) {
				if (allSet) {
					c.style.setProperty(`border-${s}-style`, "none");
				} else {
					c.style.setProperty(`border-${s}-style`, "solid");
					c.style.setProperty(`border-${s}-width`, "1px");
					c.style.setProperty(`border-${s}-color`, borderColor);
				}
			}
		}
	};

	const applyBorderColor = (color: string) => {
		setBorderColorState(color);
		for (const c of cellTargets()) {
			for (const s of BORDER_SIDES) {
				const style = c.style.getPropertyValue(`border-${s}-style`);
				if (style && style !== "none") {
					c.style.setProperty(`border-${s}-color`, color);
				}
			}
		}
	};

	// ------------------------------------------------------------ item links

	/** Flattened node list for the link picker, in document order. */
	const flatNodes = useMemo(() => {
		const out: { id: string; title: string; reqId: string; depth: number }[] = [];
		const walk = (list: WcNode[], depth: number) => {
			for (const n of list) {
				out.push({ id: n.id, title: n.title, reqId: n.reqId, depth });
				walk(n.children, depth + 1);
			}
		};
		walk(nodes, 0);
		return out;
	}, [nodes]);

	const openLinkPicker = () => {
		const sel = window.getSelection();
		if (!sel || sel.isCollapsed || sel.rangeCount === 0) return;
		savedRangeRef.current = sel.getRangeAt(0).cloneRange();
		setLinkFilter("");
		setLinkPickerOpen(true);
	};

	const closeLinkPicker = () => {
		setLinkPickerOpen(false);
		savedRangeRef.current = null;
	};

	/** Wrap the saved selection in an item link, then close the picker. */
	const applyItemLink = (itemId: string) => {
		const range = savedRangeRef.current;
		setLinkPickerOpen(false);
		savedRangeRef.current = null;
		if (!range) return;
		bodyRef.current?.focus();
		const sel = window.getSelection();
		if (!sel) return;
		sel.removeAllRanges();
		sel.addRange(range);
		document.execCommand(
			"createLink",
			false,
			`mks:///item?itemid=${itemId}`,
		);
	};

	const linkCandidates = flatNodes.filter((n) => {
		const q = linkFilter.trim().toLowerCase();
		if (!q) return true;
		return (
			n.id.toLowerCase().includes(q) ||
			n.title.toLowerCase().includes(q) ||
			n.reqId.toLowerCase().includes(q)
		);
	});

	// ---------------------------------------------------------------- toolbar

	const tool = (label: ReactNode, title: string, fn: () => void) => (
		<button
			type="button"
			title={title}
			onMouseDown={(e) => {
				e.preventDefault(); // keep the editor selection
				fn();
			}}
		>
			{label}
		</button>
	);

	const colorInput = (value: string, title: string, onChange: (c: string) => void) => (
		<label className="rte-color" title={title}>
			<input
				type="color"
				value={value}
				onChange={(e) => onChange(e.target.value)}
			/>
		</label>
	);

	return (
		<Modal title="Edit text" onClose={onClose} className="rte-modal">
			<div className="rte-toolbar">
				{!rawMode && (
					<>
						{tool(<b>B</b>, "Bold", () => exec("bold"))}
						{tool(<i>I</i>, "Italic", () => exec("italic"))}
						{tool(<u>U</u>, "Underline", () => exec("underline"))}
						{tool("• List", "Bullet list", () => exec("insertUnorderedList"))}
						{tool("1. List", "Numbered list", () => exec("insertOrderedList"))}
						{tool("H1", "Heading 1", () => exec("formatBlock", "h3"))}
						{tool("¶", "Paragraph", () => exec("formatBlock", "p"))}
						{tool("⛓ Item link", "Link selected text to an item", openLinkPicker)}
						{tool("⊞ Table", "Insert 2×2 table", insertTable)}
						<span className="rte-sep"></span>
						<span className="rte-label">Text</span>
						{colorInput(textColor, "Text color", applyTextColor)}
						{tool("↺", "Reset text color", () => applyTextColor(DEFAULT_TEXT_COLOR))}
					</>
				)}
				<span className="rte-sep"></span>
				{tool(
					"HTML",
					rawMode ? "Back to formatted view" : "Toggle raw HTML view",
					toggleRaw,
				)}
			</div>
			{inTable && !rawMode && (
				<div className="rte-toolbar table-tools">
					{tool("+ Row", "Add row", addRow)}
					{tool("− Row", "Delete row", deleteRow)}
					{tool("+ Col", "Add column", addColumn)}
					{tool("− Col", "Delete column", deleteColumn)}
					{tool("⛶ Merge", "Merge selected cells", mergeCells)}
					<span className="rte-sep"></span>
					<span className="rte-label">Cell</span>
					{colorInput(cellColor, "Cell background color", setCellColor)}
					<span className="rte-sep"></span>
					<span className="rte-label">Border</span>
					{tool("L", "Left border", () => toggleBorder("left"))}
					{tool("R", "Right border", () => toggleBorder("right"))}
					{tool("T", "Top border", () => toggleBorder("top"))}
					{tool("B", "Bottom border", () => toggleBorder("bottom"))}
					{tool("All", "Toggle all borders", toggleAllBorders)}
					{colorInput(borderColor, "Border color", applyBorderColor)}
				</div>
			)}
			<div
				className="rte-body"
				style={rawMode ? { display: "none" } : undefined}
				contentEditable
				ref={bodyRef}
				suppressContentEditableWarning
				data-placeholder="Text…"
				dangerouslySetInnerHTML={{ __html: initialHtml }}
				onMouseDown={handleBodyMouseDown}
				onKeyDown={(e) => {
					if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
						e.preventDefault();
						save();
					}
				}}
			/>
			{rawMode && (
				<textarea
					className="rte-body raw"
					ref={rawRef}
					spellCheck={false}
					placeholder="HTML…"
					onKeyDown={(e) => {
						if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
							e.preventDefault();
							save();
						}
					}}
				/>
			)}
			<div className="rte-footer">
				<button onClick={onClose}>Cancel</button>
				<button className="primary" onClick={save}>
					Save
				</button>
			</div>
			{linkPickerOpen && (
				<Modal
					title="Link to item"
					onClose={closeLinkPicker}
					className="rte-link-modal"
				>
					<div className="rte-link-search">
						<input
							type="text"
							autoFocus
							placeholder="Search nodes…"
							value={linkFilter}
							onChange={(e) => setLinkFilter(e.target.value)}
						/>
					</div>
					<div className="rte-link-list">
						{linkCandidates.map((n) => (
							<button
								key={n.id}
								type="button"
								className="rte-link-item"
								style={{ paddingLeft: 10 + n.depth * 14 }}
								onClick={() => applyItemLink(n.id)}
							>
								<span className="rte-link-id">{n.id}</span>
								<span className="rte-link-title">
									{n.title || "(untitled)"}
								</span>
							</button>
						))}
						{linkCandidates.length === 0 && (
							<div className="rte-link-empty">
								No matching nodes
							</div>
						)}
					</div>
				</Modal>
			)}
		</Modal>
	);

	function save() {
		onSave(
			rawMode
				? rawRef.current?.value ?? ""
				: bodyRef.current?.innerHTML ?? "",
		);
	}
}