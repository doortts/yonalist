const viteEnv = (import.meta as unknown as {
  env?: Record<string, string | undefined>;
}).env;
const enabled = viteEnv?.VITE_YONALIST_PERF === "1";
const once = new Set<string>();

export function tracePerf(
  name: string,
  detail: Record<string, unknown> = {}
) {
  if (!enabled || typeof performance === "undefined") {
    return;
  }

  const elapsedMs = performance.now();
  const payload = {
    name,
    elapsedMs,
    detail
  };
  console.info("YONALIST_PERF", payload);

  void import("@tauri-apps/api/core")
    .then(({ invoke }) =>
      invoke("record_perf_event", {
        name,
        elapsedMs,
        detail: JSON.stringify(detail)
      })
    )
    .catch(() => undefined);
}

export function tracePerfOnce(
  key: string,
  name: string,
  detail: Record<string, unknown> = {}
) {
  if (once.has(key)) {
    return;
  }
  once.add(key);
  tracePerf(name, detail);
}
