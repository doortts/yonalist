import { createRef } from "react";
import { act, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi
} from "vitest";
import {
  NotesBulletTitleEditor,
  type NotesBulletTitleEditorHandle
} from "./NotesBulletTitleEditor";
import type { NotesEditorFlushAdapter } from "./notesImageAtomEditorRegistry";
import { restorePlainTextSelection } from "./plainTextContenteditable";

const today = { year: 2026, month: 7, day: 28 } as const;

function renderEditor(
  overrides: Partial<Parameters<typeof NotesBulletTitleEditor>[0]> = {}
) {
  const ref = createRef<NotesBulletTitleEditorHandle>();
  const onPublish = vi.fn();
  let adapter: NotesEditorFlushAdapter | null = null;
  const result = render(
    <NotesBulletTitleEditor
      ref={ref}
      nodeId="node"
      source="before"
      onPublish={onPublish}
      onTagClick={vi.fn()}
      registerFlushAdapter={(next) => {
        adapter = next;
        return () => {
          if (adapter === next) adapter = null;
        };
      }}
      {...overrides}
    />
  );
  return {
    ...result,
    ref,
    onPublish,
    get adapter() {
      return adapter;
    },
    root: screen.getByRole("textbox", { name: "Edit node title" })
  };
}

function activate(root: HTMLElement): void {
  fireEvent.pointerDown(root);
}

function inputSource(
  root: HTMLElement,
  source: string,
  inputType = "insertText",
  data: string | null = null
): void {
  root.textContent = source;
  restorePlainTextSelection(root, {
    anchorUtf16: source.length,
    focusUtf16: source.length
  });
  fireEvent.input(root, { inputType, data });
}

describe("NotesBulletTitleEditor", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    if (vi.isFakeTimers()) vi.runOnlyPendingTimers();
    vi.useRealTimers();
  });

  it("keeps one non-textarea root across resting and editing modes", () => {
    const { container, root } = renderEditor();

    expect(root).toHaveAttribute("contenteditable", "false");
    expect(container.querySelector("textarea")).toBeNull();
    activate(root);

    expect(
      screen.getByRole("textbox", { name: "Edit node title" })
    ).toBe(root);
    expect(root).toHaveAttribute("contenteditable", "plaintext-only");
    expect(root).toHaveTextContent("before");
  });

  it("imperatively focuses the same resting root with the requested selection", () => {
    const { root, ref } = renderEditor();
    let accepted = false;

    expect(root).toHaveAttribute("tabindex", "0");
    act(() => {
      accepted = ref.current!.focus({
        anchorUtf16: 5,
        focusUtf16: 1
      });
    });

    expect(accepted).toBe(true);
    expect(ref.current!.element).toBe(root);
    expect(root).toHaveAttribute("contenteditable", "plaintext-only");
    expect(root).toHaveFocus();
    expect(ref.current!.snapshot()).toEqual({
      source: "before",
      selection: { anchorUtf16: 5, focusUtf16: 1 }
    });
  });

  it("publishes once at 500 ms and not at 499 ms", () => {
    const { root, onPublish } = renderEditor();
    activate(root);
    inputSource(root, "after");

    vi.advanceTimersByTime(499);
    expect(onPublish).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(onPublish).toHaveBeenCalledOnce();
    expect(onPublish).toHaveBeenCalledWith("after");
  });

  it("restarts one timer for multiple inputs without rerendering its parent", () => {
    let parentRenders = 0;
    const onPublish = vi.fn();
    function Parent() {
      parentRenders += 1;
      return (
        <NotesBulletTitleEditor
          nodeId="node"
          source=""
          onPublish={onPublish}
          onTagClick={vi.fn()}
        />
      );
    }
    render(<Parent />);
    const root = screen.getByRole("textbox", { name: "Edit node title" });
    activate(root);
    const rendersAfterActivation = parentRenders;

    inputSource(root, "a");
    vi.advanceTimersByTime(400);
    inputSource(root, "ab");
    vi.advanceTimersByTime(499);

    expect(parentRenders).toBe(rendersAfterActivation);
    expect(onPublish).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(onPublish).toHaveBeenCalledOnce();
    expect(onPublish).toHaveBeenCalledWith("ab");
  });

  it("defers blur publication until composition ends and publishes once", async () => {
    const { root, onPublish, adapter } = renderEditor();
    activate(root);
    fireEvent.compositionStart(root);
    inputSource(root, "한국", "insertCompositionText", "국");
    fireEvent.blur(root);

    const pending = adapter!.flush();
    expect(onPublish).not.toHaveBeenCalled();
    fireEvent.compositionEnd(root);

    await expect(pending).resolves.toBe("deferred");
    expect(onPublish).toHaveBeenCalledOnce();
    expect(onPublish).toHaveBeenCalledWith("한국");
    expect(root).toHaveAttribute("contenteditable", "false");
  });

  it("flushes immediately and preserves the current backward selection", async () => {
    const { root, onPublish, ref } = renderEditor();
    activate(root);
    inputSource(root, "draft");
    restorePlainTextSelection(root, { anchorUtf16: 5, focusUtf16: 1 });

    await expect(ref.current!.flush()).resolves.toBe("flushed");
    expect(onPublish).toHaveBeenCalledWith("draft");
    expect(ref.current!.snapshot()).toEqual({
      source: "draft",
      selection: { anchorUtf16: 5, focusUtf16: 1 }
    });
  });

  it("cancels a composition flush when the editor unmounts", async () => {
    const { root, ref, unmount } = renderEditor();
    activate(root);
    fireEvent.compositionStart(root);

    const pending = ref.current!.flush();
    unmount();

    await expect(pending).resolves.toBe("cancelled");
  });

  it("pastes only plain text at the current range", () => {
    const { root, onPublish } = renderEditor({ source: "abcd" });
    activate(root);
    restorePlainTextSelection(root, { anchorUtf16: 3, focusUtf16: 1 });

    fireEvent.paste(root, {
      clipboardData: {
        getData: (type: string) => (type === "text/plain" ? "<x>" : "")
      }
    });

    expect(root).toHaveTextContent("a<x>d");
    vi.advanceTimersByTime(500);
    expect(onPublish).toHaveBeenCalledWith("a<x>d");
  });

  it("navigates slash commands and publishes a marker command", () => {
    const onSlashMarkerCommand = vi.fn();
    const { root, onPublish } = renderEditor({
      source: "",
      today,
      slashCommands: true,
      onSlashMarkerCommand
    });
    activate(root);
    inputSource(root, "/t", "insertText", "t");

    expect(screen.getByRole("listbox", { name: "Slash commands" })).toBeVisible();
    fireEvent.keyDown(root, { key: "ArrowDown" });
    fireEvent.keyDown(root, { key: "Enter" });

    expect(root).toHaveTextContent("");
    expect(onPublish).not.toHaveBeenCalled();
    expect(onSlashMarkerCommand).toHaveBeenCalledWith("todo", "", 0);
  });

  it("applies an inline format shortcut to the DOM selection", () => {
    const { root, onPublish } = renderEditor({ source: "bold" });
    activate(root);
    restorePlainTextSelection(root, { anchorUtf16: 0, focusUtf16: 4 });

    fireEvent.keyDown(root, { key: "b", metaKey: true });

    expect(root).toHaveTextContent("**bold**");
    expect(onPublish).toHaveBeenCalledWith("**bold**");
    expect(document.getSelection()?.toString()).toBe("bold");
  });

  it("reports a typed date trigger and a resting date activation", () => {
    const onDateTrigger = vi.fn();
    const onDateClick = vi.fn();
    const { root } = renderEditor({
      source: "today",
      today,
      onDateTrigger,
      onDateClick
    });

    fireEvent.click(screen.getByRole("button", { name: "Edit date today" }));
    expect(onDateClick).toHaveBeenCalledOnce();

    activate(root);
    inputSource(root, "!!", "insertText", "!");
    expect(onDateTrigger).toHaveBeenCalledWith(
      { startUtf16: 0, endUtf16: 2 },
      root,
      "!!"
    );
  });

  it("renders markdown at rest and exposes the exact source while editing", () => {
    const { root } = renderEditor({ source: "# Heading", markdown: true });

    expect(root).toHaveTextContent("Heading");
    expect(root).not.toHaveTextContent("# Heading");
    activate(root);
    expect(root).toHaveTextContent("# Heading");
  });

  it("keeps resting tag controls keyboard-accessible", async () => {
    vi.useRealTimers();
    const onTagClick = vi.fn();
    renderEditor({ source: "Open #later", onTagClick });
    const user = userEvent.setup();
    const tag = screen.getByRole("button", {
      name: "#later tag filter is inactive"
    });

    tag.focus();
    await user.keyboard("{Enter}");

    expect(onTagClick).toHaveBeenCalledOnce();
  });

  it("exposes textbox semantics and native editing attributes", () => {
    const { root } = renderEditor();

    expect(root).toHaveAttribute("role", "textbox");
    expect(root).toHaveAttribute("aria-multiline", "false");
    expect(root).toHaveAttribute("spellcheck", "false");
    expect(root).toHaveAttribute("autocorrect", "off");
    expect(root).toHaveAttribute("autocapitalize", "off");
    expect(root).toHaveAttribute("tabindex", "0");
  });

  it.each([
    ["readonly", { readOnly: true }, "aria-readonly"],
    ["disabled", { disabled: true }, "aria-disabled"]
  ] as const)("keeps a %s editor resting and exposes its state", (_name, props, aria) => {
    const { root } = renderEditor(props);

    expect(root).toHaveAttribute("contenteditable", "false");
    expect(root).toHaveAttribute(aria, "true");
    expect(root).toHaveAttribute("tabindex", "-1");
    activate(root);
    expect(root).toHaveAttribute("contenteditable", "false");
  });

  it("flushes before forwarding a structural key with its captured snapshot", () => {
    const order: string[] = [];
    const onEditorKeyDown = vi.fn((_event, snapshot) => {
      order.push(`key:${snapshot.source}:${snapshot.selection.focusUtf16}`);
    });
    const { root } = renderEditor({
      onPublish: (source) => order.push(`publish:${source}`),
      onEditorKeyDown
    });
    activate(root);
    inputSource(root, "next");

    fireEvent.keyDown(root, { key: "Enter" });

    expect(order).toEqual(["publish:next", "key:next:4"]);
  });

  it("publishes before forwarding Ctrl+Y redo", () => {
    const order: string[] = [];
    const { root } = renderEditor({
      onPublish: (source) => order.push(`publish:${source}`),
      onEditorKeyDown: (_event, snapshot) => {
        order.push(`key:${snapshot.source}`);
      }
    });
    activate(root);
    inputSource(root, "redo source");

    fireEvent.keyDown(root, { key: "y", ctrlKey: true });

    expect(order).toEqual(["publish:redo source", "key:redo source"]);
  });

  it("renders a supplied resting presentation inside the stable root", () => {
    const { root } = renderEditor({
      restingPresentation: (requestEdit) => (
        <button type="button" onClick={requestEdit}>
          Preview
        </button>
      )
    });

    fireEvent.click(screen.getByRole("button", { name: "Preview" }));
    expect(root).toHaveAttribute("contenteditable", "plaintext-only");
    expect(root).toHaveTextContent("before");
  });
});
