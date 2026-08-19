/**
 * Requirements Explorer — main process (Electrobun / Bun).
 *
 * Responsibilities:
 *   - Create the main window
 *   - Serve RPC requests from the renderer: load/save the spec JSON,
 *     import/export DOCX and XLSX by spawning the Python converters in
 *     converters/ (JSON-over-files protocol), and native dialogs.
 */
import { BrowserView, BrowserWindow, Updater, Utils } from "electrobun/bun";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { AppRPCSchema, SpecDoc, SpecState } from "../shared/rpcSchema";
import { emptySpec, SPEC_FORMAT, SPEC_VERSION } from "../shared/rpcSchema";

const DEV_SERVER_PORT = 5173;
const DEV_SERVER_URL = `http://localhost:${DEV_SERVER_PORT}`;

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

const srcDir = dirname(fileURLToPath(import.meta.url)); // <root>/src/bun (dev) or <app>/Resources (bundled)

/**
 * Locate the project root that contains converters/req_convert.py.
 * In dev the main process is bundled under build/dev-<platform>/<app>/Resources,
 * so walk up from there until the source tree is found.
 */
function findProjectRoot(): string {
	if (process.env.REQ_EXPLORER_ROOT) return process.env.REQ_EXPLORER_ROOT;
	let dir = srcDir;
	for (let i = 0; i < 8; i++) {
		if (existsSync(join(dir, "converters", "req_convert.py"))) return dir;
		const parent = dirname(dir);
		if (parent === dir) break;
		dir = parent;
	}
	if (existsSync(join(process.cwd(), "converters", "req_convert.py"))) {
		return process.cwd();
	}
	return srcDir;
}

const projectRoot = findProjectRoot();
const convertersDir = join(projectRoot, "converters");
const converterScript = join(convertersDir, "req_convert.py");
const venvPython = join(convertersDir, ".venv", "bin", "python");
const pythonBin = existsSync(venvPython) ? venvPython : "python";
const defaultSpecPath = join(projectRoot, "spec.json");

// ---------------------------------------------------------------------------
// Converter spawn (JSON over files)
// ---------------------------------------------------------------------------

interface ConverterOutcome {
	ok: boolean;
	output?: string;
	error?: string;
}

async function runConverter(
	subcommand: string,
	args: string[],
): Promise<ConverterOutcome> {
	const proc = Bun.spawn({
		cmd: [pythonBin, converterScript, subcommand, ...args],
		cwd: convertersDir,
		stdout: "pipe",
		stderr: "pipe",
	});

	const [stdout, stderr] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
	]);
	const exit = await proc.exited;

	if (exit !== 0) {
		const detail = stderr.trim() || stdout.trim() || `exit code ${exit}`;
		return { ok: false, error: `converter failed: ${detail}` };
	}
	try {
		const result = JSON.parse(stdout.trim().split("\n").pop() ?? "{}");
		if (result?.ok === false) return { ok: false, error: result.error ?? "conversion failed" };
		return { ok: true, output: result?.output };
	} catch {
		return { ok: false, error: `converter returned invalid JSON: ${stdout.slice(0, 200)}` };
	}
}

function tempJsonPath(prefix: string): string {
	return join(tmpdir(), `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2)}.json`);
}

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
	const d = data as { blocks?: unknown };
	if (
		typeof data !== "object" ||
		data === null ||
		!Array.isArray(d.blocks)
	) {
		throw new Error(`not a requirements-explorer spec file: ${path}`);
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

async function handleSave(path: string, spec: SpecDoc): Promise<{ ok: boolean; path?: string; error?: string }> {
	try {
		writeSpecFile(path, spec);
		return { ok: true, path };
	} catch (e) {
		return { ok: false, error: e instanceof Error ? e.message : String(e) };
	}
}

async function handleImport(
	format: "docx" | "xlsx",
	path: string,
): Promise<{ ok: boolean; spec?: SpecDoc; error?: string; output?: string }> {
	const subcommand = format === "docx" ? "docx2json" : "xlsx2json";
	const tmp = tempJsonPath("req_import");
	const outcome = await runConverter(subcommand, [path, tmp]);
	if (!outcome.ok) return outcome;

	try {
		const spec = readSpecFile(tmp);
		return { ok: true, spec, output: outcome.output };
	} catch (e) {
		return { ok: false, error: e instanceof Error ? e.message : String(e) };
	} finally {
		rmSync(tmp, { force: true });
	}
}

async function handleExport(
	format: "docx" | "xlsx",
	path: string,
	spec: SpecDoc,
): Promise<{ ok: boolean; error?: string; output?: string }> {
	const tmp = tempJsonPath("req_export");
	writeSpecFile(tmp, spec);
	try {
		const subcommand = format === "docx" ? "json2docx" : "json2xlsx";
		return await runConverter(subcommand, [tmp, path]);
	} finally {
		rmSync(tmp, { force: true });
	}
}

async function pickPath(opts: {
	startingFolder?: string;
	filter?: string;
	canChooseFiles?: boolean;
	canChooseDirectory?: boolean;
}): Promise<{ path: string | null }> {
	const picked = await Utils.openFileDialog({
		startingFolder: opts.startingFolder ?? "~",
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
	maxRequestTime: 120_000, // conversions can take a few seconds
	handlers: {
		requests: {
			"spec:load": ({ path }) => handleLoad(path),
			"spec:save": ({ path, spec }) => handleSave(path, spec),
			"spec:new": () => ({ path: "", spec: emptySpec() }),
			"spec:import": ({ format, path }) => handleImport(format, path),
			"spec:export": ({ format, path, spec }) => handleExport(format, path, spec),
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
	title: "Requirements Explorer",
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
if (!existsSync(defaultSpecPath)) {
	try {
		writeSpecFile(defaultSpecPath, {
			format: SPEC_FORMAT,
			version: SPEC_VERSION,
			blocks: [],
		});
		console.log(`Created default spec at ${defaultSpecPath}`);
	} catch (e) {
		console.error("Failed to seed default spec:", e);
	}
}

console.log(`Requirements Explorer started (root: ${projectRoot}, converter: ${pythonBin})`);
