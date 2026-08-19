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
	const rpc = Electroview.defineRPC<AppRPCSchema>({ maxRequestTime: 120_000,
		handlers: { requests: {} },
	});
	new Electroview({ rpc });
	requestProxy = rpc.request as unknown as RequestProxy;
} else {
	console.warn(
		"[requirements-explorer] not running inside Electrobun; using in-memory IPC fallback",
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
			const raw = localStorage.getItem("req-explorer-spec");
			if (raw) {
				const parsed = JSON.parse(raw) as SpecDoc;
				if (Array.isArray(parsed.blocks)) return parsed;
			}
		} catch {
			/* ignore */
		}
		return emptySpec();
	})();
	spec = store;

	const persist = () => {
		try {
			localStorage.setItem("req-explorer-spec", JSON.stringify(spec));
		} catch {
			/* ignore */
		}
	};

	return {
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
		"spec:new": async () => {
			spec = emptySpec();
			path = "";
			persist();
			return { path, spec };
		},
		"spec:import": async ({ path: p, format }) => {
			path = p;
			persist();
			return { ok: true, spec, output: `(fallback) ${format}` };
		},
		"spec:export": async ({ path: p, format }) => {
			persist();
			return { ok: true, output: `(fallback) ${p} [${format}]` };
		},
		"dialog:pickOpen": async () => ({ path: null }),
		"dialog:pickSave": async () => ({ path: null }),
		"dialog:confirm": async () => ({ confirmed: true }),
	};
}
