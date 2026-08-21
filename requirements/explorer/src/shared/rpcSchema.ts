/**
 * Shared RPC schema + types for the Windchill RV&S Editor.
 * Imported by both the Bun main process (src/bun) and the React renderer (src/mainview).
 */

export interface WcNode {
	id: string;
	category: string;
	title: string;
	/** Rich text (HTML). */
	text: string;
	reqId: string;
	children: WcNode[];
}

export interface SpecDoc {
	format: string;
	version: number;
	documentId: string;
	nodes: WcNode[];
}

export interface SpecState {
	path: string;
	spec: SpecDoc;
}

export interface SaveResult {
	ok: boolean;
	path?: string;
	error?: string;
}

export interface ImportResult {
	ok: boolean;
	spec?: SpecDoc;
	error?: string;
	output?: string;
}

/** One item in a spec-change POST (mirrors wc-req-edit.json / wc-req-move*.json). */
export interface WcEditItem {
	ID: string;
	flag: string;
	fieldlist: string;
	/** Present in edit payloads (wc-req-edit.json). */
	Type?: string;
	ModifiedDateLongValue?: number;
	FVAModifiedDateLongValues?: string;
	/** Present in move payloads (wc-req-moveafter.json / wc-req-moveinto.json). */
	parentID?: string;
	insertLocation?: string;
	/** Edited fields by RV&S field code, e.g. { F522: "<p>…</p>" }. */
	[key: string]: unknown;
}

/** Body of the edit POST sent on every spec edit. */
export interface WcEditPayload {
	multiitemdata: WcEditItem[];
	includeRelationshipFlags: boolean;
}

/** Requests the renderer can make of the main process. */
export type AppRequests = {
	"spec:new": { params: void; response: SpecState };
	"spec:load": { params: { path: string }; response: SpecState };
	"spec:save": { params: { path: string; spec: SpecDoc }; response: SaveResult };
	"spec:importWindchill": {
		params: { documentId: string };
		response: ImportResult;
	};
	"spec:editEvent": {
		params: { payload: WcEditPayload };
		response: { ok: boolean; error?: string };
	};
	"dialog:pickOpen": {
		params: { filter?: string };
		response: { path: string | null };
	};
	"dialog:pickSave": {
		params: { filter?: string };
		response: { path: string | null };
	};
	"dialog:confirm": {
		params: {
			title: string;
			message: string;
			detail?: string;
			confirmLabel?: string;
		};
		response: { confirmed: boolean };
	};
};

export type AppRPCSchema = {
	bun: { requests: AppRequests; messages: Record<string, never> };
	webview: { requests: Record<string, never>; messages: Record<string, never> };
};

export const SPEC_FORMAT = "windchill-editor-spec";
export const SPEC_VERSION = 1;

export function emptySpec(): SpecDoc {
	return { format: SPEC_FORMAT, version: SPEC_VERSION, documentId: "", nodes: [] };
}

/**
 * Section numbers: a node gets a number iff it has children. Child-bearing
 * nodes are counted in document order at each depth, so a node under "1.2"
 * with children gets "1.2.1", "1.2.2", … Leaf nodes (no children) get none.
 * Keyed by node id.
 */
export function computeSections(nodes: WcNode[]): Map<string, string> {
	const out = new Map<string, string>();
	const counters: number[] = [];
	const walk = (list: WcNode[], parent: string | null, depth: number) => {
		for (const node of list) {
			if (node.children.length === 0) continue;
			counters[depth] = (counters[depth] ?? 0) + 1;
			const num =
				parent === null ? String(counters[depth]) : `${parent}.${counters[depth]}`;
			out.set(node.id, num);
			walk(node.children, num, depth + 1);
		}
	};
	walk(nodes, null, 0);
	return out;
}