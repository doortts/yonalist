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

function cssDeclarationsFor(selector: string): Record<string, string> {
  const start = appStyles.indexOf(`${selector} {`);
  if (start === -1) {
    throw new Error(`Missing CSS rule for ${selector}`);
  }
  const blockStart = appStyles.indexOf("{", start);
  const blockEnd = appStyles.indexOf("}", blockStart);
  return parseCssDeclarations(appStyles.slice(blockStart + 1, blockEnd));
}

// jsdom ships without IntersectionObserver; the composer uses one to detect
// when its settle sentinel scrolls into the detail viewport. Install a
// controllable mock that captures each observer so tests can drive
// intersection changes deterministically.
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

function fireSettle(isIntersecting: boolean) {
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

  it("grows the textarea to fit wrapped content", async () => {
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

  it("starts collapsed as a single-line bar with the action buttons hidden", () => {
    const { container } = render(<ControlledComposer />);

    const form = container.querySelector(".comment-composer");
    expect(form).not.toBeNull();
    expect(form).toHaveClass("is-collapsed");
    expect(form).toHaveAttribute("data-expanded", "false");

    // The one-line bar is the textarea itself; it stays reachable so a click
    // or focus can expand the composer.
    expect(screen.getByLabelText("Write a comment")).toBeInTheDocument();
    // Collapsed hides the action buttons and the write/preview toggle.
    expect(
      screen.queryByRole("button", { name: "Comment" })
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Close with comment" })
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Preview" })
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Write" })
    ).not.toBeInTheDocument();
  });

  it("expands and keeps focus when the collapsed bar is focused", async () => {
    const user = userEvent.setup();
    const { container } = render(<ControlledComposer />);
    const textarea = screen.getByLabelText("Write a comment");

    await user.click(textarea);

    const form = container.querySelector(".comment-composer");
    expect(form).toHaveClass("is-expanded");
    expect(form).toHaveAttribute("data-expanded", "true");
    // Focus is retained on the same textarea after expanding.
    expect(document.activeElement).toBe(textarea);
    // Buttons appear once expanded (disabled while the draft is empty).
    expect(screen.getByRole("button", { name: "Comment" })).toBeInTheDocument();
  });

  it("collapses again after blur when the draft is empty and not settled", async () => {
    const user = userEvent.setup();
    const { container } = render(
      <>
        <ControlledComposer />
        <button type="button">outside</button>
      </>
    );
    const textarea = screen.getByLabelText("Write a comment");

    await user.click(textarea);
    expect(container.querySelector(".comment-composer")).toHaveClass(
      "is-expanded"
    );

    await user.click(screen.getByRole("button", { name: "outside" }));

    expect(container.querySelector(".comment-composer")).toHaveClass(
      "is-collapsed"
    );
  });

  it("stays expanded while a draft is present even without focus", () => {
    const { container } = render(<ControlledComposer initial="draft text" />);

    const form = container.querySelector(".comment-composer");
    expect(form).toHaveClass("is-expanded");
    expect(screen.getByRole("button", { name: "Comment" })).toBeInTheDocument();
  });

  it("auto-expands when the settle sentinel becomes visible and re-collapses when it leaves", () => {
    const { container } = render(<ControlledComposer />);

    expect(container.querySelector(".comment-composer")).toHaveClass(
      "is-collapsed"
    );

    // Sentinel enters the detail viewport -> composer has settled at the
    // bottom of the thread and expands without stealing focus.
    fireSettle(true);

    expect(container.querySelector(".comment-composer")).toHaveClass(
      "is-expanded"
    );
    expect(screen.getByRole("button", { name: "Comment" })).toBeInTheDocument();
    expect(document.activeElement).not.toBe(
      screen.getByLabelText("Write a comment")
    );

    // Scrolling away hides the sentinel again -> collapse (unfocused, empty).
    fireSettle(false);

    expect(container.querySelector(".comment-composer")).toHaveClass(
      "is-collapsed"
    );
  });

  it("renders the settle sentinel just before the composer form", () => {
    const { container } = render(<ControlledComposer />);

    const sentinel = container.querySelector(".composer-dock-sentinel");
    expect(sentinel).not.toBeNull();

    const form = container.querySelector(".comment-composer");
    // The sentinel anchors the end of the thread content, immediately *before*
    // the sticky composer. Anchoring it after the form (its old position) made
    // its geometry ride on the composer height it toggles, which fed back into
    // an expand/collapse loop; before the form the anchor is height-independent.
    expect(form!.previousElementSibling).toBe(sentinel);
    expect(
      form!.compareDocumentPosition(sentinel!) &
        Node.DOCUMENT_POSITION_PRECEDING
    ).toBeTruthy();
  });

  it("keeps the sentinel anchored before the form across expand/collapse", () => {
    const { container } = render(<ControlledComposer />);

    const sentinel = container.querySelector(".composer-dock-sentinel")!;
    const form = () => container.querySelector(".comment-composer")!;

    // Collapsed: sentinel is the form's previous sibling.
    expect(form()).toHaveClass("is-collapsed");
    expect(form().previousElementSibling).toBe(sentinel);

    // Settling expands the composer (grows it by ~180px)...
    fireSettle(true);
    expect(form()).toHaveClass("is-expanded");
    // ...but that growth happens *below* the sentinel, so the sentinel's DOM
    // position is unchanged. This structural invariant is what breaks the
    // feedback loop: the observed geometry never depends on the toggled height.
    expect(form().previousElementSibling).toBe(sentinel);
    expect(
      form().compareDocumentPosition(sentinel) &
        Node.DOCUMENT_POSITION_PRECEDING
    ).toBeTruthy();

    // Collapsing back keeps the same anchor.
    fireSettle(false);
    expect(form()).toHaveClass("is-collapsed");
    expect(form().previousElementSibling).toBe(sentinel);
  });

  it("renders the write/preview toggle as an overlay so typing does not shift the form", () => {
    render(<ControlledComposer initial="hello" />);

    const toggle = screen.getByRole("button", { name: "Preview" });
    // The overlay class takes the toggle out of flow (absolute), so it never
    // pushes the textarea down when it appears the instant a draft exists.
    expect(toggle).toHaveClass("composer-tabs-overlay");
  });
});
