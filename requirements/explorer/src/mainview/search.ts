/**
 * Find / find-and-replace helpers for the spec table.
 *
 * By default the Text column is matched against its rendered plain text,
 * and replacing operates on the raw rich-text HTML with guards: it tolerates
 * common entities (`&amp;`, `&lt;`, …) and refuses to rewrite matches that
 * sit inside a tag, and the replacement is HTML-escaped.
 *
 * When `scope.raw` is set, the Text column is matched and replaced against
 * the raw HTML source instead — literal match, no tag guard, replacement
 * inserted verbatim — so markup such as `<a href="…">` can be found and
 * rewritten directly.
 */

import type { WcNode } from "../shared/rpcSchema";

/** Columns the find feature can scan. */
export type FindColumn = "title" | "text";

export interface FindScope {
	title: boolean;
	text: boolean;
	caseSensitive: boolean;
	raw: boolean;
}

export interface FindMatch {
	nodeId: string;
	column: FindColumn;
}

export interface ReplaceResult {
	value: string;
	count: number;
}

export function escapeRegExp(s: string): string {
	return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Plain text of an HTML fragment, for matching what the user sees. */
export function plainText(html: string): string {
	if (!html) return "";
	try {
		const doc = new DOMParser().parseFromString(html, "text/html");
		return doc.body.textContent ?? "";
	} catch {
		return html.replace(/<[^>]*>/g, "");
	}
}

/** Substring search over the scoped columns of every node, in document order. */
export function findMatches(
	nodes: WcNode[],
	query: string,
	scope: FindScope,
): FindMatch[] {
	const q = query.trim();
	if (!q) return [];
	const lower = q.toLowerCase();
	const out: FindMatch[] = [];
	const walk = (list: WcNode[]) => {
		for (const node of list) {
			if (scope.title) {
				const hay = node.title;
				if (
					scope.caseSensitive
						? hay.includes(q)
						: hay.toLowerCase().includes(lower)
				) {
					out.push({ nodeId: node.id, column: "title" });
				}
			}
			if (scope.text) {
				const hay = scope.raw ? node.text : plainText(node.text);
				if (
					scope.caseSensitive
						? hay.includes(q)
						: hay.toLowerCase().includes(lower)
				) {
					out.push({ nodeId: node.id, column: "text" });
				}
			}
			walk(node.children);
		}
	};
	walk(nodes);
	return out;
}

/** Regex matching `needle` inside raw HTML, tolerating common entities. */
function htmlSearchRegex(needle: string, caseSensitive: boolean): RegExp {
	let out = "";
	for (const ch of needle) {
		if (ch === "&") out += "&(?:amp;|#38;|#x26;)?";
		else if (ch === "<") out += "&lt;|&#60;|&#x3C;|<";
		else if (ch === ">") out += "&gt;|&#62;|&#x3E;|>";
		else if (ch === '"') out += "&quot;|&#34;|&#x22;|\"";
		else if (ch === "'") out += "&apos;|&#39;|&#x27;|'";
		else out += escapeRegExp(ch);
	}
	return new RegExp(out, caseSensitive ? "g" : "gi");
}

/** True when `index` in `html` falls between a `<` and the next `>`. */
function insideTag(html: string, index: number): boolean {
	for (let i = index - 1; i >= 0; i--) {
		if (html[i] === ">") return false;
		if (html[i] === "<") return true;
	}
	return false;
}

/** HTML-escape text inserted into the rich-text field. */
export function escapeHtml(s: string): string {
	return s
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&#39;");
}

function replaceFirstInHtml(
	html: string,
	needle: string,
	replacement: string,
	caseSensitive: boolean,
): string {
	if (!needle) return html;
	const rx = htmlSearchRegex(needle, caseSensitive);
	const esc = escapeHtml(replacement);
	let m: RegExpExecArray | null;
	while ((m = rx.exec(html)) !== null) {
		if (!insideTag(html, m.index)) {
			return html.slice(0, m.index) + esc + html.slice(m.index + m[0].length);
		}
	}
	return html;
}

function replaceAllInHtml(
	html: string,
	needle: string,
	replacement: string,
	caseSensitive: boolean,
): ReplaceResult {
	if (!needle) return { value: html, count: 0 };
	const rx = htmlSearchRegex(needle, caseSensitive);
	const esc = escapeHtml(replacement);
	let out = html;
	let count = 0;
	// Cap the loop so a replacement that re-introduces the needle cannot run away.
	for (let guard = 0; guard < 100000; guard++) {
		const m = rx.exec(out);
		if (m === null) break;
		if (!insideTag(out, m.index)) {
			out = out.slice(0, m.index) + esc + out.slice(m.index + m[0].length);
			count += 1;
			rx.lastIndex = m.index + esc.length;
		}
	}
	return { value: out, count };
}

/** Replace the first occurrence in a field's current value. */
export function replaceFirst(
	field: FindColumn,
	current: string,
	needle: string,
	replacement: string,
	caseSensitive: boolean,
	raw: boolean,
): string {
	if (!needle) return current;
	if (field === "title" || raw) {
		// Literal replace — no entity tolerance, replacement inserted verbatim.
		return current.replace(
			new RegExp(escapeRegExp(needle), caseSensitive ? "" : "i"),
			replacement,
		);
	}
	return replaceFirstInHtml(current, needle, replacement, caseSensitive);
}

/** Replace every occurrence in a field's current value. */
export function replaceAll(
	field: FindColumn,
	current: string,
	needle: string,
	replacement: string,
	caseSensitive: boolean,
	raw: boolean,
): ReplaceResult {
	if (!needle) return { value: current, count: 0 };
	if (field === "title" || raw) {
		const rx = new RegExp(escapeRegExp(needle), caseSensitive ? "g" : "gi");
		return {
			value: current.replace(rx, replacement),
			count: (current.match(rx) ?? []).length,
		};
	}
	return replaceAllInHtml(current, needle, replacement, caseSensitive);
}
