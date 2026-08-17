import { render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { SyncStatus } from "../../../packages/contracts/generated/SyncStatus";
import { SyncStatusBadge } from "./SyncStatusBadge";

const WELL: SyncStatus = { refused: [], writeError: null, watchError: null };

function badge(
  status: SyncStatus,
  subscribe: (moved: () => void) => () => void = () => () => {}
) {
  const readStatus = vi.fn(async () => status);
  render(<SyncStatusBadge readStatus={readStatus} subscribe={subscribe} />);
  return readStatus;
}

describe("동기화 상태 배지", () => {
  it("잘 돌아가는 동안에는 아무것도 보이지 않는다", async () => {
    const readStatus = badge(WELL);

    await waitFor(() => expect(readStatus).toHaveBeenCalled());

    expect(screen.queryByRole("status")).toBeNull();
  });

  it("읽지 못한 파일의 이름과 이유를 말한다", async () => {
    badge({
      ...WELL,
      refused: [{ path: "journal/today.md", reason: "이 앱이 읽는 문서가 아니에요" }]
    });

    expect(await screen.findByRole("status")).toBeTruthy();
    expect(
      screen.getByText("journal/today.md — 이 앱이 읽는 문서가 아니에요")
    ).toBeTruthy();
    expect(screen.getByText("읽지 못한 파일 1개")).toBeTruthy();
  });

  it("폴더를 못 쓰거나 못 지켜보는 것도 말한다", async () => {
    badge({
      refused: [],
      writeError: "읽기 전용 폴더예요",
      watchError: "폴더가 없어요"
    });

    expect(await screen.findByText("폴더에 쓰지 못했어요: 읽기 전용 폴더예요")).toBeTruthy();
    expect(screen.getByText("폴더를 지켜보지 못하고 있어요: 폴더가 없어요")).toBeTruthy();
  });

  /// The event says only that something moved, so the badge has to ask again.
  it("상태가 움직였다는 알림을 받으면 다시 묻는다", async () => {
    let moved = () => {};
    const readStatus = badge(WELL, vi.fn((notify: () => void) => {
      moved = notify;
      return vi.fn();
    }));
    await waitFor(() => expect(readStatus).toHaveBeenCalledTimes(1));

    moved();

    await waitFor(() => expect(readStatus).toHaveBeenCalledTimes(2));
  });

  it("떼어내면 구독도 끊는다", async () => {
    const stop = vi.fn();
    const readStatus = vi.fn(async () => WELL);
    const { unmount } = render(
      <SyncStatusBadge readStatus={readStatus} subscribe={vi.fn(() => stop)} />
    );
    await waitFor(() => expect(readStatus).toHaveBeenCalled());

    unmount();

    expect(stop).toHaveBeenCalledTimes(1);
  });
});
