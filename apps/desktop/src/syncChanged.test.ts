import { describe, expect, it, vi } from "vitest";
import type { SyncChanged } from "../../../packages/contracts/generated/SyncChanged";
import { SYNC_CHANGED, listenForVaultChanges, type Unlisten } from "./syncChanged";

function change(over: Partial<SyncChanged> = {}): SyncChanged {
  return {
    revision: 7,
    changedNodeIds: ["one"],
    deletedNodeIds: [],
    ...over
  };
}

function tauri() {
  const handlers: Array<(change: SyncChanged) => void> = [];
  const stops = vi.fn();
  const listen = vi.fn(async (event: string, handler: (change: SyncChanged) => void) => {
    expect(event).toBe(SYNC_CHANGED);
    handlers.push(handler);
    return stops as unknown as Unlisten;
  });
  return { handlers, listen, stops };
}

describe("듣기: vault 변경 알림", () => {
  it("문서 여러 개가 한꺼번에 도착해도 한 번만 다시 읽는다", async () => {
    vi.useFakeTimers();
    const { handlers, listen } = tauri();
    const absorb = vi.fn(async () => undefined);

    listenForVaultChanges(listen, absorb, 500);
    await vi.waitFor(() => expect(handlers).toHaveLength(1));
    for (let index = 0; index < 20; index += 1) {
      handlers[0](change({ changedNodeIds: [`node-${index}`] }));
    }
    vi.advanceTimersByTime(499);

    expect(absorb).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1);

    expect(absorb).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });

  it("도착한 문서들이 말한 것을 합쳐서 한 번에 넘긴다", async () => {
    vi.useFakeTimers();
    const { handlers, listen } = tauri();
    const absorb = vi.fn(async () => undefined);

    listenForVaultChanges(listen, absorb, 500);
    await vi.waitFor(() => expect(handlers).toHaveLength(1));
    handlers[0](change({ revision: 4, changedNodeIds: ["one", "two"] }));
    handlers[0](change({ revision: 9, changedNodeIds: ["three"], deletedNodeIds: ["two"] }));
    vi.advanceTimersByTime(500);

    expect(absorb).toHaveBeenCalledWith({
      revision: 9,
      changedNodeIds: ["one", "three"],
      deletedNodeIds: ["two"]
    });
    vi.useRealTimers();
  });

  it("한 번 넘긴 것은 다음 묶음에 다시 오지 않는다", async () => {
    vi.useFakeTimers();
    const { handlers, listen } = tauri();
    const absorb = vi.fn(async () => undefined);

    listenForVaultChanges(listen, absorb, 500);
    await vi.waitFor(() => expect(handlers).toHaveLength(1));
    handlers[0](change({ changedNodeIds: ["one"] }));
    vi.advanceTimersByTime(500);
    handlers[0](change({ changedNodeIds: ["two"] }));
    vi.advanceTimersByTime(500);

    expect(absorb).toHaveBeenNthCalledWith(2, {
      revision: 7,
      changedNodeIds: ["two"],
      deletedNodeIds: []
    });
    vi.useRealTimers();
  });

  it("구독을 끊으면 이미 예약된 다시 읽기도 취소한다", async () => {
    vi.useFakeTimers();
    const { handlers, listen, stops } = tauri();
    const absorb = vi.fn(async () => undefined);

    const stop = listenForVaultChanges(listen, absorb, 500);
    await vi.waitFor(() => expect(handlers).toHaveLength(1));
    handlers[0](change());
    stop();
    vi.advanceTimersByTime(1_000);

    expect(absorb).not.toHaveBeenCalled();
    expect(stops).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });

  it("구독이 자리잡기 전에 해제해도 그 구독은 끊긴다", async () => {
    const { listen, stops } = tauri();

    // What a development double mount does: mount, unmount, before the
    // subscription's promise has settled.
    const stop = listenForVaultChanges(listen, async () => undefined, 500);
    stop();
    await vi.waitFor(() => expect(stops).toHaveBeenCalledTimes(1));

    expect(stops).toHaveBeenCalledTimes(1);
  });

  it("두 번 붙였다 떼도 남는 구독이 없다", async () => {
    const first = tauri();
    const second = tauri();

    const stopFirst = listenForVaultChanges(first.listen, async () => undefined, 500);
    const stopSecond = listenForVaultChanges(second.listen, async () => undefined, 500);
    await vi.waitFor(() => expect(second.handlers).toHaveLength(1));
    stopFirst();
    stopSecond();
    stopFirst();

    expect(first.stops).toHaveBeenCalledTimes(1);
    expect(second.stops).toHaveBeenCalledTimes(1);
  });
});
