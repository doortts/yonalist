import { act, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GitHubNotification } from "../domain/notifications";
import type { UseNotificationDetailResult } from "../hooks/useNotificationDetail";
import { NotificationDetail } from "./NotificationDetail";

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

const TITLE = "Investigate the memory leak";

function makeNotification(): GitHubNotification {
  return {
    id: "1",
    unread: true,
    reason: "mention",
    updated_at: "2026-07-07T10:00:00Z",
    last_read_at: null,
    subject: {
      title: TITLE,
      url: "https://api.github.com/repos/acme/widgets/issues/7",
      type: "Issue"
    },
    repository: {
      full_name: "acme/widgets",
      name: "widgets",
      owner: { login: "acme" }
    }
  };
}

function makeState(): UseNotificationDetailResult {
  return {
    detail: null,
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
  state?: UseNotificationDetailResult;
}

function renderDetail(
  notification: GitHubNotification = makeNotification(),
  overrides: RenderOverrides = {}
) {
  return render(
    <NotificationDetail
      notification={notification}
      state={overrides.state ?? makeState()}
      online
      commentDraft=""
      onOpenInBrowser={noop}
      onCommentDraftChange={noop}
      onQueueComment={noop}
      detailMaximized={overrides.detailMaximized ?? false}
      onToggleMaximize={overrides.onToggleMaximize ?? noop}
      onHeaderVisibilityChange={overrides.onHeaderVisibilityChange ?? noop}
    />
  );
}

describe("NotificationDetail states", () => {
  it("exposes conversation loading and failures semantically", () => {
    const loading = renderDetail(makeNotification(), {
      state: { ...makeState(), loading: true }
    });
    expect(screen.getByRole("status", { name: "Loading conversation" }))
      .toHaveTextContent("Loading conversation...");
    loading.unmount();

    renderDetail(makeNotification(), {
      state: { ...makeState(), error: "Conversation failed" }
    });
    expect(screen.getByRole("alert")).toHaveTextContent("Conversation failed");
  });
});

describe("NotificationDetail sticky title", () => {
  it("does not show the sticky title bar while the header is visible", () => {
    const { container } = renderDetail();
    fireHeaderVisible(true);
    expect(container.querySelector(".sticky-title-bar")).toBeNull();
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

  it("appends the subject number after the title in the muted number tone", () => {
    const { container } = renderDetail();
    fireHeaderVisible(false);

    const bar = container.querySelector(".sticky-title-bar");
    const number = bar!.querySelector(".sticky-title-number");
    expect(number).not.toBeNull();
    // subject.url ends in /issues/7 → number 7.
    expect(number).toHaveTextContent("#7");
    expect(bar).toHaveTextContent(`${TITLE}#7`);
  });

  it("shows no number for a numberless subject (Release)", () => {
    const release = makeNotification();
    release.subject = {
      title: "v2.0.0",
      url: "https://api.github.com/repos/acme/widgets/releases/99",
      type: "Release"
    };
    const { container } = renderDetail(release);
    fireHeaderVisible(false);

    const bar = container.querySelector(".sticky-title-bar");
    expect(bar).not.toBeNull();
    expect(bar).toHaveTextContent("v2.0.0");
    expect(bar!.querySelector(".sticky-title-number")).toBeNull();
  });
});

describe("NotificationDetail inline maximize toggle", () => {
  it("renders the maximize toggle beside the open-in-browser button in the header actions", () => {
    const { container } = renderDetail();
    const actions = container.querySelector<HTMLElement>(".detail-header-actions");
    expect(actions).not.toBeNull();

    const maximize = within(actions!).getByRole("button", { name: "상세 최대화" });
    const openInBrowser = within(actions!).getByRole("button", {
      name: "Open in browser"
    });
    expect(maximize.parentElement).toBe(openInBrowser.parentElement);
    expect(container.querySelector(".sticky-title-bar")).toBeNull();
    expect(maximize).toHaveAttribute("aria-pressed", "false");
    expect(maximize.querySelector("svg")).toHaveClass("lucide-maximize2");
  });

  it("calls onToggleMaximize when the inline maximize toggle is clicked", async () => {
    const user = userEvent.setup();
    const onToggleMaximize = vi.fn();
    renderDetail(makeNotification(), { onToggleMaximize });

    await user.click(screen.getByRole("button", { name: "상세 최대화" }));

    expect(onToggleMaximize).toHaveBeenCalledTimes(1);
  });

  it("shows the minimize glyph and a pressed toggle while maximized", () => {
    renderDetail(makeNotification(), { detailMaximized: true });
    const maximize = screen.getByRole("button", { name: "상세 최대화" });
    expect(maximize).toHaveAttribute("aria-pressed", "true");
    expect(maximize.querySelector("svg")).toHaveClass("lucide-minimize2");
  });

  it("reports header visibility through onHeaderVisibilityChange as the header scrolls", () => {
    const onHeaderVisibilityChange = vi.fn();
    renderDetail(makeNotification(), { onHeaderVisibilityChange });
    expect(onHeaderVisibilityChange).toHaveBeenLastCalledWith(true);

    fireHeaderVisible(false);
    expect(onHeaderVisibilityChange).toHaveBeenLastCalledWith(false);

    fireHeaderVisible(true);
    expect(onHeaderVisibilityChange).toHaveBeenLastCalledWith(true);
  });
});
