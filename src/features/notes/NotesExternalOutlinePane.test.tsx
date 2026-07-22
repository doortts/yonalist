import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import {
  ExternalSourcesContext,
  type ExternalSourcesBoundary
} from "../../ExternalSourcesContext";
import { PaneLayoutContext } from "../../PaneLayoutContext";
import {
  serializeExternalBulletKey,
  type ExternalBullet,
  type ExternalSourcePageSnapshot
} from "../../domain/externalSources";
import { VaultRootContext } from "../../VaultRootContext";
import { NotesExportControllerProvider } from "./NotesExportController";
import { NotesWorkspaceContext } from "./NotesWorkspaceContext";
import type { UseNotesWorkspaceResult } from "./useNotesWorkspace";
import { NotesExternalOutlinePane } from "./NotesExternalOutlinePane";

function bullet(remoteId: string, title: string): ExternalBullet {
  return {
    key: {
      providerId: "github-notifications",
      connectionId: "github:user-7",
      remoteId
    },
    parentKey: null,
    title,
    note: `Repository: acme/${remoteId}\nReason: mention`,
    updatedAt: "2026-07-22T00:00:00Z",
    completed: false,
    capabilities: {
      expand: false,
      openDetails: true,
      complete: true,
      uncomplete: false,
      edit: false,
      move: false,
      delete: false,
      createChild: false
    }
  };
}

const first = bullet("first", "First notification");
const second = bullet("second", "Second notification");
const expandableFirst: ExternalBullet = {
  ...first,
  capabilities: { ...first.capabilities, expand: true }
};

function page(
  overrides: Partial<ExternalSourcePageSnapshot> = {}
): ExternalSourcePageSnapshot {
  return {
    providerId: "github-notifications",
    connectionId: "github:user-7",
    title: "Notifications",
    availability: "online",
    items: [first, second],
    loaded: true,
    loading: false,
    error: null,
    syncedAt: "2026-07-22T00:00:00Z",
    completingKeys: new Set(),
    completionErrors: {},
    ...overrides
  };
}

function boundaryFor(
  snapshot: ExternalSourcePageSnapshot,
  overrides: Partial<ExternalSourcesBoundary> = {}
): ExternalSourcesBoundary {
  return {
    pages: [snapshot],
    activeProviderId: snapshot.providerId,
    selectProvider: vi.fn(),
    refresh: vi.fn().mockResolvedValue(undefined),
    complete: vi.fn().mockResolvedValue(undefined),
    openDetails: vi.fn(),
    ...overrides
  };
}

function renderOutline(
  snapshot: ExternalSourcePageSnapshot,
  overrides: Partial<ExternalSourcesBoundary> = {}
) {
  const boundary = boundaryFor(snapshot, overrides);
  const noteAction = vi.fn();
  const workspace = {
    actions: new Proxy({}, { get: () => noteAction })
  } as unknown as UseNotesWorkspaceResult;
  const view = (next: ExternalSourcePageSnapshot, nextBoundary = boundary) => (
    <NotesWorkspaceContext.Provider value={workspace}>
      <ExternalSourcesContext.Provider value={nextBoundary}>
        <NotesExternalOutlinePane page={next} />
      </ExternalSourcesContext.Provider>
    </NotesWorkspaceContext.Provider>
  );
  const rendered = render(view(snapshot));
  return { ...rendered, boundary, noteAction, view };
}

describe("NotesExternalOutlinePane", () => {
  it("keeps provider input order", () => {
    renderOutline(page());

    const rows = document.querySelectorAll<HTMLElement>(
      "[data-external-bullet-key]"
    );
    expect([...rows].map((row) => row.dataset.externalBulletKey)).toEqual([
      serializeExternalBulletKey(first.key),
      serializeExternalBulletKey(second.key)
    ]);
  });

  it("does not offer expansion when the capability is false", () => {
    renderOutline(page());

    expect(
      screen.queryByRole("button", { name: `펼치기: ${first.title}` })
    ).not.toBeInTheDocument();
    expect(screen.queryByText("Repository: acme/first")).not.toBeInTheDocument();
  });

  it("preserves selected and expanded state across poll reorder", async () => {
    const user = userEvent.setup();
    const initial = page({ items: [expandableFirst, second] });
    const rendered = renderOutline(initial);

    await user.click(screen.getByRole("button", { name: first.title }));
    await user.click(
      screen.getByRole("button", { name: `펼치기: ${first.title}` })
    );
    expect(screen.getByText("Repository: acme/first")).toBeInTheDocument();

    const reordered = page({ items: [second, expandableFirst] });
    rendered.rerender(
      rendered.view(reordered, boundaryFor(reordered))
    );

    expect(screen.getByRole("button", { name: first.title })).toHaveAttribute(
      "aria-pressed",
      "true"
    );
    expect(
      screen.getByRole("button", { name: `접기: ${first.title}` })
    ).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByText("Repository: acme/first")).toBeInTheDocument();
  });

  it.each([
    ["disconnected", "Connect GitHub to view notifications."],
    ["authentication-required", "GitHub authentication is required."],
    ["connecting", "Loading notifications..."]
  ] as const)("shows the %s state", (availability, copy) => {
    renderOutline(
      page({
        availability,
        items: [],
        loaded: false,
        loading: availability === "connecting"
      })
    );

    expect(screen.getByText(copy)).toBeInTheDocument();
  });

  it("shows an offline cache without hiding rows", () => {
    renderOutline(page({ availability: "offline" }));

    expect(screen.getByRole("status")).toHaveTextContent(
      "Offline. Showing cached notifications."
    );
    expect(screen.getByText("2026-07-22T00:00:00Z")).toHaveAttribute(
      "dateTime",
      "2026-07-22T00:00:00Z"
    );
    expect(screen.getByRole("button", { name: first.title })).toBeInTheDocument();
  });

  it("keeps cached rows and a retry affordance after refresh failure", async () => {
    const user = userEvent.setup();
    const failed = page({ error: "Unable to refresh external source." });
    const refresh = vi.fn().mockRejectedValue(new Error("private provider error"));
    renderOutline(failed, { refresh });

    expect(screen.getByRole("button", { name: first.title })).toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Unable to refresh external source."
    );
    await user.click(screen.getByRole("button", { name: "다시 시도" }));

    expect(refresh).toHaveBeenCalledWith(failed.providerId);
    expect(screen.getByRole("button", { name: first.title })).toBeInTheDocument();
  });

  it("shows loading, empty, and retryable error states", async () => {
    const user = userEvent.setup();
    const loading = page({ items: [], loaded: false, loading: true });
    const rendered = renderOutline(loading);
    expect(screen.getByText("Loading notifications...")).toBeInTheDocument();

    const empty = page({ items: [] });
    rendered.rerender(rendered.view(empty, boundaryFor(empty)));
    expect(screen.getByText("No notifications.")).toBeInTheDocument();

    const failed = page({ items: [], error: "Unable to refresh external source." });
    const retryBoundary = boundaryFor(failed);
    rendered.rerender(rendered.view(failed, retryBoundary));
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Unable to refresh external source."
    );
    await user.click(screen.getByRole("button", { name: "다시 시도" }));
    expect(retryBoundary.refresh).toHaveBeenCalledWith(failed.providerId);
  });

  it("keeps external row actions out of Notes mutations, search, and export", async () => {
    const user = userEvent.setup();
    const expandablePage = page({ items: [expandableFirst, second] });
    const boundary = boundaryFor(expandablePage);
    const updateNode = vi.fn();
    const toggleComplete = vi.fn();
    const applyBatch = vi.fn();
    const searchNotes = vi.fn();
    const exportCallback = vi.fn().mockResolvedValue(true);
    const workspace = {
      actions: { updateNode, toggleComplete, applyBatch, searchNotes }
    } as unknown as UseNotesWorkspaceResult;
    render(
      <VaultRootContext.Provider value="/vault">
        <NotesExportControllerProvider
          available
          onFlushDrafts={exportCallback}
        >
          <NotesWorkspaceContext.Provider value={workspace}>
            <ExternalSourcesContext.Provider value={boundary}>
              <NotesExternalOutlinePane page={expandablePage} />
            </ExternalSourcesContext.Provider>
          </NotesWorkspaceContext.Provider>
        </NotesExportControllerProvider>
      </VaultRootContext.Provider>
    );
    await user.click(screen.getByRole("button", { name: first.title }));
    await user.click(
      screen.getByRole("button", { name: `펼치기: ${first.title}` })
    );
    await user.click(screen.getAllByRole("button", { name: "상세보기" })[0]);
    await user.click(
      screen.getByRole("button", { name: `완료: ${first.title}` })
    );

    expect(boundary.openDetails).toHaveBeenCalledWith(first.key);
    expect(boundary.complete).toHaveBeenCalledWith(first.key);
    expect(updateNode).not.toHaveBeenCalled();
    expect(toggleComplete).not.toHaveBeenCalled();
    expect(applyBatch).not.toHaveBeenCalled();
    expect(searchNotes).not.toHaveBeenCalled();
    expect(exportCallback).not.toHaveBeenCalled();
  });

  it("keeps exactly one Notes detail maximize control", async () => {
    const user = userEvent.setup();
    const toggleDetailMaximized = vi.fn();
    render(
      <PaneLayoutContext.Provider
        value={{ detailMaximized: false, toggleDetailMaximized }}
      >
        <ExternalSourcesContext.Provider value={boundaryFor(page())}>
          <NotesExternalOutlinePane page={page()} />
        </ExternalSourcesContext.Provider>
      </PaneLayoutContext.Provider>
    );

    const outline = screen.getByLabelText("Notifications outline");
    expect(
      within(outline).getAllByRole("button", { name: "상세 최대화" })
    ).toHaveLength(1);
    await user.click(
      within(outline).getByRole("button", { name: "상세 최대화" })
    );
    expect(toggleDetailMaximized).toHaveBeenCalledTimes(1);
  });
});
