interface CloseRequestEvent {
  preventDefault(): void;
}

export function createCloseRequestHandler(
  flush: () => Promise<unknown>,
  destroy: () => Promise<unknown>
) {
  let phase: "idle" | "flushing" | "destroying" = "idle";
  return async (event: CloseRequestEvent) => {
    if (phase === "destroying") return;
    event.preventDefault();
    if (phase === "flushing") return;
    phase = "flushing";
    try {
      await flush();
      phase = "destroying";
      await destroy();
    } catch {
      phase = "idle";
    }
  };
}
