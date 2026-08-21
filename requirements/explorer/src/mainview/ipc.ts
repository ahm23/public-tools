/**
 * Renderer-side IPC: wraps the Electrobun RPC proxy so the UI can call
 * main-process handlers with full types. Falls back to an in-memory mock
 * when running outside the Electrobun shell (e.g. plain browser dev).
 */
import { Electroview } from "electrobun/view";
import type { AppRPCSchema, AppRequests, SpecDoc } from "../shared/rpcSchema";
import { emptySpec } from "../shared/rpcSchema";

type RequestProxy = {
	[K in keyof AppRequests]: (
		...args: undefined extends AppRequests[K]["params"]
			? []
			: [params: AppRequests[K]["params"]]
	) => Promise<AppRequests[K]["response"]>;
};

const inElectrobun =
	typeof window !== "undefined" &&
	typeof (window as unknown as Record<string, unknown>).__electrobun === "object";

let requestProxy: RequestProxy;

if (inElectrobun) {
	// The default RPC request timeout is 1s; raise it so native file dialogs
	// (which stay open while the user browses) and slow imports don't get
	// killed with "RPC request timed out.".
	const rpc = Electroview.defineRPC<AppRPCSchema>({
		maxRequestTime: 120_000,
		handlers: { requests: {} },
	});
	new Electroview({ rpc });
	requestProxy = rpc.request as unknown as RequestProxy;
} else {
	console.warn(
		"[windchill-editor] not running inside Electrobun; using in-memory IPC fallback",
	);
	requestProxy = createFallbackProxy();
}

export const ipc = requestProxy;

// ---------------------------------------------------------------------------
// Browser fallback (no persistence)
// ---------------------------------------------------------------------------

function createFallbackProxy(): RequestProxy {
	let spec: SpecDoc = emptySpec();
	let path = "";

	const store = (() => {
		try {
			const raw = localStorage.getItem("wc-editor-spec");
			if (raw) {
				const parsed = JSON.parse(raw) as SpecDoc;
				if (Array.isArray(parsed.nodes)) return parsed;
			}
		} catch {
			/* ignore */
		}
		return emptySpec();
	})();
	spec = store;

	const persist = () => {
		try {
			localStorage.setItem("wc-editor-spec", JSON.stringify(spec));
		} catch {
			/* ignore */
		}
	};

	return {
		"spec:new": async () => {
			spec = emptySpec();
			path = "";
			persist();
			return { path, spec };
		},
		"spec:load": async ({ path: p }) => {
			path = p;
			persist();
			return { path, spec };
		},
		"spec:save": async ({ spec: s }) => {
			spec = s;
			persist();
			return { ok: true, path: path || "localStorage" };
		},
		"spec:importWindchill": async () => ({
			ok: false,
			error: "Windchill import requires the desktop app",
		}),
		"dialog:pickOpen": async () => ({ path: null }),
		"dialog:pickSave": async () => ({ path: null }),
		"dialog:confirm": async () => ({ confirmed: true }),
		"spec:editEvent": async ({ payload }) => {
			console.log("[editEvent] (browser fallback)", JSON.stringify(payload));
			return { ok: true };
		},
	};
}
