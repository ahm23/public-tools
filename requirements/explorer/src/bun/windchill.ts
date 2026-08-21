/**
 * Windchill RV&S import — fetch placeholder + data transform.
 *
 * The renderer asks for a document by ID; this module is responsible for
 * (1) fetching the items from Windchill RV&S and (2) converting the raw
 * OData rows into the editor's tree model.
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { SpecDoc, WcNode } from "../shared/rpcSchema";
import { SPEC_FORMAT, SPEC_VERSION } from "../shared/rpcSchema";

/** One row of the RV&S OData response (`value` array). */
export interface RawWcItem {
	ID?: string;
	Category?: string;
	DocumentID?: string;
	/** Parent item ID; equals DocumentID for root items. Absent in the sample. */
	ContainedBy?: string | null;
	/** Child refs, e.g. "2601303;ay,2601141;ay". */
	Contains?: string | null;
	/** Text body (HTML). */
	F522?: string | null;
	/** Requirement ID code. */
	F531?: string | null;
	/** Title. */
	F576?: string | null;
	[key: string]: unknown;
}

// ---------------------------------------------------------------------------
// Fetch (placeholder)
// ---------------------------------------------------------------------------

function projectRoot(): string {
	let dir = dirname(fileURLToPath(import.meta.url)); // <root>/src/bun
	for (let i = 0; i < 8; i++) {
		if (existsSync(join(dir, "wc-data.json"))) return dir;
		const parent = dirname(dir);
		if (parent === dir) break;
		dir = parent;
	}
	return dir;
}

/**
 * PLACEHOLDER — fetch the items of one Windchill RV&S document.
 *
 * TODO(user): replace the body with the real request. Windchill RV&S speaks
 * OData; the sample (wc-data.json at the project root) was produced by an
 * endpoint of this shape:
 *
 *   POST https://<host>/rws/odata/ptc/ilm/items/filtereditems
 *   Authorization: Basic <base64(user:pass)>   (or a bearer token)
 *   Content-Type: application/json
 *
 * with a request body that selects the document (by ID) and requests the
 * fields ID, Category, F522, F576, Contains, ContainedBy, DocumentID.
 *
 * The response is `{ "value": [ ...RawWcItem ] }`.
 *
 * Until you implement it, this returns the bundled sample so the rest of the
 * pipeline (transform → tree → table) works end to end.
 */
export async function fetchWindchillItems(
	documentId: string,
): Promise<RawWcItem[]> {
	// =======================================================================
	// TODO(user): implement the real request here. `documentId` is what the
	// user typed into the import dialog (e.g. "2601094").
	// =======================================================================
	void documentId;

	const samplePath = join(projectRoot(), "wc-data.json");
	if (!existsSync(samplePath)) {
		throw new Error(`sample wc-data.json not found at ${samplePath}`);
	}
	const parsed = JSON.parse(readFileSync(samplePath, "utf-8")) as {
		value?: RawWcItem[];
	};
	const items = parsed.value ?? [];
	console.log(
		`[windchill] placeholder: returned ${items.length} sample items`,
	);
	return items;
}

// ---------------------------------------------------------------------------
// Transform
// ---------------------------------------------------------------------------

/** "2601303;ay,2601141;ay" -> ["2601303", "2601141"] */
function parseContains(contains: string | null | undefined): string[] {
	if (!contains) return [];
	return contains
		.split(",")
		.map((entry) => entry.split(";")[0].trim())
		.filter((id) => id.length > 0);
}

/**
 * Build the editor tree from the flat OData rows.
 *
 * Roots: ContainedBy === documentId. The sample has no ContainedBy, so as a
 * fallback anything that is not referenced as a child of anything else is a
 * root. References to items missing from the response (partial data) are
 * skipped; duplicate/cyclic references are guarded against.
 */
export function buildTree(items: RawWcItem[], documentId: string): WcNode[] {
	const byId = new Map<string, RawWcItem>();
	for (const it of items) {
		if (it.ID) byId.set(it.ID, it);
	}

	const childRefs = new Set<string>();
	for (const it of items) {
		for (const id of parseContains(it.Contains)) childRefs.add(id);
	}

	const isRoot = (it: RawWcItem): boolean => {
		const parent = it.ContainedBy?.trim();
		if (parent) return parent === documentId;
		return !childRefs.has(it.ID ?? "");
	};

	const seen = new Set<string>();

	const build = (raw: RawWcItem): WcNode => {
		const id = raw.ID ?? "";
		const node: WcNode = {
			id,
			category: raw.Category ?? "Requirement",
			title: raw.F576 ?? "",
			text: raw.F522 ?? "", // kept as HTML (rich text)
			reqId: raw.F531 ?? "",
			children: [],
		};
		seen.add(id);
		for (const childId of parseContains(raw.Contains)) {
			if (seen.has(childId)) continue;
			const child = byId.get(childId);
			if (!child) continue; // partial response: referenced item not included
			node.children.push(build(child));
		}
		return node;
	};

	const roots: WcNode[] = [];
	for (const it of items) {
		const id = it.ID ?? "";
		if (!id || seen.has(id)) continue;
		if (!isRoot(it)) continue;
		roots.push(build(it));
	}
	return roots;
}

export function windchillToSpec(
	items: RawWcItem[],
	documentId: string,
): SpecDoc {
	return {
		format: SPEC_FORMAT,
		version: SPEC_VERSION,
		documentId,
		nodes: buildTree(items, documentId),
	};
}