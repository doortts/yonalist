import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useLayoutEffect, useRef } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GithubConnectionContext } from "../GithubConnectionContext";
import {
  clearMarkdownRenderCache,
  getMarkdownRenderCacheStats,
  MarkdownBody,
  warmMarkdownBodies
} from "./MarkdownBody";

const openExternalMock = vi.hoisted(() => vi.fn(() => Promise.resolve()));

vi.mock("../services/browser", () => ({
  openExternal: openExternalMock
}));

const imageMarkdown = "![roadmap](https://example.com/roadmap.png)\n\nBody text";

function LayoutHtmlProbe({
  body,
  onLayout
}: {
  body: string;
  onLayout: (html: string) => void;
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    onLayout(hostRef.current?.querySelector(".markdown-body")?.innerHTML ?? "");
  }, [body, onLayout]);
  return (
    <div ref={hostRef}>
      <MarkdownBody body={body} />
    </div>
  );
}

describe("MarkdownBody", () => {
  it("renders markdown images inside the body", async () => {
    const { container } = render(<MarkdownBody body={imageMarkdown} />);

    const image = await screen.findByRole("img", { name: "roadmap" });
    expect(image).toHaveAttribute("src", "https://example.com/roadmap.png");
    expect(container.querySelector(".markdown-body-github")).not.toBeNull();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("can render the preserved Yona markdown style for comparison", () => {
    const { container } = render(<MarkdownBody body="Body" variant="yona" />);

    expect(container.querySelector(".markdown-body-yona")).not.toBeNull();
  });

  it("keeps rendered markdown stable when only surrounding props change", async () => {
    const { container, rerender } = render(
      <MarkdownBody body="**Memoized** body" variant="github" />
    );
    await waitFor(() =>
      expect(container.querySelector(".markdown-body")?.innerHTML).toContain(
        "<strong>Memoized</strong>"
      )
    );
    const body = container.querySelector(".markdown-body");

    rerender(<MarkdownBody body="**Memoized** body" variant="yona" />);

    expect(container.querySelector(".markdown-body-yona")).not.toBeNull();
    expect(container.querySelector(".markdown-body")?.innerHTML).toBe(body?.innerHTML);
  });

  it("shows warmed cached markdown immediately when the body changes", async () => {
    await warmMarkdownBodies(["**First** body", "**Second** body"]);
    const layoutHtml: string[] = [];
    const { rerender } = render(
      <LayoutHtmlProbe
        body="**First** body"
        onLayout={(html) => layoutHtml.push(html)}
      />
    );

    expect(layoutHtml.at(-1)).toContain("<strong>First</strong>");

    rerender(
      <LayoutHtmlProbe
        body="**Second** body"
        onLayout={(html) => layoutHtml.push(html)}
      />
    );

    expect(layoutHtml.at(-1)).toContain("<strong>Second</strong>");
    expect(layoutHtml.at(-1)).not.toContain("<strong>First</strong>");
  });

  it("opens the original image in a lightbox when clicked", async () => {
    const user = userEvent.setup();
    render(<MarkdownBody body={imageMarkdown} />);

    await user.click(await screen.findByRole("img", { name: "roadmap" }));

    const viewer = screen.getByRole("dialog", { name: "Image viewer" });
    expect(viewer).toBeInTheDocument();
    expect(screen.getByRole("img", { name: "Original size" })).toHaveAttribute(
      "src",
      "https://example.com/roadmap.png"
    );
  });

  it("opens markdown links in the OS default browser", async () => {
    const user = userEvent.setup();
    render(<MarkdownBody body="[Open issue](https://github.com/acme/app/issues/1)" />);

    await user.click(await screen.findByRole("link", { name: "Open issue" }));

    expect(openExternalMock).toHaveBeenCalledWith(
      "https://github.com/acme/app/issues/1"
    );
  });

  it("swaps GHE attachment images to authenticated data URLs", async () => {
    const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      expect((init?.headers as Record<string, string>).Authorization).toBe(
        "Bearer ghp_token"
      );
      return new Response(new Uint8Array([1, 2, 3]), {
        status: 200,
        headers: { "content-type": "image/png" }
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    try {
      render(
        <GithubConnectionContext.Provider
          value={{
            apiBaseUrl: "https://ghe.example.com/api/v3",
            webBaseUrl: "https://ghe.example.com",
            token: "ghp_token"
          }}
        >
          <MarkdownBody
            body={`![attachment](https://ghe.example.com/storage/user/${Math.random()}/x.png)`}
          />
        </GithubConnectionContext.Provider>
      );

      const image = await screen.findByRole("img", { name: "attachment" });
      await waitFor(() =>
        expect(image.getAttribute("src")).toMatch(/^data:image\/png;base64,/)
      );
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("leaves third-party images untouched", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    try {
      render(
        <GithubConnectionContext.Provider
          value={{
            apiBaseUrl: "https://ghe.example.com/api/v3",
            webBaseUrl: "https://ghe.example.com",
            token: "ghp_token"
          }}
        >
          <MarkdownBody body="![ext](https://example.com/pic.png)" />
        </GithubConnectionContext.Provider>
      );

      expect(await screen.findByRole("img", { name: "ext" })).toHaveAttribute(
        "src",
        "https://example.com/pic.png"
      );
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  afterEach(() => {
    clearMarkdownRenderCache();
    openExternalMock.mockReset();
    vi.unstubAllGlobals();
  });

  it("keeps the rendered markdown cache bounded to 200 entries", async () => {
    const bodies = Array.from(
      { length: 201 },
      (_, index) => `# Cached markdown ${index}\n\nBody ${index}`
    );

    await warmMarkdownBodies(bodies);

    const stats = getMarkdownRenderCacheStats();
    expect(stats.entries).toBe(200);
    expect(stats.bytes).toBeGreaterThan(0);
  });

  it("closes the lightbox with the close button", async () => {
    const user = userEvent.setup();
    render(<MarkdownBody body={imageMarkdown} />);

    await user.click(await screen.findByRole("img", { name: "roadmap" }));
    expect(screen.getByRole("dialog", { name: "Image viewer" })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Close image viewer" }));
    await waitFor(() =>
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument()
    );
  });

  it("closes the lightbox on Escape", async () => {
    const user = userEvent.setup();
    render(<MarkdownBody body={imageMarkdown} />);

    await user.click(await screen.findByRole("img", { name: "roadmap" }));
    expect(screen.getByRole("dialog", { name: "Image viewer" })).toBeInTheDocument();

    await user.keyboard("{Escape}");
    await waitFor(() =>
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument()
    );
  });

  it("closes the lightbox when the backdrop overlay is clicked", async () => {
    const user = userEvent.setup();
    render(<MarkdownBody body={imageMarkdown} />);

    await user.click(await screen.findByRole("img", { name: "roadmap" }));
    const viewer = screen.getByRole("dialog", { name: "Image viewer" });
    expect(viewer).toBeInTheDocument();

    // Clicking the overlay (outside the enlarged image) dismisses the viewer.
    await user.click(viewer);
    await waitFor(() =>
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument()
    );
  });

  it("keeps the lightbox open when the enlarged image itself is clicked", async () => {
    const user = userEvent.setup();
    render(<MarkdownBody body={imageMarkdown} />);

    await user.click(await screen.findByRole("img", { name: "roadmap" }));
    await user.click(screen.getByRole("img", { name: "Original size" }));

    expect(screen.getByRole("dialog", { name: "Image viewer" })).toBeInTheDocument();
  });

  it("restores focus to the triggering body image after the lightbox closes", async () => {
    const user = userEvent.setup();
    render(<MarkdownBody body={imageMarkdown} />);

    const trigger = await screen.findByRole("img", { name: "roadmap" });
    trigger.focus();
    await user.click(trigger);
    expect(screen.getByRole("dialog", { name: "Image viewer" })).toBeInTheDocument();

    await user.keyboard("{Escape}");
    await waitFor(() =>
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument()
    );
    await waitFor(() => expect(trigger).toHaveFocus());
  });

  describe("warmMarkdownBodies event-loop yielding", () => {
    beforeEach(async () => {
      // Load the markdown renderer once with real timers so its memoized import
      // promise is already resolved; then the warm loop only awaits our own
      // setTimeout(0) yields under fake timers.
      vi.useRealTimers();
      await warmMarkdownBodies(["__prewarm_renderer__"]);
      clearMarkdownRenderCache();
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    async function flushMicrotasks() {
      for (let i = 0; i < 5; i += 1) {
        await Promise.resolve();
      }
    }

    it("yields to the event loop while warming many bodies", async () => {
      const bodies = Array.from(
        { length: 9 },
        (_, index) => `# Warm body ${index}\n\nUnique paragraph ${index}`
      );
      let settled = false;
      void warmMarkdownBodies(bodies).then(() => {
        settled = true;
      });

      // Microtasks alone do not finish the batch: it yields to the macrotask
      // queue after every fourth rendered body (two setTimeout(0) yields for
      // nine bodies at a batch size of four).
      await flushMicrotasks();
      expect(settled).toBe(false);

      // Draining the pending setTimeout(0) yields lets the batch finish.
      await vi.runAllTimersAsync();
      await flushMicrotasks();

      expect(settled).toBe(true);
      expect(getMarkdownRenderCacheStats().entries).toBeGreaterThanOrEqual(9);
    });

    it("warms a small batch without needing timer advances", async () => {
      const bodies = [
        "# Small one\n\nalpha",
        "# Small two\n\nbeta",
        "# Small three\n\ngamma"
      ];
      let settled = false;
      void warmMarkdownBodies(bodies).then(() => {
        settled = true;
      });

      // Four-or-fewer bodies never hit a batch boundary, so no macrotask yield.
      await flushMicrotasks();

      expect(settled).toBe(true);
      expect(getMarkdownRenderCacheStats().entries).toBeGreaterThanOrEqual(3);
    });

    it("does not yield again for bodies a concurrent warm already rendered", async () => {
      const bodies = Array.from(
        { length: 8 },
        (_, index) => `# Interleaved body ${index}\n\nUnique paragraph ${index}`
      );
      let firstSettled = false;
      void warmMarkdownBodies(bodies).then(() => {
        firstSettled = true;
      });

      // The first warm renders four bodies, then parks on its batch yield.
      await flushMicrotasks();
      expect(firstSettled).toBe(false);

      // While it is parked, a second warm renders the remaining four bodies.
      let secondSettled = false;
      void warmMarkdownBodies(bodies.slice(4)).then(() => {
        secondSettled = true;
      });
      await flushMicrotasks();
      expect(secondSettled).toBe(true);

      // Resuming from its single pending yield, the first warm finds every
      // remaining body cached and finishes without scheduling further yields.
      await vi.advanceTimersByTimeAsync(0);
      await flushMicrotasks();

      expect(firstSettled).toBe(true);
      expect(getMarkdownRenderCacheStats().entries).toBeGreaterThanOrEqual(8);
    });
  });
});
