/**
 * Windchill RV&S Editor — main process (Electrobun / Bun).
 *
 * Responsibilities:
 *   - Create the main window
 *   - Serve RPC requests from the renderer: load/save the spec JSON,
 *     import from Windchill RV&S (see ./windchill.ts), and native dialogs.
 */
import { BrowserView, BrowserWindow, Updater, Utils } from "electrobun/bun";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type {
	AppRPCSchema,
	SpecDoc,
	SpecState,
	WcEditPayload,
} from "../shared/rpcSchema";
import { emptySpec } from "../shared/rpcSchema";
import { fetchWindchillItems, windchillToSpec } from "./windchill";

const DEV_SERVER_PORT = 5173;
const DEV_SERVER_URL = `http://localhost:${DEV_SERVER_PORT}`;

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

const srcDir = dirname(fileURLToPath(import.meta.url)); // <root>/src/bun (dev) or <app>/Resources (bundled)

/**
 * Locate the project root (the directory that holds wc-data.json).
 * In dev the main process is bundled under build/dev-<platform>/<app>/Resources,
 * so walk up from there until the source tree is found.
 */
function findProjectRoot(): string {
	if (process.env.WINDCHILL_EDITOR_ROOT) return process.env.WINDCHILL_EDITOR_ROOT;
	let dir = srcDir;
	for (let i = 0; i < 8; i++) {
		if (existsSync(join(dir, "wc-data.json"))) return dir;
		const parent = dirname(dir);
		if (parent === dir) break;
		dir = parent;
	}
	return srcDir;
}

const projectRoot = findProjectRoot();
const defaultSpecPath = join(projectRoot, "spec.json");

// ---------------------------------------------------------------------------
// Spec file I/O
// ---------------------------------------------------------------------------

function readSpecFile(path: string): SpecDoc {
	if (!existsSync(path)) throw new Error(`file not found: ${path}`);
	const raw = readFileSync(path, "utf-8");
	let data: unknown;
	try {
		data = JSON.parse(raw);
	} catch {
		throw new Error(`not valid JSON: ${path}`);
	}
	const d = data as { nodes?: unknown };
	if (typeof data !== "object" || data === null || !Array.isArray(d.nodes)) {
		throw new Error(`not a windchill-editor spec file: ${path}`);
	}
	return data as SpecDoc;
}

function writeSpecFile(path: string, spec: SpecDoc): void {
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, JSON.stringify(spec, null, 2), "utf-8");
}

// ---------------------------------------------------------------------------
// RPC handlers
// ---------------------------------------------------------------------------

async function handleLoad(path: string): Promise<SpecState> {
	return { path, spec: readSpecFile(path) };
}

async function handleSave(
	path: string,
	spec: SpecDoc,
): Promise<{ ok: boolean; path?: string; error?: string }> {
	try {
		writeSpecFile(path, spec);
		return { ok: true, path };
	} catch (e) {
		return { ok: false, error: e instanceof Error ? e.message : String(e) };
	}
}

async function handleImportWindchill(documentId: string) {
	try {
		const items = await fetchWindchillItems(documentId);
		const spec = windchillToSpec(items, documentId);
		return { ok: true, spec, output: `${items.length} items` };
	} catch (e) {
		return { ok: false, error: e instanceof Error ? e.message : String(e) };
	}
}

// ---------------------------------------------------------------------------
// Edit sync — POST every spec edit to the local edit endpoint
// ---------------------------------------------------------------------------

const EDIT_ENDPOINT = process.env.WINDCHILL_EDIT_URL ?? "http://localhost:7001";

/**
 * POST an edit payload (built by the renderer, shape from wc-req-edit.json)
 * to the local Windchill edit endpoint with Basic auth. Runs in the main
 * process so the webview's CORS never comes into play.
 */
async function handleEditEvent(
	payload: WcEditPayload,
): Promise<{ ok: boolean; error?: string }> {
	try {
		const user = process.env.WINDCHILL_API_USER ?? "";
		const pass = process.env.WINDCHILL_API_PASS ?? "";
		const headers: Record<string, string> = {
			"Content-Type": "application/json",
		};
		if (user || pass) {
			headers.Authorization = `Basic ${Buffer.from(
				`${user}:${pass}`,
			).toString("base64")}`;
		} else {
			console.warn(
				"[editEvent] WINDCHILL_API_USER/PASS not set; sending without Authorization",
			);
		}
		const res = await fetch(EDIT_ENDPOINT, {
			method: "POST",
			headers,
			body: JSON.stringify(payload),
		});
		if (!res.ok) {
			const body = await res.text().catch(() => "");
			return {
				ok: false,
				error: `HTTP ${res.status}${body ? `: ${body.slice(0, 200)}` : ""}`,
			};
		}
		return { ok: true };
	} catch (e) {
		return { ok: false, error: e instanceof Error ? e.message : String(e) };
	}
}

async function pickPath(opts: {
	startingFolder?: string;
	filter?: string;
	canChooseFiles?: boolean;
	canChooseDirectory?: boolean;
}): Promise<{ path: string | null }> {
	const picked = await Utils.openFileDialog({
		startingFolder: opts.startingFolder ?? "~/",
		allowedFileTypes: opts.filter ?? "*",
		canChooseFiles: opts.canChooseFiles ?? true,
		canChooseDirectory: opts.canChooseDirectory ?? false,
		allowsMultipleSelection: false,
	});
	return { path: picked.length > 0 ? picked[0] : null };
}

function ensureExtension(path: string, filter: string | undefined): string {
	if (!filter || filter === "*" || path.includes(".")) return path;
	return `${path}.${filter}`;
}

async function handleConfirm(params: {
	title: string;
	message: string;
	detail?: string;
	confirmLabel?: string;
}): Promise<{ confirmed: boolean }> {
	const { response } = await Utils.showMessageBox({
		type: "question",
		title: params.title,
		message: params.message,
		detail: params.detail ?? "",
		buttons: [params.confirmLabel ?? "OK", "Cancel"],
		defaultId: 1,
		cancelId: 1,
	});
	return { confirmed: response === 0 };
}

// ---------------------------------------------------------------------------
// Window
// ---------------------------------------------------------------------------

async function getMainViewUrl(): Promise<string> {
	const channel = await Updater.localInfo.channel();
	if (channel === "dev") {
		try {
			await fetch(DEV_SERVER_URL, { method: "HEAD" });
			console.log(`HMR enabled: using Vite dev server at ${DEV_SERVER_URL}`);
			return DEV_SERVER_URL;
		} catch {
			console.log("Vite dev server not running; using bundled assets.");
		}
	}
	return "views://mainview/index.html";
}

const rpc = BrowserView.defineRPC<AppRPCSchema>({
	maxRequestTime: 120_000,
	handlers: {
		requests: {
			"spec:new": () => ({ path: "", spec: emptySpec() }),
			"spec:load": ({ path }) => handleLoad(path),
			"spec:save": ({ path, spec }) => handleSave(path, spec),
			"spec:importWindchill": ({ documentId }) =>
				handleImportWindchill(documentId),
			"spec:editEvent": ({ payload }) => handleEditEvent(payload),
			"dialog:pickOpen": ({ filter }) =>
				pickPath({ filter, canChooseFiles: true, canChooseDirectory: false }),
			"dialog:pickSave": async ({ filter }) => {
				const { path } = await pickPath({
					filter,
					canChooseFiles: true,
					canChooseDirectory: false,
				});
				return { path: path ? ensureExtension(path, filter) : null };
			},
			"dialog:confirm": (params) => handleConfirm(params),
		},
	},
});

const url = await getMainViewUrl();

new BrowserWindow({
	title: "Windchill RV&S Editor",
	url,
	frame: {
		width: 1280,
		height: 820,
		x: 120,
		y: 80,
	},
	rpc,
});

// Seed a default spec file on first run so "open" has something to find.
// Re-seed if a stale (old-format) file is present.
if (!existsSync(defaultSpecPath)) {
	writeSpecFile(defaultSpecPath, emptySpec());
	console.log(`Created default spec at ${defaultSpecPath}`);
} else {
	try {
		readSpecFile(defaultSpecPath);
	} catch {
		writeSpecFile(defaultSpecPath, emptySpec());
		console.log(`Re-seeded stale spec at ${defaultSpecPath}`);
	}
}

console.log(`Windchill RV&S Editor started (root: ${projectRoot})`);
