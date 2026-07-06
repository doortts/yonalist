import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GithubConnectionContext } from "../GithubConnectionContext";
import { MarkdownBody } from "./MarkdownBody";

const imageMarkdown = "![roadmap](https://example.com/roadmap.png)\n\nBody text";

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
    vi.unstubAllGlobals();
  });

  it("closes the lightbox from the backdrop, close button, and Escape", async () => {
    const user = userEvent.setup();
    render(<MarkdownBody body={imageMarkdown} />);

    await user.click(await screen.findByRole("img", { name: "roadmap" }));
    await user.click(screen.getByRole("button", { name: "Close image viewer" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();

    await user.click(await screen.findByRole("img", { name: "roadmap" }));
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();

    // Clicking the enlarged image itself keeps the viewer open.
    await user.click(await screen.findByRole("img", { name: "roadmap" }));
    await user.click(screen.getByRole("img", { name: "Original size" }));
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });
});
