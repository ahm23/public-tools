/**
 * Word paste normalization for the rich text editor.
 *
 * MS Word puts lists on the clipboard as flat paragraphs carrying
 * `mso-list` styles, with the bullet/number glyph rendered in a
 * `<span style="mso-list:Ignore">…</span>` (usually inside
 * `<!--[if !supportLists]>…<![endif]-->` comments), and the list format
 * declared in a `<style>` block (`@list l0:level1 { mso-number-format:… }`).
 *
 * This module converts that into real nested `<ul>/<ol>/<li>` markup and
 * strips the Word cruft (`mso-*` styles, `Mso*` classes, `o:`/`w:` elements,
 * conditional comments). Non-Word HTML passes through essentially untouched.
 */

/** Glyph characters that mark an unordered (bulleted) list item. */
const BULLET_CHARS = /[•◦▪‣–—*·-]/;

/** `mso-list:l0 level1 lfo1` → { listId: "l0", level: 1 } */
function parseMsoList(style: string): { listId: string; level: number } | null {
	const m = style.match(/mso-list\s*:\s*l(\d+)\s+level(\d+)\s+lfo\d+/i);
	if (!m) return null;
	return { listId: "l" + m[1], level: parseInt(m[2], 10) };
}

/**
 * True when the paragraph carries a list glyph. Word commonly wraps the
 * glyph span in `<!--[if !supportLists]>…<![endif]-->` comments, where
 * querySelector cannot see it — so also scan comment text.
 */
function hasGlyphSpan(el: HTMLElement): boolean {
	if (el.querySelector('span[style*="mso-list"]')) return true;
	const walker = el.ownerDocument.createTreeWalker(
		el,
		NodeFilter.SHOW_COMMENT,
	);
	while (walker.nextNode()) {
		if (/mso-list|supportLists/i.test(walker.currentNode.data)) return true;
	}
	return false;
}

/** First glyph character, from the span or the Word comment wrapper. */
function glyphChar(el: HTMLElement): string {
	const span = el.querySelector('span[style*="mso-list"]');
	if (span) {
		return (span.textContent ?? "").trim().charAt(0);
	}
	const walker = el.ownerDocument.createTreeWalker(
		el,
		NodeFilter.SHOW_COMMENT,
	);
	while (walker.nextNode()) {
		const m = walker.currentNode.data.match(BULLET_CHARS);
		if (m) return m[0];
	}
	return "";
}

interface WordListItem {
	el: HTMLElement;
	listId: string;
	level: number;
	/** True when this paragraph carries the list glyph (i.e. starts an item). */
	hasGlyph: boolean;
}

/** Read list formats from Word's `<style>` block: listId → "ul" | "ol". */
function resolveListTypes(doc: Document): Map<string, "ul" | "ol"> {
	const out = new Map<string, "ul" | "ol">();
	const rx = /@list\s+(l\d+):level1\s*\{([^}]*)\}/g;
	for (const style of Array.from(doc.querySelectorAll("style"))) {
		const css = style.textContent ?? "";
		let m: RegExpExecArray | null;
		while ((m = rx.exec(css)) !== null) {
			const block = m[2];
			const isBullet =
				/mso-number-format\s*:\s*bullet/i.test(block) ||
				/mso-level-text\s*:\s*["']?[•◦▪‣–—*·-]/i.test(block);
			out.set(m[1], isBullet ? "ul" : "ol");
		}
	}
	return out;
}

/** True when an element's class list is Word-generated (Mso*, ms-*, WordSection*). */
function isWordClass(c: string): boolean {
	return /^(Mso|ms-|WordSection)/i.test(c);
}

export function normalizeWordPaste(html: string): string {
	const doc = new DOMParser().parseFromString(html, "text/html");
	const body = doc.body;
	if (!body) return html;

	// 1. Detect Word list paragraphs BEFORE touching styles.
	const items: WordListItem[] = [];
	for (const el of Array.from(body.querySelectorAll("p,div,li"))) {
		const info = parseMsoList((el as HTMLElement).getAttribute("style") ?? "");
		if (info) {
			items.push({
				el: el as HTMLElement,
				listId: info.listId,
				level: info.level,
				hasGlyph: hasGlyphSpan(el as HTMLElement),
			});
		}
	}
	const infoByEl = new Map<HTMLElement, WordListItem>();
	for (const it of items) infoByEl.set(it.el, it);

	// 2. List formats: style block first, glyph text as fallback.
	const listTypes = resolveListTypes(doc);
	const glyphTypes = new Map<string, "ul" | "ol">();
	for (const it of items) {
		if (glyphTypes.has(it.listId)) continue;
		const glyph = glyphChar(it.el);
		if (!glyph) continue;
		glyphTypes.set(it.listId, BULLET_CHARS.test(glyph) ? "ul" : "ol");
	}
	const getListType = (id: string): "ul" | "ol" =>
		listTypes.get(id) ?? glyphTypes.get(id) ?? "ul";

	// 3. Drop Word comments (includes the `[if !supportLists]` glyph wrappers).
	const walker = doc.createTreeWalker(body, NodeFilter.SHOW_COMMENT);
	const comments: Comment[] = [];
	while (walker.nextNode()) comments.push(walker.currentNode as Comment);
	for (const c of comments) c.remove();

	// 4. Remove glyph spans (for Word versions that emit them without comments).
	for (const it of items) {
		for (const s of Array.from(it.el.querySelectorAll('span[style*="mso-list"]'))) {
			s.remove();
		}
	}

	// 5. Strip Word junk: <xml>/<style> blocks and o:/w:/v: elements.
	for (const el of Array.from(body.querySelectorAll("xml,style"))) el.remove();
	for (const el of Array.from(body.querySelectorAll("*"))) {
		const tag = el.tagName.toLowerCase();
		if (!/^[a-z]+:/.test(tag)) continue;
		if (tag === "o:p" && el.children.length === 0) el.remove();
		else el.replaceWith(...Array.from(el.childNodes));
	}

	// 6. Remove Word classes and mso-* styles. List paragraphs also lose the
	//    Word indentation (the real indentation comes from the rebuilt list).
	for (const el of Array.from(body.querySelectorAll("[class]"))) {
		const kept = (el.getAttribute("class") ?? "")
			.split(/\s+/)
			.filter((c) => c && !isWordClass(c))
			.join(" ");
		if (kept) el.setAttribute("class", kept);
		else el.removeAttribute("class");
	}
	for (const el of Array.from(body.querySelectorAll("[style]"))) {
		const decls = (el.getAttribute("style") ?? "")
			.split(";")
			.map((d) => d.trim())
			.filter(Boolean);
		const kept = decls.filter((d) => {
			if (/^mso-|^tab-stops/i.test(d)) return false;
			if (infoByEl.has(el as HTMLElement) && /^(margin|padding|text-indent)/i.test(d)) {
				return false;
			}
			return true;
		});
		if (kept.length) el.setAttribute("style", kept.join(";"));
		else el.removeAttribute("style");
	}

	// 7. Rebuild the list structure from the flat paragraph run.
	const frag = doc.createDocumentFragment();
	const stack: {
		level: number;
		listId: string;
		list: HTMLElement;
		li: HTMLElement | null;
	}[] = [];

	// A list is attached exactly once, when it is popped: under the open item
	// of the enclosing list, or at the top level when nothing encloses it.
	const popList = () => {
		const open = stack.pop()!;
		const parent = stack[stack.length - 1];
		if (parent && parent.li) parent.li.appendChild(open.list);
		else frag.appendChild(open.list);
	};
	const flush = () => {
		while (stack.length) popList();
	};

	for (const child of Array.from(body.childNodes)) {
		if (!(child instanceof HTMLElement)) continue;
		const info = infoByEl.get(child);

		if (!info) {
			flush();
			frag.appendChild(child);
			continue;
		}

		const top = stack[stack.length - 1];
		if (top && top.level === info.level && !info.hasGlyph) {
			// Continuation paragraph of the open item (Word splits wrapped
			// items into several same-level paragraphs, only the first has
			// the glyph). Keep it as a <p> inside the <li>.
			const p = doc.createElement("p");
			p.append(...Array.from(child.childNodes));
			top.li?.appendChild(p);
			child.remove();
			continue;
		}

		// Pop lists this item cannot join: deeper levels, or a different
		// list at the same level. Items at the same level of the same list
		// reuse the open list.
		while (
			stack.length &&
			(stack[stack.length - 1].level > info.level ||
				(stack[stack.length - 1].level === info.level &&
					stack[stack.length - 1].listId !== info.listId))
		) {
			popList();
		}

		if (!stack.length || stack[stack.length - 1].level !== info.level) {
			// New list run (top-level, deeper, or a different list id).
			stack.push({
				level: info.level,
				listId: info.listId,
				list: doc.createElement(getListType(info.listId)),
				li: null,
			});
		}

		const open = stack[stack.length - 1];
		const li = doc.createElement("li");
		li.append(...Array.from(child.childNodes));
		open.list.appendChild(li);
		open.li = li;
		child.remove();
	}
	flush();

	body.replaceChildren(frag);
	return body.innerHTML;
}
