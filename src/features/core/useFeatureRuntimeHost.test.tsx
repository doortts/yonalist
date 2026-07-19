import { act, renderHook, waitFor } from "@testing-library/react";
import { Circle } from "lucide-react";
import type { PropsWithChildren } from "react";
import { describe, expect, it, vi } from "vitest";
import type {
  FeatureDefinition,
  FeatureId,
  FeatureRuntime
} from "./featureTypes";
import { useFeatureRuntimeHost } from "./useFeatureRuntimeHost";

function PassthroughProvider({ children }: PropsWithChildren) {
  return <>{children}</>;
}

function runtime(label: string): FeatureRuntime {
  return {
    Provider: PassthroughProvider,
    renderPanes: () => ({
      middle: <div>{label} middle</div>,
      detail: <div>{label} detail</div>
    })
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

const inboxRuntime = runtime("Inbox");

function definitions(
  loadNotes: () => Promise<FeatureRuntime>
): readonly FeatureDefinition[] {
  return [
    {
      id: "inbox",
      label: "Inbox",
      icon: Circle,
      section: "workspace",
      order: 10,
      requiresGithubAuth: true,
      keepMounted: false,
      runtime: inboxRuntime
    },
    {
      id: "notes",
      label: "Notes",
      icon: Circle,
      section: "workspace",
      order: 20,
      requiresGithubAuth: false,
      keepMounted: true,
      loadRuntime: loadNotes
    }
  ];
}

describe("useFeatureRuntimeHost", () => {
  it("makes an eager feature ready on the first render", () => {
    const hostDefinitions = definitions(
      vi.fn<() => Promise<FeatureRuntime>>()
    );
    const { result } = renderHook(() =>
      useFeatureRuntimeHost("inbox", hostDefinitions)
    );

    expect(result.current.active).toEqual({
      status: "ready",
      runtime: inboxRuntime
    });
  });

  it("loads a lazy feature and retains it across navigation", async () => {
    const pending = deferred<FeatureRuntime>();
    const notesRuntime = runtime("Notes");
    const loadRuntime = vi.fn(() => pending.promise);
    const hostDefinitions = definitions(loadRuntime);
    const { result, rerender } = renderHook(
      ({ activeFeatureId }: { activeFeatureId: FeatureId }) =>
        useFeatureRuntimeHost(activeFeatureId, hostDefinitions),
      { initialProps: { activeFeatureId: "notes" as FeatureId } }
    );

    expect(result.current.active.status).toBe("loading");
    await act(async () => {
      pending.resolve(notesRuntime);
      await pending.promise;
    });
    expect(result.current.active).toEqual({
      status: "ready",
      runtime: notesRuntime
    });

    rerender({ activeFeatureId: "inbox" });
    rerender({ activeFeatureId: "notes" });

    expect(result.current.active).toEqual({
      status: "ready",
      runtime: notesRuntime
    });
    expect(loadRuntime).toHaveBeenCalledOnce();
  });

  it("stores a lazy result that resolves while another feature is active", async () => {
    const pending = deferred<FeatureRuntime>();
    const notesRuntime = runtime("Notes");
    const hostDefinitions = definitions(() => pending.promise);
    const { result, rerender } = renderHook(
      ({ activeFeatureId }: { activeFeatureId: FeatureId }) =>
        useFeatureRuntimeHost(activeFeatureId, hostDefinitions),
      { initialProps: { activeFeatureId: "notes" as FeatureId } }
    );

    rerender({ activeFeatureId: "inbox" });
    await act(async () => {
      pending.resolve(notesRuntime);
      await pending.promise;
    });

    expect(result.current.active).toEqual({
      status: "ready",
      runtime: inboxRuntime
    });
    expect(result.current.readyRuntimes.get("notes")).toBe(notesRuntime);
  });

  it("moves from failure through retry to ready", async () => {
    const first = deferred<FeatureRuntime>();
    const second = deferred<FeatureRuntime>();
    const notesRuntime = runtime("Notes retry");
    const loadRuntime = vi
      .fn<() => Promise<FeatureRuntime>>()
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);
    const hostDefinitions = definitions(loadRuntime);
    const { result } = renderHook(() =>
      useFeatureRuntimeHost("notes", hostDefinitions)
    );

    await act(async () => {
      first.reject(new Error("chunk unavailable"));
      await first.promise.catch(() => undefined);
    });
    expect(result.current.active).toMatchObject({ status: "failed" });

    act(() => result.current.retry());
    expect(result.current.active.status).toBe("loading");
    await act(async () => {
      second.resolve(notesRuntime);
      await second.promise;
    });

    expect(result.current.active).toEqual({
      status: "ready",
      runtime: notesRuntime
    });
    expect(loadRuntime).toHaveBeenCalledTimes(2);
  });

  it("does not let an older request overwrite a retry result", async () => {
    const first = deferred<FeatureRuntime>();
    const second = deferred<FeatureRuntime>();
    const oldRuntime = runtime("Old Notes");
    const latestRuntime = runtime("Latest Notes");
    const loadRuntime = vi
      .fn<() => Promise<FeatureRuntime>>()
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);
    const hostDefinitions = definitions(loadRuntime);
    const { result } = renderHook(() =>
      useFeatureRuntimeHost("notes", hostDefinitions)
    );

    act(() => result.current.retry());
    await act(async () => {
      second.resolve(latestRuntime);
      await second.promise;
    });
    await act(async () => {
      first.resolve(oldRuntime);
      await first.promise;
    });

    await waitFor(() =>
      expect(result.current.readyRuntimes.get("notes")).toBe(latestRuntime)
    );
    expect(result.current.active).toEqual({
      status: "ready",
      runtime: latestRuntime
    });
  });
});
