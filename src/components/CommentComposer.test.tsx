import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor
} from "@testing-library/react";
import { useState } from "react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CommentComposer } from "./CommentComposer";

const appStyles = readFileSync(join(process.cwd(), "src/styles.css"), "utf8");
const composerDockStyles = readFileSync(
  join(process.cwd(), "src/components/ui/composer-dock.css"),
  "utf8"
);

function parseCssDeclarations(block: string): Record<string, string> {
  return Object.fromEntries(
    block
      .split(";")
      .map((declaration) => declaration.trim())
      .filter(Boolean)
      .map((declaration) => {
        const separator = declaration.indexOf(":");
        return [
          declaration.slice(0, separator).trim(),
          declaration.slice(separator + 1).trim()
        ];
      })
  );
}

function cssDeclarationsFor(
  selector: string,
  source = appStyles
): Record<string, string> {
  const start = source.indexOf(`${selector} {`);
  if (start === -1) {
    throw new Error(`Missing CSS rule for ${selector}`);
  }
  const blockStart = source.indexOf("{", start);
  const blockEnd = source.indexOf("}", blockStart);
  return parseCssDeclarations(source.slice(blockStart + 1, blockEnd));
}

interface MockObserver {
  callback: IntersectionObserverCallback;
  target: Element | null;
  instance: IntersectionObserver;
}
const observers: MockObserver[] = [];

class IntersectionObserverMock {
  private record: MockObserver;

  constructor(callback: IntersectionObserverCallback) {
    this.record = {
      callback,
      target: null,
      instance: this as unknown as IntersectionObserver
    };
    observers.push(this.record);
  }

  observe(target: Element) {
    this.record.target = target;
  }

  unobserve() {
    this.record.target = null;
  }

  disconnect() {
    const index = observers.indexOf(this.record);
    if (index >= 0) {
      observers.splice(index, 1);
    }
  }

  takeRecords() {
    return [] as IntersectionObserverEntry[];
  }
}

function fireFlowComposerVisible(isIntersecting: boolean) {
  const observer = observers[observers.length - 1];
  if (!observer) {
    throw new Error("no IntersectionObserver was created by the composer");
  }
  act(() => {
    observer.callback(
      [
        {
          isIntersecting,
          target: observer.target
        } as unknown as IntersectionObserverEntry
      ],
      observer.instance
    );
  });
}

beforeEach(() => {
  observers.length = 0;
  vi.stubGlobal("IntersectionObserver", IntersectionObserverMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function ControlledComposer({ initial = "" }: { initial?: string }) {
  const [draft, setDraft] = useState(initial);
  return (
    <CommentComposer
      draft={draft}
      online
      canClose
      onDraftChange={setDraft}
      onSubmit={vi.fn()}
    />
  );
}

describe("CommentComposer", () => {
  it("shows only a Preview toggle while writing, never a Write button", () => {
    render(
      <CommentComposer
        draft={"**hello**"}
        online
        onDraftChange={vi.fn()}
        onSubmit={vi.fn()}
      />
    );

    // Editing surface is up, so the single mode switch points at the opposite
    // (Preview) mode. There is no redundant Write control while already writing.
    expect(screen.getByRole("button", { name: "Preview" })).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Write" })
    ).not.toBeInTheDocument();
    expect(screen.getByLabelText("Write a comment")).toBeInTheDocument();
    expect(screen.queryByLabelText("Comment preview")).not.toBeInTheDocument();
  });

  it("swaps to only a Write button while previewing the rendered markdown", async () => {
    const user = userEvent.setup();
    render(
      <CommentComposer
        draft={"**hello**"}
        online
        onDraftChange={vi.fn()}
        onSubmit={vi.fn()}
      />
    );

    await user.click(screen.getByRole("button", { name: "Preview" }));

    // Previewing now: the switch flips to point back at Write, and no Preview
    // control lingers.
    expect(screen.getByRole("button", { name: "Write" })).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Preview" })
    ).not.toBeInTheDocument();

    // The markdown preview replaced the textarea.
    const preview = screen.getByLabelText("Comment preview");
    expect(await screen.findByText("hello")).toBeInTheDocument();
    expect(preview.querySelector("strong")).toHaveTextContent("hello");
    expect(screen.queryByLabelText("Write a comment")).not.toBeInTheDocument();
  });

  it("toggles write<->preview and restores textarea focus when returning to write", async () => {
    const user = userEvent.setup();
    render(
      <CommentComposer
        draft={"**hi**"}
        online
        onDraftChange={vi.fn()}
        onSubmit={vi.fn()}
      />
    );

    await user.click(screen.getByRole("button", { name: "Preview" }));
    expect(screen.getByLabelText("Comment preview")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Write" }));

    const textarea = screen.getByLabelText("Write a comment");
    expect(textarea).toBeInTheDocument();
    expect(screen.queryByLabelText("Comment preview")).not.toBeInTheDocument();
    // Returning to write hands focus back to the editing surface so typing can
    // resume immediately.
    expect(document.activeElement).toBe(textarea);
  });

  it("uses a plain toggle button, exposing no tab or tablist roles", () => {
    render(
      <CommentComposer
        draft={"hello"}
        online
        onDraftChange={vi.fn()}
        onSubmit={vi.fn()}
      />
    );

    // A one-item tablist would be ARIA-meaningless, so the switch is a button.
    expect(screen.queryByRole("tab")).not.toBeInTheDocument();
    expect(screen.queryByRole("tablist")).not.toBeInTheDocument();

    // The visible label already names the action, so aria-pressed would be a
    // conflicting second signal — it must not be set.
    const toggle = screen.getByRole("button", { name: "Preview" });
    expect(toggle).not.toHaveAttribute("aria-pressed");
  });

  it("shows the write/preview toggle only after the user starts typing", async () => {
    const user = userEvent.setup();
    function WrappedComposer() {
      const [draft, setDraft] = useState("");
      return (
        <CommentComposer
          draft={draft}
          online
          onDraftChange={setDraft}
          onSubmit={vi.fn()}
        />
      );
    }
    render(<WrappedComposer />);

    expect(
      screen.queryByRole("button", { name: "Preview" })
    ).not.toBeInTheDocument();

    await user.type(screen.getByLabelText("Write a comment"), "hello");

    expect(screen.getByRole("button", { name: "Preview" })).toBeInTheDocument();
  });

  it("grows the in-flow textarea to fit wrapped content", async () => {
    function WrappedComposer() {
      const [draft, setDraft] = useState("hello");
      return (
        <CommentComposer
          draft={draft}
          online
          onDraftChange={setDraft}
          onSubmit={vi.fn()}
        />
      );
    }
    render(<WrappedComposer />);
    fireFlowComposerVisible(true);
    const textarea = screen.getByLabelText("Write a comment");
    Object.defineProperty(textarea, "scrollHeight", {
      configurable: true,
      value: 180
    });

    fireEvent.change(textarea, { target: { value: "hello\nworld" } });

    await waitFor(() => {
      expect(textarea).toHaveStyle({ height: "180px" });
    });
  });

  it("reports draft changes", () => {
    const onDraftChange = vi.fn();
    render(
      <CommentComposer
        draft={"hello"}
        online
        onDraftChange={onDraftChange}
        onSubmit={vi.fn()}
      />
    );
    const textarea = screen.getByLabelText("Write a comment");

    fireEvent.change(textarea, { target: { value: "hello\nworld" } });

    expect(onDraftChange).toHaveBeenCalledWith("hello\nworld");
  });

  it("submits a completed issue close action separately from a regular comment", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    render(
      <CommentComposer
        draft={"Done"}
        online
        closeKind="issue"
        onDraftChange={vi.fn()}
        onSubmit={onSubmit}
      />
    );

    await user.click(screen.getByRole("button", { name: "Close with comment" }));
    await user.click(screen.getByRole("button", { name: "Comment" }));

    expect(onSubmit).toHaveBeenNthCalledWith(1, {
      type: "comment-and-close",
      close: { kind: "issue", reason: "completed" }
    });
    expect(onSubmit).toHaveBeenNthCalledWith(2, { type: "comment" });
  });

  it("closes an issue without requiring a comment body", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    render(
      <CommentComposer
        draft=""
        online
        closeKind="issue"
        onDraftChange={vi.fn()}
        onSubmit={onSubmit}
      />
    );

    await user.click(screen.getByLabelText("Write a comment"));

    const closeButton = screen.getByRole("button", { name: "Close issue" });
    expect(closeButton).toBeEnabled();
    expect(screen.getByRole("button", { name: "Close options" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Comment" })).toBeDisabled();

    await user.click(closeButton);

    expect(onSubmit).toHaveBeenCalledWith({
      type: "comment-and-close",
      close: { kind: "issue", reason: "completed" }
    });
  });

  it("matches the close-with-comment button font size to the comment button", () => {
    const closeButtonStyle = cssDeclarationsFor(
      ".secondary-danger-button.composer-close-main"
    );

    expect(closeButtonStyle["font-size"]).toBe("13.5px");
  });

  it("lets issue close reason be selected from a GitHub-style menu", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    render(
      <CommentComposer
        draft={"Won't ship"}
        online
        closeKind="issue"
        onDraftChange={vi.fn()}
        onSubmit={onSubmit}
      />
    );

    await user.click(screen.getByRole("button", { name: "Close options" }));
    expect(screen.getByRole("menuitem", { name: /Close as completed/ }))
      .toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: /Close as not planned/ }))
      .toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: /Close as duplicate/ }))
      .toBeInTheDocument();

    await user.click(screen.getByRole("menuitem", { name: /Close as not planned/ }));
    await user.click(screen.getByRole("button", { name: "Close with comment" }));

    expect(onSubmit).toHaveBeenCalledWith({
      type: "comment-and-close",
      close: { kind: "issue", reason: "not_planned" }
    });
  });

  it("stores a duplicate issue number when selecting the duplicate issue close reason", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    const prompt = vi.spyOn(window, "prompt").mockReturnValue("123");
    render(
      <CommentComposer
        draft={"Duplicate"}
        online
        closeKind="issue"
        onDraftChange={vi.fn()}
        onSubmit={onSubmit}
      />
    );

    await user.click(screen.getByRole("button", { name: "Close options" }));
    await user.click(screen.getByRole("menuitem", { name: /Close as duplicate/ }));
    await user.click(screen.getByRole("button", { name: "Close with comment" }));

    expect(prompt).toHaveBeenCalled();
    expect(onSubmit).toHaveBeenCalledWith({
      type: "comment-and-close",
      close: { kind: "issue", reason: "duplicate", duplicateIssueId: 123 }
    });
  });

  it("lets discussion close reason be selected from a GitHub-style menu", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    render(
      <CommentComposer
        draft={"Resolved"}
        online
        closeKind="discussion"
        onDraftChange={vi.fn()}
        onSubmit={onSubmit}
      />
    );

    expect(screen.getByRole("button", { name: "Close discussion" }))
      .toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Close options" }));
    expect(screen.getByRole("menuitem", { name: /Close as resolved/ }))
      .toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: /Close as outdated/ }))
      .toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: /Close as duplicate/ }))
      .toBeInTheDocument();

    await user.click(screen.getByRole("menuitem", { name: /Close as outdated/ }));
    await user.click(screen.getByRole("button", { name: "Close discussion" }));

    expect(onSubmit).toHaveBeenCalledWith({
      type: "comment-and-close",
      close: { kind: "discussion", reason: "outdated" }
    });
  });

  it("closes a discussion without requiring a comment body", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    render(
      <CommentComposer
        draft=""
        online
        closeKind="discussion"
        onDraftChange={vi.fn()}
        onSubmit={onSubmit}
      />
    );

    await user.click(screen.getByLabelText("Write a comment"));
    await user.click(screen.getByRole("button", { name: "Close discussion" }));

    expect(onSubmit).toHaveBeenCalledWith({
      type: "comment-and-close",
      close: { kind: "discussion", reason: "resolved" }
    });
  });

  it("renders pull request close as a single action without a reason menu", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    render(
      <CommentComposer
        draft={"Closing this PR"}
        online
        closeKind="pull"
        onDraftChange={vi.fn()}
        onSubmit={onSubmit}
      />
    );

    await user.click(screen.getByRole("button", { name: "Close pull request" }));

    expect(screen.queryByRole("button", { name: "Close options" })).toBeNull();
    expect(onSubmit).toHaveBeenCalledWith({
      type: "comment-and-close",
      close: { kind: "pull" }
    });
  });

  it("closes a pull request without requiring a comment body", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    render(
      <CommentComposer
        draft=""
        online
        closeKind="pull"
        onDraftChange={vi.fn()}
        onSubmit={onSubmit}
      />
    );

    await user.click(screen.getByLabelText("Write a comment"));
    await user.click(screen.getByRole("button", { name: "Close pull request" }));

    expect(onSubmit).toHaveBeenCalledWith({
      type: "comment-and-close",
      close: { kind: "pull" }
    });
  });

  it("keeps a full composer in the content flow and shows a collapsed dock while it is offscreen", () => {
    const { container } = render(<ControlledComposer />);

    const flowComposer = container.querySelector(".comment-composer-flow");
    const dockComposer = container.querySelector(".comment-composer-dock");
    expect(flowComposer).toHaveClass("is-expanded");
    expect(flowComposer).toHaveAttribute("aria-hidden", "true");
    expect(dockComposer).toHaveClass("is-collapsed");
    expect(dockComposer).toHaveAttribute("data-expanded", "false");
    expect(screen.getByLabelText("Write a comment")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Comment" })).toBeNull();
  });

  it("leaves collapsed dock textarea sizing to CSS", () => {
    const { container } = render(<ControlledComposer />);

    const dockComposer = container.querySelector(".comment-composer-dock");
    const textarea = screen.getByLabelText(
      "Write a comment"
    ) as HTMLTextAreaElement;

    expect(dockComposer).toHaveClass("is-collapsed");
    expect(textarea.style.height).toBe("");
  });

  it("expands the dock for input when the collapsed dock is clicked", async () => {
    const user = userEvent.setup();
    const { container } = render(<ControlledComposer />);

    await user.click(screen.getByLabelText("Write a comment"));

    const dockComposer = container.querySelector(".comment-composer-dock");
    expect(dockComposer).toHaveClass("is-expanded");
    expect(dockComposer).toHaveAttribute("data-expanded", "true");
    const textarea = screen.getByLabelText("Write a comment");
    expect(textarea).toBeInTheDocument();
    expect(document.activeElement).toBe(textarea);
    expect(screen.getByRole("button", { name: "Comment" })).toBeInTheDocument();
  });

  it("lets the expanded dock textarea be resized by the user", async () => {
    const user = userEvent.setup();
    const { container } = render(<ControlledComposer />);

    await user.click(screen.getByLabelText("Write a comment"));

    const dockComposer = container.querySelector(".comment-composer-dock");
    const textarea = screen.getByLabelText(
      "Write a comment"
    ) as HTMLTextAreaElement;
    expect(dockComposer).toHaveClass("is-expanded");
    expect(textarea.style.height).toBe("");
  });

  it("collapses the dock again after blur when there is no draft", async () => {
    const user = userEvent.setup();
    const { container } = render(
      <>
        <ControlledComposer />
        <button type="button">outside</button>
      </>
    );
    await user.click(screen.getByLabelText("Write a comment"));
    const textarea = screen.getByLabelText("Write a comment");
    await user.click(textarea);
    await user.click(screen.getByRole("button", { name: "outside" }));

    expect(container.querySelector(".comment-composer-dock")).toHaveClass(
      "is-collapsed"
    );
  });

  it("stays expanded while a draft is present even without focus", () => {
    const { container } = render(<ControlledComposer initial="draft text" />);

    const dockComposer = container.querySelector(".comment-composer-dock");
    expect(dockComposer).toHaveClass("is-expanded");
    expect(screen.getByRole("button", { name: "Comment" })).toBeInTheDocument();
  });

  it("hides the dock when the flow composer reaches the viewport", () => {
    const { container } = render(<ControlledComposer />);

    fireFlowComposerVisible(true);

    expect(container.querySelector(".comment-composer-dock")).toBeNull();
    const flowComposer = container.querySelector(".comment-composer-flow");
    expect(flowComposer).not.toHaveAttribute("aria-hidden");
    expect(screen.getByLabelText("Write a comment")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Comment" })).toBeInTheDocument();
  });

  it("fixes the collapsed dock to the detail pane while keeping the full composer in flow", () => {
    const dockStyle = cssDeclarationsFor(
      ".comment-composer-dock",
      composerDockStyles
    );
    const maximizedDockStyle = cssDeclarationsFor(
      ".app-shell[data-detail-maximized=\"true\"] .comment-composer-dock",
      composerDockStyles
    );
    const collapsedDockStyle = cssDeclarationsFor(
      ".comment-composer-dock.is-collapsed",
      composerDockStyles
    );
    const collapsedTextareaStyle = cssDeclarationsFor(
      ".comment-composer-dock.is-collapsed textarea",
      composerDockStyles
    );
    const expandedTextareaStyle = cssDeclarationsFor(
      ".comment-composer-dock.is-expanded textarea",
      composerDockStyles
    );
    const expandedStyle = cssDeclarationsFor(
      ".comment-composer-flow",
      composerDockStyles
    );

    expect(dockStyle.position).toBe("fixed");
    expect(dockStyle.bottom).toBe("var(--statusbar-height)");
    expect(dockStyle.left).toBe(
      "calc(var(--sidebar-width, 280px) + var(--sidebar-resizer-width, 1px) + var(--list-width, 420px) + var(--list-resizer-width, 1px))"
    );
    expect(dockStyle.right).toBe("0");
    expect(dockStyle["border-top"]).toBeUndefined();
    expect(dockStyle.background).toBe(
      "color-mix(in srgb, var(--bg-detail) 62%, transparent)"
    );
    expect(dockStyle["backdrop-filter"]).toBe("blur(14px) saturate(130%)");
    expect(dockStyle["-webkit-backdrop-filter"]).toBe(
      "blur(14px) saturate(130%)"
    );
    expect(maximizedDockStyle.left).toBe("0");
    expect(collapsedDockStyle.overflow).toBe("hidden");
    expect(collapsedDockStyle["max-height"]).toBe("67px");
    expect(collapsedDockStyle.padding).toBe(
      "18px 12px calc(0px + env(safe-area-inset-bottom, 0px))"
    );
    expect(collapsedTextareaStyle["min-height"]).toBe("76px");
    expect(collapsedTextareaStyle.height).toBe("76px");
    expect(collapsedTextareaStyle.padding).toBe("20px 14px 10px");
    expect(collapsedTextareaStyle["border-radius"]).toBe("var(--radius)");
    expect(collapsedTextareaStyle.background).toBe(
      "color-mix(in srgb, var(--bg-input) 72%, transparent)"
    );
    expect(collapsedTextareaStyle.resize).toBe("none");
    expect(expandedTextareaStyle.resize).toBe("vertical");
    expect(expandedTextareaStyle["max-height"]).toBe("min(60vh, 520px)");
    expect(expandedStyle.position).not.toBe("sticky");
    expect(expandedStyle.bottom).toBeUndefined();
  });

  it("renders the write/preview toggle as an overlay so typing does not shift the form", () => {
    render(<ControlledComposer initial="hello" />);

    const toggle = screen.getByRole("button", { name: "Preview" });
    // The overlay class takes the toggle out of flow (absolute), so it never
    // pushes the textarea down when it appears the instant a draft exists.
    expect(toggle).toHaveClass("composer-tabs-overlay");
  });
});
