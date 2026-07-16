import { act, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ItemDocument } from "../domain/types";
import type { UseItemThreadResult } from "../hooks/useItemThread";
import { ItemDetail } from "./ItemDetail";

// MarkdownBody dynamically imports the renderer and mutates innerHTML
// asynchronously; stub it so these sticky-title tests render synchronously and
// deterministically. (The body is well covered by MarkdownBody's own tests.)
vi.mock("./MarkdownBody", () => ({
  MarkdownBody: ({ body }: { body: string }) => <div>{body}</div>,
  warmMarkdownBodies: vi.fn()
}));

// jsdom ships no IntersectionObserver. Install a controllable mock that captures
// the callback so tests can simulate the header entering/leaving the viewport.
let ioCallback: IntersectionObserverCallback | null = null;
let ioInstance: IntersectionObserver;

class MockIntersectionObserver implements IntersectionObserver {
  root: Element | Document | null = null;
  rootMargin = "";
  scrollMargin = "";
  thresholds: ReadonlyArray<number> = [];
  constructor(cb: IntersectionObserverCallback) {
    ioCallback = cb;
    ioInstance = this as unknown as IntersectionObserver;
  }
  observe = vi.fn();
  unobserve = vi.fn();
  disconnect = vi.fn();
  takeRecords = () => [];
}

function fireHeaderVisible(isIntersecting: boolean) {
  act(() => {
    ioCallback?.([{ isIntersecting } as IntersectionObserverEntry], ioInstance);
  });
}

beforeEach(() => {
  ioCallback = null;
  vi.stubGlobal("IntersectionObserver", MockIntersectionObserver);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const TITLE = "Fix the flaky login test";

function makeItem(): ItemDocument {
  return {
    path: "acme/widgets/issues/42.md",
    body: "The login test fails intermittently in CI.",
    frontMatter: {
      host: "github.com",
      owner: "acme",
      repo: "widgets",
      kind: "issue",
      number: 42,
      title: TITLE,
      state: "open",
      author: "mona",
      labels: ["bug"],
      label_colors: { bug: "d73a4a" },
      created_at: "2026-07-01T00:00:00Z",
      updated_at: "2026-07-07T00:00:00Z",
      local: { favorite: false },
      sync: { status: "synced" }
    }
  };
}

function makeThread(): UseItemThreadResult {
  return {
    thread: {
      state: "open",
      draft: false,
      labels: [{ name: "bug", color: "d73a4a" }],
      comments: []
    },
    loading: false,
    error: null,
    refreshing: false
  };
}

const noop = () => {};

interface RenderOverrides {
  detailMaximized?: boolean;
  onToggleMaximize?: () => void;
  onHeaderVisibilityChange?: (visible: boolean) => void;
}

function renderDetail(
  item: ItemDocument = makeItem(),
  overrides: RenderOverrides = {}
) {
  return render(
    <ItemDetail
      item={item}
      thread={makeThread()}
      online
      commentDraft=""
      onCommentDraftChange={noop}
      onQueueComment={noop}
      onToggleFavorite={noop}
      detailMaximized={overrides.detailMaximized ?? false}
      onToggleMaximize={overrides.onToggleMaximize ?? noop}
      onHeaderVisibilityChange={overrides.onHeaderVisibilityChange ?? noop}
    />
  );
}

describe("ItemDetail sticky title", () => {
  it("does not show the sticky title bar while the header is visible", () => {
    const { container } = renderDetail();
    // Header still on screen: the sentinel is intersecting.
    fireHeaderVisible(true);
    expect(container.querySelector(".sticky-title-bar")).toBeNull();
    // The real header title is of course still rendered.
    expect(screen.getByRole("heading", { name: TITLE })).toBeTruthy();
  });

  it("shows a bar with only the title text once the header scrolls out", () => {
    const { container } = renderDetail();
    fireHeaderVisible(false);

    const bar = container.querySelector(".sticky-title-bar");
    expect(bar).not.toBeNull();
    expect(bar).toHaveTextContent(TITLE);

    // Only the title text — no badges, buttons, chips, or other meta.
    expect(bar!.querySelectorAll("button")).toHaveLength(0);
    expect(bar!.querySelector(".state-badge")).toBeNull();
    expect(bar!.querySelector(".chip")).toBeNull();
    expect(bar!.querySelector(".label-chip")).toBeNull();

    // The bar is decorative and hidden from assistive tech.
    expect(container.querySelector(".sticky-title-slot")).toHaveAttribute(
      "aria-hidden",
      "true"
    );
  });

  it("hides the bar again when the header returns to view", () => {
    const { container } = renderDetail();
    fireHeaderVisible(false);
    expect(container.querySelector(".sticky-title-bar")).not.toBeNull();

    fireHeaderVisible(true);
    expect(container.querySelector(".sticky-title-bar")).toBeNull();
  });

  it("appends the issue number after the title in the muted number tone", () => {
    const { container } = renderDetail();
    fireHeaderVisible(false);

    const bar = container.querySelector(".sticky-title-bar");
    const number = bar!.querySelector(".sticky-title-number");
    expect(number).not.toBeNull();
    expect(number).toHaveTextContent("#42");
    // The number sits after the title text within the bar.
    expect(bar).toHaveTextContent(`${TITLE}#42`);
  });

  it("shows no number for a draft item (number 0)", () => {
    const draft = makeItem();
    draft.frontMatter.number = 0;
    const { container } = renderDetail(draft);
    fireHeaderVisible(false);

    const bar = container.querySelector(".sticky-title-bar");
    expect(bar).not.toBeNull();
    expect(bar).toHaveTextContent(TITLE);
    expect(bar!.querySelector(".sticky-title-number")).toBeNull();
  });
});

describe("ItemDetail inline maximize toggle", () => {
  it("renders the maximize toggle beside the open-in-browser button in the header actions", () => {
    const { container } = renderDetail();
    const actions = container.querySelector<HTMLElement>(".detail-header-actions");
    expect(actions).not.toBeNull();

    const maximize = within(actions!).getByRole("button", { name: "상세 최대화" });
    const openInBrowser = within(actions!).getByRole("button", {
      name: "Open in browser"
    });
    // The maximize control lives inline in the header actions row, as a sibling
    // of the globe (not inside the decorative sticky title bar).
    expect(maximize.parentElement).toBe(openInBrowser.parentElement);
    expect(container.querySelector(".sticky-title-bar")).toBeNull();
    // Not maximized: shows the expand glyph.
    expect(maximize).toHaveAttribute("aria-pressed", "false");
    expect(maximize.querySelector("svg")).toHaveClass("lucide-maximize2");
  });

  it("calls onToggleMaximize when the inline maximize toggle is clicked", async () => {
    const user = userEvent.setup();
    const onToggleMaximize = vi.fn();
    renderDetail(makeItem(), { onToggleMaximize });

    await user.click(screen.getByRole("button", { name: "상세 최대화" }));

    expect(onToggleMaximize).toHaveBeenCalledTimes(1);
  });

  it("shows the minimize glyph and a pressed toggle while maximized", () => {
    renderDetail(makeItem(), { detailMaximized: true });
    const maximize = screen.getByRole("button", { name: "상세 최대화" });
    expect(maximize).toHaveAttribute("aria-pressed", "true");
    expect(maximize.querySelector("svg")).toHaveClass("lucide-minimize2");
  });

  it("reports header visibility through onHeaderVisibilityChange as the header scrolls", () => {
    const onHeaderVisibilityChange = vi.fn();
    renderDetail(makeItem(), { onHeaderVisibilityChange });
    // The header is on screen at mount.
    expect(onHeaderVisibilityChange).toHaveBeenLastCalledWith(true);

    // Sentinel leaves the scroll root → header gone.
    fireHeaderVisible(false);
    expect(onHeaderVisibilityChange).toHaveBeenLastCalledWith(false);

    // Sentinel back → header visible again.
    fireHeaderVisible(true);
    expect(onHeaderVisibilityChange).toHaveBeenLastCalledWith(true);
  });
});
