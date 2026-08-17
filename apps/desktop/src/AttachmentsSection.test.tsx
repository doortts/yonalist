import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { SyncAttachment } from "../../../packages/contracts/generated/SyncAttachment";
import { AttachmentsSection, daysLeft, formatSize } from "./AttachmentsSection";

const NOW = 1_760_000_000_000;

function attachment(over: Partial<SyncAttachment> = {}): SyncAttachment {
  return {
    nodeId: "Nd0000000002",
    name: "holiday.png",
    byteLength: 2_400_000,
    contentHash: "9f2c1b7a4e6d",
    pageId: "PrJects00001",
    pageTitle: "Projects",
    parentTitle: "Trip notes",
    references: 1,
    trashed: false,
    unreferencedAt: null,
    ...over
  };
}

describe("첨부 목록", () => {
  it("큰 파일이 먼저 오고 안 쓰이는 줄에 남은 기간이 보인다", async () => {
    const rows = [
      attachment(),
      attachment({
        nodeId: "",
        name: "old-1111.png",
        byteLength: 900,
        contentHash: "1111",
        references: 0,
        unreferencedAt: (NOW - 4 * 86_400_000) / 1_000
      })
    ];

    render(
      <AttachmentsSection
        readAttachments={vi.fn(async () => rows)}
        deleteAttachment={vi.fn(async () => true)}
        openNode={vi.fn()}
        now={() => NOW}
      />
    );

    await screen.findByText("holiday.png");
    expect(screen.getByText("2.3 MB")).toBeTruthy();
    expect(screen.getByText("Projects › Trip notes")).toBeTruthy();
    expect(screen.getByText("10 days left")).toBeTruthy();
    expect(screen.getByText("Not used by any note")).toBeTruthy();
  });

  it("줄을 누르면 그 블릿으로 간다", async () => {
    const openNode = vi.fn();
    render(
      <AttachmentsSection
        readAttachments={vi.fn(async () => [attachment()])}
        deleteAttachment={vi.fn(async () => true)}
        openNode={openNode}
        now={() => NOW}
      />
    );

    await userEvent.click(await screen.findByRole("button", { name: "holiday.png" }));

    expect(openNode).toHaveBeenCalledWith(
      "PrJects00001",
      "Nd0000000002"
    );
  });

  it("삭제 버튼이 명령을 보내고 목록을 다시 읽는다", async () => {
    const deleteAttachment = vi.fn(async () => true);
    const readAttachments = vi.fn(async () => [
      attachment({ nodeId: "", references: 0, unreferencedAt: NOW / 1_000 })
    ]);

    render(
      <AttachmentsSection
        readAttachments={readAttachments}
        deleteAttachment={deleteAttachment}
        openNode={vi.fn()}
        now={() => NOW}
      />
    );
    await userEvent.click(await screen.findByRole("button", { name: "Delete now" }));

    expect(deleteAttachment).toHaveBeenCalledWith("9f2c1b7a4e6d");
    await waitFor(() => expect(readAttachments).toHaveBeenCalledTimes(2));
  });

  it("휴지통에 있는 그림은 페이지 대신 휴지통이라고 말한다", async () => {
    render(
      <AttachmentsSection
        readAttachments={vi.fn(async () => [
          attachment({ trashed: true, pageId: "", pageTitle: "", parentTitle: "" })
        ])}
        deleteAttachment={vi.fn(async () => true)}
        openNode={vi.fn()}
        now={() => NOW}
      />
    );

    expect(await screen.findByText("In the trash")).toBeTruthy();
    expect(
      screen.queryByRole("button", { name: "holiday.png" }),
      "a note in the trash is on no page, so there is nowhere for the click to go"
    ).toBeNull();
  });

  it("그 사이 다시 쓰이기 시작한 파일은 지워지지 않았다고 알린다", async () => {
    render(
      <AttachmentsSection
        readAttachments={vi.fn(async () => [
          attachment({ nodeId: "", references: 0, unreferencedAt: NOW / 1_000 })
        ])}
        deleteAttachment={vi.fn(async () => false)}
        openNode={vi.fn()}
        now={() => NOW}
      />
    );
    await userEvent.click(await screen.findByRole("button", { name: "Delete now" }));

    expect(await screen.findByRole("alert")).toBeTruthy();
  });
});

describe("표시 계산", () => {
  it("남은 기간은 마지막 참조가 끊긴 시점부터 센다", () => {
    expect(daysLeft(NOW / 1_000, NOW)).toBe(14);
    expect(daysLeft((NOW - 13.5 * 86_400_000) / 1_000, NOW)).toBe(1);
    expect(daysLeft((NOW - 40 * 86_400_000) / 1_000, NOW)).toBe(0);
  });

  it("크기는 사람이 읽는 단위로 쓴다", () => {
    expect(formatSize(900)).toBe("900 bytes");
    // Binary units all the way down: a kilobyte starts at 1,024, not 1,000.
    expect(formatSize(1_000)).toBe("1000 bytes");
    expect(formatSize(2_048)).toBe("2 KB");
    expect(formatSize(2_400_000)).toBe("2.3 MB");
  });
});
