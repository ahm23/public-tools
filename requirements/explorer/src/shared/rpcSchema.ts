/**
 * Shared RPC schema + types for the Requirements Explorer.
 * Imported by both the Bun main process (src/bun) and the React renderer (src/mainview).
 * Keep this file free of runtime imports so both bundlers can consume it.
 */

export type BlockHeading = { type: "heading"; level: number; title: string };

export type BlockItem = {
	type: "item";
	kind: "requirement" | "comment";
	id: string;
	text: string;
};

export type SpecBlock = BlockHeading | BlockItem;

export interface SpecDoc {
	format: string;
	version: number;
	blocks: SpecBlock[];
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

export interface ConvertResult {
	ok: boolean;
	spec?: SpecDoc;
	output?: string;
	error?: string;
}

export type ConvertFormat = "docx" | "xlsx";

/** Requests the renderer can make of the main process. */
export type AppRequests = {
	"spec:load": { params: { path: string }; response: SpecState };
	"spec:save": { params: { path: string; spec: SpecDoc }; response: SaveResult };
	"spec:new": { params: void; response: SpecState };
	"spec:import": {
		params: { format: ConvertFormat; path: string };
		response: ConvertResult;
	};
	"spec:export": {
		params: { format: ConvertFormat; path: string; spec: SpecDoc };
		response: ConvertResult;
	};
	"dialog:pickOpen": {
		params: { filter?: string };
		response: { path: string | null };
	};
	"dialog:pickSave": {
		params: { filter?: string; defaultName?: string };
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
}

export type AppRPCSchema = {
	bun: { requests: AppRequests; messages: Record<string, never> };
	webview: { requests: Record<string, never>; messages: Record<string, never> };
};

export const SPEC_FORMAT = "requirements-explorer-spec";
export const SPEC_VERSION = 1;

export function emptySpec(): SpecDoc {
	return { format: SPEC_FORMAT, version: SPEC_VERSION, blocks: [] };
}

/** Type of an item derived from its ID + text (mirrors the converter heuristics). */
export function itemKind(id: string, text: string): "requirement" | "comment" {
	if (id.trim()) return "requirement";
	const lowered = text.toLowerCase();
	if (lowered.includes("shall") || lowered.includes("should") || lowered.includes("may")) {
		return "requirement";
	}
	return "comment";
}
