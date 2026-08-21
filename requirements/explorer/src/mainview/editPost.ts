/**
 * Edit sync — builds Windchill RV&S spec-change payloads and POSTs them to
 * the local edit endpoint. Every field edit and every move in the app
 * funnels through here.
 *
 * Payload shapes mirror requirements/explorer/wc-req-edit.json and
 * wc-req-moveafter.json / wc-req-moveinto.json. The POST itself is performed
 * by the Bun main process (see src/bun/index.ts) so the webview's CORS never
 * applies.
 */

import type { WcEditItem, WcEditPayload } from "../shared/rpcSchema";
import type { EditField, MoveTarget } from "./components/SpecTable";
import { ipc } from "./ipc";

/** RV&S field code per editable column (mapping from windchill.ts import). */
const FIELD_CODES: Record<EditField, string> = {
	title: "F576",
	reqId: "F531",
	text: "F522",
};

/** Full field list, copied verbatim from wc-req-edit.json. */
const FIELD_LIST =
	"ID,F531,Category,F576,F522,F572,F658,F406,F43,F743,ReferenceMode,DocumentID,State,FVAModifiedDateLongValues,ModifiedDateLongValue,Type";

/** Item type — constant per wc-req-edit.json ("always T85"). */
const ITEM_TYPE = "T85";

export interface EditEvent {
	nodeId: string;
	field: EditField;
	value: string;
}

/**
 * Build one item for a single edit. Returns null for placeholder nodes
 * (LOCAL* ids) that have no real Windchill item behind them.
 */
function buildItem(ev: EditEvent): WcEditItem | null {
	const numericId = Number(ev.nodeId);
	if (!Number.isFinite(numericId)) return null;
	const now = Date.now();
	const item: WcEditItem = {
		ID: ev.nodeId,
		Type: ITEM_TYPE,
		flag: "edit",
		ModifiedDateLongValue: now,
		// First token is the item's ID + 1 (per the sample); the sample's
		// extra ";"-separated pairs are unexplained and not generated.
		FVAModifiedDateLongValues: `${numericId + 1}:${now}`,
		fieldlist: FIELD_LIST,
	};
	item[FIELD_CODES[ev.field]] = ev.value;
	return item;
}

/** Build a payload, merging multiple edits to the same node into one item. */
export function buildEditPayload(events: EditEvent[]): WcEditPayload | null {
	const byNode = new Map<string, WcEditItem>();
	for (const ev of events) {
		const item = buildItem(ev);
		if (!item) continue;
		const existing = byNode.get(ev.nodeId);
		if (existing) {
			existing[FIELD_CODES[ev.field]] = ev.value;
		} else {
			byNode.set(ev.nodeId, item);
		}
	}
	const items = [...byNode.values()];
	if (items.length === 0) return null;
	return { multiitemdata: items, includeRelationshipFlags: true };
}

/** Fire-and-forget POST; never blocks or throws into the UI. */
export function postEdits(events: EditEvent[]): void {
	const payload = buildEditPayload(events);
	if (!payload) return;
	ipc["spec:editEvent"]({ payload })
		.then((res) => {
			if (!res.ok) console.warn("[editEvent] rejected:", res.error);
		})
		.catch((e) => console.warn("[editEvent] failed:", String(e)));
}

/** POST a single edit. */
export function postEdit(nodeId: string, field: EditField, value: string): void {
	postEdits([{ nodeId, field, value }]);
}

// ---------------------------------------------------------------------------
// Moves
// ---------------------------------------------------------------------------

/** Field list for move payloads, copied verbatim from wc-req-moveafter.json. */
const MOVE_FIELD_LIST =
	"ID,Category,F576,F522,F572,F658,F406,F43,F743,ReferenceMode,DocumentID,State,FVAModifiedDateLongValues,ModifiedDateLongValue";

export interface MoveEvent {
	/** The block being moved, in document order (already pruned to topmost). */
	nodeIds: string[];
	target: MoveTarget;
	/** Document id — the parent for root-level moves. */
	documentId: string;
}

/**
 * Build a move payload (flag "move"). insertLocation mirrors the samples:
 * "before:<id>" / "after:<id>" for sibling placement, "last" for appending
 * to a subsection. A multi-row block is expressed as a chain — the first row
 * anchors to the drop target, each following row anchors after the previous
 * one — so the server preserves the block order.
 */
export function buildMovePayload(ev: MoveEvent): WcEditPayload | null {
	const parentId = ev.target.parentId ?? (ev.documentId || null);
	if (!parentId) return null;
	const items: WcEditItem[] = [];
	let prevId: string | null = null;
	for (const id of ev.nodeIds) {
		if (!Number.isFinite(Number(id))) continue; // LOCAL placeholders
		let insertLocation: string;
		if (ev.target.pos === "end") {
			insertLocation = "last";
		} else {
			insertLocation =
				prevId !== null
					? `after:${prevId}`
					: `${ev.target.pos}:${ev.target.anchorId}`;
		}
		items.push({
			flag: "move",
			ID: id,
			parentID: parentId,
			insertLocation,
			fieldlist: MOVE_FIELD_LIST,
		});
		prevId = id;
	}
	if (items.length === 0) return null;
	return { multiitemdata: items, includeRelationshipFlags: true };
}

/** Fire-and-forget POST of a move; never blocks or throws into the UI. */
export function postMove(ev: MoveEvent): void {
	const payload = buildMovePayload(ev);
	if (!payload) return;
	ipc["spec:editEvent"]({ payload })
		.then((res) => {
			if (!res.ok) console.warn("[moveEvent] rejected:", res.error);
		})
		.catch((e) => console.warn("[moveEvent] failed:", String(e)));
}
