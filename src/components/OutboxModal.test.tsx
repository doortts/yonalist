import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { createCommentOutboxOperation } from "../domain/outbox";
import type { OutboxOperationDocument } from "../domain/types";
import { OutboxModal } from "./OutboxModal";

function operation(
  id: string,
  status: OutboxOperationDocument["frontMatter"]["status"],
  lastError?: string
): OutboxOperationDocument {
  const base = createCommentOutboxOperation({
    id,
    host: "github.com",
    owner: "acme",
    repo: "app",
    itemKind: "issue",
    number: 42,
    localFilePath: `/vault/outbox/${id}.md`,
    createdAt: "2026-07-01T00:00:00Z"
  });
  return {
    ...base,
    body: `Comment ${id}`,
    frontMatter: { ...base.frontMatter, status, last_error: lastError }
  };
}

function renderModal(
  outbox: OutboxOperationDocument[],
  remoteChangedIds?: Set<string>
) {
  return render(
    <OutboxModal
      outbox={outbox}
      selectedIds={new Set()}
      online
      syncing={false}
      remoteChangedIds={remoteChangedIds}
      onToggleSelection={vi.fn()}
      onSync={vi.fn()}
      onClose={vi.fn()}
    />
  );
}

describe("OutboxModal", () => {
  it("labels blocked operations with their terminal error", () => {
    renderModal([operation("op-1", "blocked", "Not Found")]);

    expect(screen.getByText(/Blocked/)).toBeInTheDocument();
    expect(screen.getByText(/Not Found/)).toBeInTheDocument();
  });

  it("shows the stored error for failed operations", () => {
    renderModal([operation("op-1", "failed", "boom 500")]);

    expect(screen.getByText("boom 500")).toBeInTheDocument();
  });

  it("hints when the remote target changed after queueing", () => {
    renderModal(
      [operation("op-1", "pending"), operation("op-2", "pending")],
      new Set(["op-2"])
    );

    expect(
      screen.getAllByText("Target changed remotely since this was queued.")
    ).toHaveLength(1);
  });

  it("opens the queued operation target from the card body", async () => {
    const queued = operation("op-1", "pending");
    const onOpenTarget = vi.fn();
    const user = userEvent.setup();
    render(
      <OutboxModal
        outbox={[queued]}
        selectedIds={new Set()}
        online
        syncing={false}
        onToggleSelection={vi.fn()}
        onOpenTarget={onOpenTarget}
        onSync={vi.fn()}
        onClose={vi.fn()}
      />
    );

    await user.click(screen.getByRole("button", { name: /Open target/ }));

    expect(onOpenTarget).toHaveBeenCalledWith(queued);
  });
});
