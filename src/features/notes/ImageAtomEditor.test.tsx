import {
  act,
  createEvent,
  fireEvent,
  render,
  screen,
  waitFor
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  createRef,
  StrictMode,
  type ComponentProps,
  type KeyboardEvent as ReactKeyboardEvent
} from "react";
import { describe, expect, it, vi } from "vitest";
import type { NoteAttachment } from "../../domain/notes";
import type { LogicalSelection } from "./imageAtomModel";
import { readImageAtomDomSelection } from "./imageAtomDomSelection";
import {
  ImageAtomEditor,
  type ImageAtomEditorHandle
} from "./ImageAtomEditor";
import { createNotesImageAtomEditorRegistry } from "./notesImageAtomEditorRegistry";

vi.mock("./NotesImageAttachment", async () => {
  const { NotesImageMenu } = await vi.importActual<typeof import("./NotesImageMenu")>(
    "./NotesImageMenu"
  );
  return {
    NotesImageNodeContent: ({
      attachment,
      contentRef,
      onKeyDown,
      onEscape
    }: {
      attachment: NoteAttachment;
      contentRef?: ComponentProps<"div">["ref"];
      onKeyDown?: ComponentProps<"div">["onKeyDown"];
      onEscape?: () => boolean;
    }) => (
      <div
        ref={contentRef}
        data-testid="image-content"
        role="group"
        aria-label={`Image: ${attachment.originalName}`}
        tabIndex={0}
        onKeyDownCapture={(event) => {
          if (
            event.key === "Escape" &&
            event.target instanceof Node &&
            event.currentTarget.contains(event.target) &&
            onEscape?.()
          ) {
            event.preventDefault();
            event.stopPropagation();
          }
        }}
        onKeyDown={(event) => {
          if (event.key === "Tab") return;
          const opensContextMenu =
            event.key === "ContextMenu" ||
            (event.key === "F10" &&
              event.shiftKey &&
              !event.altKey &&
              !event.ctrlKey &&
              !event.metaKey);
          if (opensContextMenu) {
            event.preventDefault();
            event.currentTarget
              .querySelector<HTMLButtonElement>(".notes-image-menu-trigger")
              ?.click();
            return;
          }
          if (event.key === "Escape") {
            return;
          }
          if (event.target === event.currentTarget) onKeyDown?.(event);
        }}
      >
        {attachment.originalName}
        <NotesImageMenu originalName={attachment.originalName} />
        <div role="group" aria-label="Image controls">
          <div role="separator" aria-label="Resize image" tabIndex={0} />
        </div>
      </div>
    )
  };
});

const attachment: NoteAttachment = {
  id: "attachment",
  nodeId: "image-node",
  sortKey: 1024,
  relativePath: "attachments/cat.png",
  contentHash: "a".repeat(64),
  originalName: "cat.png",
  mimeType: "image/png",
  byteSize: 10,
  intrinsicWidth: 20,
  intrinsicHeight: 10,
  displayWidth: 20,
  createdAt: "2026-07-18T00:00:00Z",
  updatedAt: "2026-07-18T00:00:00Z"
};

function selection(
  host: HTMLElement,
  anchor: number,
  focus = anchor
): LogicalSelection {
  const regions = host.querySelectorAll<HTMLElement>("[data-image-atom-region]");
  const before = regions[0]!;
  const after = regions[2]!;
  const select = document.getSelection()!;
  const rawText = (region: HTMLElement): Text | null => {
    const raw = region.querySelector<HTMLElement>("[data-image-atom-raw]");
    const text = raw?.firstChild;
    return text?.nodeType === Node.TEXT_NODE ? (text as Text) : null;
  };
  const beforeText = rawText(before);
  const afterText = rawText(after);
  const beforeLength = beforeText?.length ?? 0;
  const point = (offset: number) => {
    const text = offset <= beforeLength ? beforeText : afterText;
    const region = offset <= beforeLength ? before : after;
    return text
      ? [text, offset <= beforeLength ? offset : offset - beforeLength - 1] as const
      : [region, 0] as const;
  };
  const [anchorNode, anchorOffset] = point(anchor);
  const [focusNode, focusOffset] = point(focus);
  select.removeAllRanges();
  select.setBaseAndExtent(anchorNode, anchorOffset, focusNode, focusOffset);
  return { anchorUtf16: anchor, focusUtf16: focus };
}

function renderEditor(overrides: Partial<ComponentProps<typeof ImageAtomEditor>> = {}) {
  const onDraftChange = vi.fn();
  const onEnter = overrides.onEnter ?? vi.fn();
  const onSupportingNote = overrides.onSupportingNote ?? vi.fn();
  const onUndo = overrides.onUndo ?? vi.fn();
  const onRedo = overrides.onRedo ?? vi.fn();
  const onPaste = overrides.onPaste ?? vi.fn().mockReturnValue(false);
  const onDrop = overrides.onDrop ?? vi.fn().mockReturnValue(false);
  const handle = createRef<ImageAtomEditorHandle>();
  const editor = (
    nextOverrides: Partial<ComponentProps<typeof ImageAtomEditor>> = overrides
  ) => (
    <ImageAtomEditor
      ref={handle}
      nodeId="image-node"
      draft={{ title: "beforeafter", note: "support", imageOffsetUtf16: 6 }}
      attachment={attachment}
      onDraftChange={onDraftChange}
      onEnter={onEnter}
      onSupportingNote={onSupportingNote}
      onUndo={onUndo}
      onRedo={onRedo}
      onPaste={onPaste}
      onDrop={onDrop}
      {...nextOverrides}
    />
  );
  const view = render(editor());
  const host = screen.getByRole("textbox");
  return {
    ...view,
    handle,
    host,
    onDraftChange,
    onEnter,
    onSupportingNote,
    onUndo,
    onRedo,
    onPaste,
    onDrop,
    rerenderEditor(nextOverrides: Partial<ComponentProps<typeof ImageAtomEditor>>) {
      view.rerender(editor({ ...overrides, ...nextOverrides }));
    }
  };
}

function logicalSelection(host: HTMLElement): LogicalSelection | null {
  const [before, atom, after] = host.querySelectorAll<HTMLElement>(
    "[data-image-atom-region]"
  );
  return before && atom && after
    ? readImageAtomDomSelection(
        { host, before, atom, after },
        document.getSelection()!
      )
    : null;
}

function beforeInput(
  host: HTMLElement,
  inputType: string,
  data: string | null = null
) {
  const event = new InputEvent("beforeinput", {
    bubbles: true,
    cancelable: true,
    inputType,
    data
  });
  fireEvent(host, event);
  return event;
}

describe("ImageAtomEditor", () => {
  it("moves a focused editor registration to the current workspace identity", () => {
    const firstRegistry = createNotesImageAtomEditorRegistry();
    const secondRegistry = createNotesImageAtomEditorRegistry();
    const firstPaste = vi.fn(() => true);
    const secondPaste = vi.fn(() => true);
    const editor = (nodeId: "node-a" | "node-b", registry: typeof firstRegistry) => (
      <ImageAtomEditor
        nodeId={nodeId}
        draft={{ title: "beforeafter", note: "support", imageOffsetUtf16: 6 }}
        attachment={{ ...attachment, nodeId }}
        onDraftChange={vi.fn()}
        onImageAtomPaste={nodeId === "node-a" ? firstPaste : secondPaste}
        registerActiveEditor={(active) => registry.register(active)}
      />
    );
    const view = render(editor("node-a", firstRegistry));
    const host = screen.getByRole("textbox");

    host.focus();
    expect(firstRegistry.claimPaste({} as ClipboardEvent)).toBe(true);
    expect(firstPaste).toHaveBeenCalledOnce();

    view.rerender(editor("node-b", secondRegistry));

    expect(screen.getByRole("textbox")).toBe(host);
    expect(firstRegistry.claimPaste({} as ClipboardEvent)).toBe(false);
    expect(secondRegistry.claimPaste({} as ClipboardEvent)).toBe(true);
    expect(secondPaste).toHaveBeenCalledOnce();
  });

  it("exposes selection only through an asynchronous flush barrier", async () => {
    const { host, handle } = renderEditor();
    const barrier = handle.current as unknown as {
      flushAndGetSelection(): Promise<LogicalSelection | null>;
      flush?: unknown;
      selection?: unknown;
    };

    expect(barrier.flush).toEqual(expect.any(Function));
    expect(barrier.selection).toBeUndefined();
    selection(host, 2, 5);
    await expect(barrier.flushAndGetSelection()).resolves.toEqual({
      anchorUtf16: 2,
      focusUtf16: 5
    });
  });

  it("reports whether restoring a committed logical selection succeeded", () => {
    const { handle, host } = renderEditor();

    let restored: unknown;
    act(() => {
      restored = handle.current?.focus({ anchorUtf16: 6, focusUtf16: 7 });
    });
    expect(restored).toBe(true);
    expect(logicalSelection(host)).toEqual({
      anchorUtf16: 6,
      focusUtf16: 7
    });
  });

  it("remains flushable after StrictMode replays its mount effects", async () => {
    const handle = createRef<ImageAtomEditorHandle>();
    render(
      <StrictMode>
        <ImageAtomEditor
          ref={handle}
          nodeId="image-node"
          draft={{ title: "beforeafter", note: "support", imageOffsetUtf16: 6 }}
          attachment={attachment}
          onDraftChange={vi.fn()}
        />
      </StrictMode>
    );

    await expect(handle.current!.flush()).resolves.toBe("flushed");
  });

  it("projects one accessible editable host with stable before, atom, and after regions", () => {
    const { host } = renderEditor();
    const regions = host.querySelectorAll("[data-image-atom-region]");

    expect(host).toHaveAttribute("aria-multiline", "true");
    expect(regions).toHaveLength(3);
    expect(regions[0]).toHaveAttribute("data-image-atom-region", "before");
    expect(regions[1]).toHaveAttribute("data-image-atom-region", "atom");
    expect(regions[1]).toHaveAttribute("contenteditable", "false");
    expect(regions[2]).toHaveAttribute("data-image-atom-region", "after");
    expect(screen.getByTestId("image-content")).toHaveTextContent("cat.png");
  });

  it("exposes one named multiline textbox with exact writable, read-only, and disabled states", () => {
    const writable = renderEditor();

    expect(screen.getByRole("textbox", { name: "Image note" })).toBe(
      writable.host
    );
    expect(writable.host).toHaveAttribute("aria-multiline", "true");
    expect(writable.host).toHaveAttribute("contenteditable", "true");
    expect(writable.host).not.toHaveAttribute("aria-readonly");

    writable.unmount();
    const readOnly = renderEditor({ readOnly: true });
    expect(readOnly.host).toHaveAttribute("aria-readonly", "true");
    expect(readOnly.host).toHaveAttribute("contenteditable", "false");
    beforeInput(readOnly.host, "insertText", "X");
    expect(readOnly.onDraftChange).not.toHaveBeenCalled();

    readOnly.unmount();
    const disabled = renderEditor({ disabled: true });
    expect(disabled.host).toHaveAttribute("aria-readonly", "true");
    expect(disabled.host).toHaveAttribute("contenteditable", "false");
    beforeInput(disabled.host, "insertText", "X");
    expect(disabled.onDraftChange).not.toHaveBeenCalled();
  });

  it("keeps legal, mapper-ignored caret targets in empty text regions", () => {
    const { host } = renderEditor({
      draft: { title: "", note: "support", imageOffsetUtf16: 0 }
    });

    const caretAids = host.querySelectorAll<HTMLElement>(
      "[data-image-atom-caret-aid]"
    );
    expect(caretAids).toHaveLength(2);
    expect([...caretAids].map((element) => element.tagName)).toEqual(["BR", "BR"]);
    expect(host.textContent).toContain("cat.png");
    expect(() => selection(host, 0)).not.toThrow();
    expect(() => selection(host, 1)).not.toThrow();
  });

  it("shows independently parsed overlays at rest and reveals raw segment text while editing", () => {
    const { host } = renderEditor({
      draft: { title: "before#after", note: "support", imageOffsetUtf16: 6 }
    });
    const beforeRaw = host.querySelector<HTMLElement>("[data-image-atom-region=before] [data-image-atom-raw]")!;
    const overlay = host.querySelector<HTMLElement>("[data-image-atom-region=after] [data-image-atom-overlay-container]")!;

    expect(host).toHaveAttribute("data-image-atom-editing", "false");
    expect(beforeRaw).toHaveStyle({ opacity: "0" });
    expect(overlay).toHaveStyle({ visibility: "visible" });
    expect(overlay.querySelector(".notes-tag-token")).toHaveTextContent("#after");

    fireEvent.focus(host);
    expect(host).toHaveAttribute("data-image-atom-editing", "true");
    expect(beforeRaw).toHaveStyle({ opacity: "1" });
    expect(overlay).toHaveStyle({ visibility: "hidden" });
  });

  it("inherits each text region padding so resting and editing baselines stay aligned", () => {
    const { host } = renderEditor({
      draft: { title: "beforeafter", note: "support", imageOffsetUtf16: 6 }
    });
    const overlays = host.querySelectorAll<HTMLElement>(
      "[data-image-atom-overlay-container]"
    );

    expect(overlays).toHaveLength(2);
    for (const overlay of overlays) {
      expect(overlay).toHaveStyle({
        position: "absolute",
        inset: "0"
      });
      expect(overlay.style.padding).toBe("inherit");
    }
  });

  it("exposes the resting overlay to accessibility while hiding only the raw projection", () => {
    const { host } = renderEditor({
      draft: { title: "before#after", note: "support", imageOffsetUtf16: 6 }
    });
    const raw = host.querySelector<HTMLElement>("[data-image-atom-raw]")!;
    const overlay = host.querySelector<HTMLElement>("[data-image-atom-overlay]")!;
    const container = host.querySelector<HTMLElement>(
      "[data-image-atom-overlay-container]"
    )!;

    expect(raw).toHaveAttribute("aria-hidden", "true");
    expect(overlay).not.toHaveAttribute("aria-hidden");
    expect(container).toHaveAttribute("contenteditable", "false");

    fireEvent.focus(host);
    expect(raw).not.toHaveAttribute("aria-hidden");
    expect(overlay).toHaveAttribute("aria-hidden", "true");
  });

  it("keeps resting presentation visible when focus moves among nested controls", () => {
    const { host } = renderEditor({
      draft: { title: "before#after", note: "support", imageOffsetUtf16: 6 }
    });
    const tag = host.querySelector<HTMLElement>(".notes-tag-token")!;
    const resize = screen.getByRole("separator", { name: "Resize image" });

    fireEvent.focus(tag);
    expect(host).toHaveAttribute("data-image-atom-editing", "false");

    fireEvent.focus(host);
    fireEvent.blur(host, { relatedTarget: resize });
    expect(host).toHaveAttribute("data-image-atom-editing", "true");
  });

  it("leaves keyboard handling to focused overlay and image controls", () => {
    const { host, onEnter, onUndo } = renderEditor({
      draft: {
        title: "before#after today https://example.com",
        note: "support",
        imageOffsetUtf16: 6
      },
      onDateClick: vi.fn(),
      today: { year: 2026, month: 7, day: 18 }
    });
    const targets = [
      host.querySelector<HTMLElement>(".notes-tag-token")!,
      host.querySelector<HTMLElement>(".notes-date-token")!,
      host.querySelector<HTMLElement>(".notes-url-token")!,
      screen.getByTestId("image-content"),
      screen.getByRole("separator", { name: "Resize image" })
    ];

    for (const target of targets) {
      selection(host, 6);
      fireEvent.focus(target);
      fireEvent.keyDown(target, { key: "Enter" });
      fireEvent.keyDown(target, { key: "ArrowRight" });
      fireEvent.keyDown(target, { key: "z", metaKey: true });
      expect(logicalSelection(host)).toEqual({ anchorUtf16: 6, focusUtf16: 6 });
    }

    expect(onEnter).not.toHaveBeenCalled();
    expect(onUndo).not.toHaveBeenCalled();
  });

  it("maps insertText in the before and after regions without moving the atom", () => {
    const beforeEditor = renderEditor();

    selection(beforeEditor.host, 2);
    expect(beforeInput(beforeEditor.host, "insertText", "X").defaultPrevented).toBe(true);
    expect(beforeEditor.onDraftChange).toHaveBeenLastCalledWith({
      title: "beXforeafter",
      note: "support",
      imageOffsetUtf16: 7
    });
    beforeEditor.unmount();

    const afterEditor = renderEditor();
    selection(afterEditor.host, 10);
    beforeInput(afterEditor.host, "insertText", "Y");
    expect(afterEditor.onDraftChange).toHaveBeenLastCalledWith({
      title: "beforeaftYer",
      note: "support",
      imageOffsetUtf16: 6
    });
  });

  it("maps a spellcheck replacement once and blocks paragraph and HTML mutations", () => {
    const { host, onDraftChange, onEnter } = renderEditor();

    selection(host, 1, 4);
    beforeInput(host, "insertReplacementText", "EE");
    expect(onDraftChange).toHaveBeenLastCalledWith({
      title: "bEEreafter",
      note: "support",
      imageOffsetUtf16: 5
    });

    expect(beforeInput(host, "insertParagraph").defaultPrevented).toBe(true);
    expect(onEnter).toHaveBeenCalledOnce();
    expect(beforeInput(host, "insertLineBreak").defaultPrevented).toBe(true);
    expect(beforeInput(host, "insertFromPaste", "<b>no</b>").defaultPrevented).toBe(true);
  });

  it("blocks every unsupported beforeinput mutation and repairs same-text markup", async () => {
    const { host } = renderEditor();
    const raw = host.querySelector<HTMLElement>(
      "[data-image-atom-region=before] [data-image-atom-raw]"
    )!;

    expect(beforeInput(host, "insertHTML", "<b>before</b>").defaultPrevented).toBe(true);
    expect(beforeInput(host, "deleteByCut").defaultPrevented).toBe(true);
    expect(beforeInput(host, "deleteByDrag").defaultPrevented).toBe(true);

    raw.innerHTML = "<b>before</b>";
    await waitFor(() =>
      expect(host.querySelector("[data-image-atom-region=before] b")).toBeNull()
    );
    expect(
      host.querySelector("[data-image-atom-region=before] [data-image-atom-raw]")
    ).toHaveTextContent("before");
  });

  it("repairs changed overlay text instead of trusting the raw projection alone", async () => {
    const { host } = renderEditor({
      draft: { title: "before#after", note: "support", imageOffsetUtf16: 6 }
    });
    const overlay = host.querySelector<HTMLElement>(
      "[data-image-atom-region=after] [data-image-atom-overlay]"
    )!;

    overlay.textContent = "#wrong";

    await waitFor(() =>
      expect(
        host.querySelector<HTMLElement>(
          "[data-image-atom-region=after] [data-image-atom-overlay]"
        )
      ).toHaveTextContent("#after")
    );
  });

  it("repairs same-text arbitrary overlay markup without looping on token state rerenders", async () => {
    const { host, rerenderEditor } = renderEditor({
      draft: { title: "before#after", note: "support", imageOffsetUtf16: 6 },
      isTagActive: () => false
    });
    const overlay = host.querySelector<HTMLElement>(
      "[data-image-atom-region=after] [data-image-atom-overlay]"
    )!;

    overlay.innerHTML = "<b>#after</b>";

    await waitFor(() =>
      expect(host.querySelector("[data-image-atom-region=after] b")).toBeNull()
    );
    const repairedOverlay = host.querySelector<HTMLElement>(
      "[data-image-atom-region=after] [data-image-atom-overlay]"
    )!;
    const repairedRaw = host.querySelector<HTMLElement>(
      "[data-image-atom-region=after] [data-image-atom-raw]"
    )!;

    rerenderEditor({ isTagActive: () => true });
    await waitFor(() =>
      expect(host.querySelector(".notes-tag-token")).toHaveAttribute(
        "aria-pressed",
        "true"
      )
    );
    expect(
      host.querySelector("[data-image-atom-region=after] [data-image-atom-overlay]")
    ).toBe(repairedOverlay);
    expect(
      host.querySelector("[data-image-atom-region=after] [data-image-atom-raw]")
    ).toBe(repairedRaw);
  });

  it("routes Notes undo/redo, supporting-note, paste, and drop instead of allowing native structure", () => {
    const { host, onUndo, onRedo, onSupportingNote, onPaste, onDrop } = renderEditor({
      onPaste: vi.fn().mockReturnValue(true),
      onDrop: vi.fn().mockReturnValue(true)
    });

    fireEvent.keyDown(host, { key: "z", metaKey: true });
    fireEvent.keyDown(host, { key: "z", metaKey: true, shiftKey: true });
    fireEvent.keyDown(host, { key: "Enter", shiftKey: true });
    const paste = fireEvent.paste(host, { clipboardData: { getData: () => "plain" } });
    const drop = fireEvent.drop(host, { dataTransfer: { getData: () => "plain" } });

    expect(onUndo).toHaveBeenCalledOnce();
    expect(onRedo).toHaveBeenCalledOnce();
    expect(onSupportingNote).toHaveBeenCalledOnce();
    expect(onPaste).toHaveBeenCalledOnce();
    expect(onDrop).toHaveBeenCalledOnce();
    expect(paste).toBe(false);
    expect(drop).toBe(false);
  });

  it("inserts unclaimed plain paste text while leaving empty and read-only pastes untouched", () => {
    const editable = renderEditor();
    act(() =>
      editable.handle.current!.restoreSelection({ anchorUtf16: 2, focusUtf16: 2 })
    );

    expect(
      fireEvent.paste(editable.host, {
        clipboardData: {
          getData: (type: string) => (type === "text/plain" ? "X" : "")
        }
      })
    ).toBe(false);
    expect(editable.onDraftChange).toHaveBeenLastCalledWith({
      title: "beXforeafter",
      note: "support",
      imageOffsetUtf16: 7
    });

    expect(
      fireEvent.paste(editable.host, {
        clipboardData: { getData: () => "" }
      })
    ).toBe(true);
    expect(editable.onDraftChange).toHaveBeenCalledOnce();

    editable.unmount();
    const readOnly = renderEditor({ readOnly: true });
    expect(
      fireEvent.paste(readOnly.host, {
        clipboardData: { getData: () => "X" }
      })
    ).toBe(true);
    expect(readOnly.onDraftChange).not.toHaveBeenCalled();
  });

  it("routes beforeinput history undo and redo to Notes history", () => {
    const { host, onUndo, onRedo } = renderEditor();

    expect(beforeInput(host, "historyUndo").defaultPrevented).toBe(true);
    expect(beforeInput(host, "historyRedo").defaultPrevented).toBe(true);
    expect(onUndo).toHaveBeenCalledOnce();
    expect(onRedo).toHaveBeenCalledOnce();
  });

  it("crosses and selects the atom in one Arrow key step", () => {
    const { host, handle } = renderEditor();

    act(() => handle.current!.restoreSelection({ anchorUtf16: 6, focusUtf16: 6 }));
    fireEvent.keyDown(host, { key: "ArrowRight" });
    expect(document.getSelection()?.anchorOffset).toBe(0);
    expect(handle.current!.containsAtomSelection()).toBe(false);

    fireEvent.keyDown(host, { key: "ArrowLeft", shiftKey: true });
    expect(handle.current!.containsAtomSelection()).toBe(true);
    fireEvent.keyDown(host, { key: "ArrowRight", shiftKey: true });
    expect(handle.current!.containsAtomSelection()).toBe(false);
  });

  it("enters the named image group with F6 only for an exact atom-only selection", () => {
    const onUnhandledKeyDown = vi.fn();
    const { host, handle } = renderEditor({ onUnhandledKeyDown });
    const group = screen.getByRole("group", { name: "Image: cat.png" });

    act(() => handle.current!.restoreSelection({ anchorUtf16: 7, focusUtf16: 6 }));
    expect(fireEvent.keyDown(host, { key: "F6" })).toBe(false);
    expect(group).toHaveFocus();
    expect(onUnhandledKeyDown).not.toHaveBeenCalled();

    onUnhandledKeyDown.mockClear();
    act(() => handle.current!.restoreSelection({ anchorUtf16: 7, focusUtf16: 6 }));
    host.focus();
    expect(fireEvent.keyDown(host, { key: "F6", shiftKey: true })).toBe(true);
    expect(onUnhandledKeyDown).toHaveBeenCalledOnce();
    expect(host).toHaveFocus();
    expect(group).not.toHaveFocus();

    onUnhandledKeyDown.mockClear();
    expect(fireEvent.keyDown(host, { key: "F6", repeat: true })).toBe(true);
    expect(onUnhandledKeyDown).toHaveBeenCalledOnce();
    expect(host).toHaveFocus();
    expect(group).not.toHaveFocus();

    onUnhandledKeyDown.mockClear();
    act(() => handle.current!.restoreSelection({ anchorUtf16: 2, focusUtf16: 2 }));
    host.focus();
    fireEvent.keyDown(host, { key: "F6" });
    expect(onUnhandledKeyDown).toHaveBeenCalledOnce();
    expect(host).toHaveFocus();

    onUnhandledKeyDown.mockClear();
    act(() => handle.current!.restoreSelection({ anchorUtf16: 5, focusUtf16: 8 }));
    fireEvent.keyDown(host, { key: "F6" });
    expect(onUnhandledKeyDown).toHaveBeenCalledOnce();
    expect(host).toHaveFocus();
  });

  it("keeps the existing image control Tab order and restores the exact atom selection with Escape", async () => {
    const user = userEvent.setup();
    const { host, handle } = renderEditor();
    const group = screen.getByTestId("image-content");
    const actions = screen.getByRole("button", {
      name: "Image actions for cat.png"
    });
    const resize = screen.getByRole("separator", { name: "Resize image" });

    act(() => handle.current!.restoreSelection({ anchorUtf16: 7, focusUtf16: 6 }));
    fireEvent.keyDown(host, { key: "F6" });
    expect(group).toHaveFocus();
    await user.tab();
    expect(actions).toHaveFocus();
    await user.tab();
    expect(resize).toHaveFocus();

    fireEvent.keyDown(resize, { key: "Escape" });
    expect(host).toHaveFocus();
    expect(logicalSelection(host)).toEqual({ anchorUtf16: 7, focusUtf16: 6 });
  });

  it.each([
    ["ContextMenu", { key: "ContextMenu", shiftKey: false }],
    ["Shift+F10", { key: "F10", shiftKey: true }]
  ] as const)("opens image actions from an editor-selected atom with %s", async (_label, init) => {
    const onUnhandledKeyDown = vi.fn(
      (event: ReactKeyboardEvent<HTMLDivElement>) => event.preventDefault()
    );
    const { host, handle } = renderEditor({ onUnhandledKeyDown });
    const actions = screen.getByRole("button", {
      name: "Image actions for cat.png"
    });

    act(() => handle.current!.restoreSelection({ anchorUtf16: 7, focusUtf16: 6 }));
    expect(fireEvent.keyDown(host, init)).toBe(false);
    const menu = screen.getByRole("menu");
    await waitFor(() => expect(menu).toBeVisible());
    expect(onUnhandledKeyDown).not.toHaveBeenCalled();

    fireEvent.keyDown(menu, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("menu")).not.toBeInTheDocument());
    expect([actions, screen.getByTestId("image-content")]).toContain(
      document.activeElement
    );
    fireEvent.keyDown(document.activeElement as HTMLElement, { key: "Escape" });
    expect(host).toHaveFocus();
    expect(logicalSelection(host)).toEqual({ anchorUtf16: 7, focusUtf16: 6 });

    act(() => handle.current!.restoreSelection({ anchorUtf16: 2, focusUtf16: 2 }));
    host.focus();
    fireEvent.keyDown(host, init);
    expect(onUnhandledKeyDown).toHaveBeenCalledOnce();
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  });

  it.each(["read-only", "disabled"] as const)(
    "does not enter or mutate image controls from a %s editor",
    (state) => {
      const overrides = state === "read-only" ? { readOnly: true } : { disabled: true };
      const { host, handle, onDraftChange } = renderEditor(overrides);
      const group = screen.getByTestId("image-content");

      act(() => handle.current!.restoreSelection({ anchorUtf16: 7, focusUtf16: 6 }));
      host.focus();
      expect(fireEvent.keyDown(host, { key: "F6" })).toBe(true);
      expect(group).not.toHaveFocus();
      beforeInput(host, "insertText", "X");
      expect(onDraftChange).not.toHaveBeenCalled();
    }
  );

  it("keeps a reverse Shift+Arrow selection continuous across the atom", () => {
    const { host, handle } = renderEditor();

    act(() => handle.current!.restoreSelection({ anchorUtf16: 7, focusUtf16: 7 }));
    fireEvent.keyDown(host, { key: "ArrowLeft", shiftKey: true });
    expect(handle.current!.containsAtomSelection()).toBe(true);
    fireEvent.keyDown(host, { key: "ArrowRight", shiftKey: true });
    expect(handle.current!.containsAtomSelection()).toBe(false);
  });

  it("keeps Shift+Up or Shift+Down inside the atom selection without delegating row actions", () => {
    const onUnhandledKeyDown = vi.fn();
    const { host, handle } = renderEditor({ onUnhandledKeyDown });

    act(() => handle.current!.restoreSelection({ anchorUtf16: 2, focusUtf16: 9 }));
    fireEvent.keyDown(host, { key: "ArrowDown", shiftKey: true });
    expect(handle.current!.containsAtomSelection()).toBe(true);
    fireEvent.keyDown(host, { key: "ArrowUp", shiftKey: true });
    expect(handle.current!.containsAtomSelection()).toBe(true);
    expect(onUnhandledKeyDown).not.toHaveBeenCalled();
  });

  it.each([
    ["Tab", false],
    ["Shift+Tab", true]
  ] as const)("keeps group %s native without exposing nested controls", (_name, shiftKey) => {
    const onUnhandledKeyDown = vi.fn(
      (event: ReactKeyboardEvent<HTMLDivElement>) => event.preventDefault()
    );
    renderEditor({ onUnhandledKeyDown });

    const imageBody = screen.getByTestId("image-content");
    expect(fireEvent.keyDown(imageBody, { key: "Tab", shiftKey })).toBe(true);
    expect(onUnhandledKeyDown).not.toHaveBeenCalled();

    fireEvent.keyDown(screen.getByRole("separator", { name: "Resize image" }), {
      key: "Tab",
      shiftKey
    });
    expect(onUnhandledKeyDown).not.toHaveBeenCalled();
  });

  it("forwards a non-Tab image-body key to the row handler", () => {
    const onUnhandledKeyDown = vi.fn(
      (event: ReactKeyboardEvent<HTMLDivElement>) => event.preventDefault()
    );
    renderEditor({ onUnhandledKeyDown });

    expect(
      fireEvent.keyDown(screen.getByTestId("image-content"), { key: "Enter" })
    ).toBe(false);
    expect(onUnhandledKeyDown).toHaveBeenCalledOnce();
  });

  it("extends collapsed vertical selections across the atom in both directions", () => {
    const first = renderEditor();
    act(() => first.handle.current!.restoreSelection({ anchorUtf16: 2, focusUtf16: 2 }));
    fireEvent.keyDown(first.host, { key: "ArrowDown", shiftKey: true });
    expect(first.handle.current!.containsAtomSelection()).toBe(true);
    first.unmount();

    const second = renderEditor();
    act(() => second.handle.current!.restoreSelection({ anchorUtf16: 9, focusUtf16: 9 }));
    fireEvent.keyDown(second.host, { key: "ArrowUp", shiftKey: true });
    expect(second.handle.current!.containsAtomSelection()).toBe(true);
  });

  it("selects the atom from its body click or drag anchor", () => {
    const { host, handle } = renderEditor();
    const atom = host.querySelector<HTMLElement>("[data-image-atom-region=atom]")!;

    fireEvent.click(atom);
    expect(handle.current!.containsAtomSelection()).toBe(true);
    fireEvent.pointerDown(atom, { button: 0 });
    expect(handle.current!.containsAtomSelection()).toBe(true);
  });

  it("versions semantic selection ABA but ignores no-op restores and duplicate events", async () => {
    const { handle } = renderEditor();
    act(() =>
      handle.current!.restoreSelection({ anchorUtf16: 6, focusUtf16: 7 })
    );
    const first = await handle.current!.flushAndGetSelectionSnapshot();

    act(() => {
      handle.current!.restoreSelection({ anchorUtf16: 6, focusUtf16: 7 });
      fireEvent(document, new Event("selectionchange"));
      fireEvent(document, new Event("selectionchange"));
    });
    const duplicate = await handle.current!.flushAndGetSelectionSnapshot();
    expect(duplicate?.authority).toBe(first?.authority);

    act(() => {
      handle.current!.restoreSelection({ anchorUtf16: 8, focusUtf16: 8 });
      handle.current!.restoreSelection({ anchorUtf16: 6, focusUtf16: 7 });
    });
    const returned = await handle.current!.flushAndGetSelectionSnapshot();
    expect(returned?.selection).toEqual(first?.selection);
    expect(returned?.authority).not.toBe(first?.authority);
  });

  it("extends a pointer drag from its original text anchor through the atom", () => {
    const { host, handle } = renderEditor();
    const atom = host.querySelector<HTMLElement>("[data-image-atom-region=atom]")!;

    act(() => handle.current!.restoreSelection({ anchorUtf16: 2, focusUtf16: 2 }));
    fireEvent.pointerDown(atom, { button: 0, shiftKey: true });
    fireEvent.pointerMove(atom, { buttons: 1 });

    expect(handle.current!.containsAtomSelection()).toBe(true);
    fireEvent.pointerUp(atom);
  });

  it("abandons captured atom selection when a parent claims the pointer drag", () => {
    const { host, handle } = renderEditor();
    const atom = host.querySelector<HTMLElement>("[data-image-atom-region=atom]")!;
    const releasePointerCapture = vi.fn();
    Object.assign(atom, {
      setPointerCapture: vi.fn(),
      releasePointerCapture
    });

    fireEvent.pointerDown(atom, { button: 0, pointerId: 17 });
    const move = createEvent.pointerMove(atom, {
      buttons: 1,
      pointerId: 17,
      clientX: 100,
      clientY: 100
    });
    move.preventDefault();
    fireEvent(atom, move);

    expect(releasePointerCapture).toHaveBeenCalledWith(17);
    act(() => handle.current!.restoreSelection({ anchorUtf16: 2, focusUtf16: 2 }));
    fireEvent.pointerUp(atom, { pointerId: 17 });
    fireEvent.click(atom);
    expect(logicalSelection(host)).toEqual({ anchorUtf16: 2, focusUtf16: 2 });
  });

  it("does not turn an image control click into atom selection", () => {
    const { handle } = renderEditor();
    const control = screen.getByRole("separator", { name: "Resize image" });

    act(() => handle.current!.restoreSelection({ anchorUtf16: 2, focusUtf16: 2 }));
    fireEvent.pointerDown(control, { button: 0 });
    fireEvent.click(control);

    expect(handle.current!.containsAtomSelection()).toBe(false);
  });

  it("focuses the host and prevents native focus theft on atom body pointerdown", () => {
    const { host, handle } = renderEditor();
    const imageBody = screen.getByTestId("image-content");

    expect(fireEvent.pointerDown(imageBody, { button: 0, pointerId: 4 })).toBe(false);
    expect(host).toHaveFocus();
    expect(handle.current!.containsAtomSelection()).toBe(true);
  });

  it("maps an outside drag coordinate and preserves the range through the following click", () => {
    const { host } = renderEditor();
    const atom = host.querySelector<HTMLElement>("[data-image-atom-region=atom]")!;
    const afterText = host.querySelector<HTMLElement>(
      "[data-image-atom-region=after] [data-image-atom-raw]"
    )!.firstChild!;
    const caretDocument = document as unknown as {
      caretPositionFromPoint?: (x: number, y: number) => {
        offsetNode: Node;
        offset: number;
      } | null;
    };
    const previousCaretPosition = caretDocument.caretPositionFromPoint;
    caretDocument.caretPositionFromPoint = vi.fn(() => ({
      offsetNode: afterText,
      offset: 5
    }));
    Object.assign(atom, {
      setPointerCapture: vi.fn(),
      releasePointerCapture: vi.fn()
    });

    try {
      fireEvent.pointerDown(atom, { button: 0, pointerId: 7, clientX: 10, clientY: 10 });
      fireEvent.pointerMove(atom, { buttons: 1, pointerId: 7, clientX: 900, clientY: 900 });
      expect(logicalSelection(host)).toEqual({ anchorUtf16: 6, focusUtf16: 12 });
      fireEvent.pointerUp(atom, { pointerId: 7 });
      fireEvent.click(atom);
      expect(logicalSelection(host)).toEqual({ anchorUtf16: 6, focusUtf16: 12 });
    } finally {
      caretDocument.caretPositionFromPoint = previousCaretPosition;
    }
  });

  it.each([
    ["left", 25, 6],
    ["right", 75, 7]
  ])("anchors an atom-body drag at the nearest %s image boundary", (_, clientX, anchor) => {
    const { host } = renderEditor();
    const atom = host.querySelector<HTMLElement>("[data-image-atom-region=atom]")!;
    const afterText = host.querySelector<HTMLElement>(
      "[data-image-atom-region=after] [data-image-atom-raw]"
    )!.firstChild!;
    const caretDocument = document as unknown as {
      caretPositionFromPoint?: () => { offsetNode: Node; offset: number } | null;
    };
    const previousCaretPosition = caretDocument.caretPositionFromPoint;
    caretDocument.caretPositionFromPoint = vi.fn(() => ({
      offsetNode: afterText,
      offset: 5
    }));
    vi.spyOn(atom, "getBoundingClientRect").mockReturnValue({
      x: 0,
      y: 0,
      top: 0,
      right: 100,
      bottom: 100,
      left: 0,
      width: 100,
      height: 100,
      toJSON: () => ({})
    });

    try {
      fireEvent.pointerDown(atom, { button: 0, pointerId: 8, clientX });
      expect(logicalSelection(host)).toEqual({ anchorUtf16: 6, focusUtf16: 7 });
      fireEvent.pointerMove(atom, { buttons: 1, pointerId: 8, clientX });
      expect(logicalSelection(host)).toEqual({ anchorUtf16: anchor, focusUtf16: 12 });
    } finally {
      caretDocument.caretPositionFromPoint = previousCaretPosition;
    }
  });

  it("maps a resting plain-text pointer to the selected segment caret", async () => {
    const { host, onDraftChange } = renderEditor();
    const overlay = host.querySelector<HTMLElement>(
      "[data-image-atom-region=after] [data-image-atom-overlay-container]"
    )!;
    const overlayText = overlay.querySelector("[data-image-atom-overlay]")!.firstChild!;
    const caretDocument = document as unknown as {
      caretPositionFromPoint?: (x: number, y: number) => {
        offsetNode: Node;
        offset: number;
      } | null;
    };
    const previousCaretPosition = caretDocument.caretPositionFromPoint;
    caretDocument.caretPositionFromPoint = vi.fn(() => ({
      offsetNode: overlayText,
      offset: 2
    }));

    try {
      fireEvent.pointerDown(overlay, { button: 0, clientX: 40, clientY: 20 });
      await act(async () => Promise.resolve());
      beforeInput(host, "insertText", "X");
      expect(onDraftChange).toHaveBeenLastCalledWith({
        title: "beforeafXter",
        note: "support",
        imageOffsetUtf16: 6
      });
    } finally {
      caretDocument.caretPositionFromPoint = previousCaretPosition;
    }
  });

  it("marks only an atom-containing selection as selected", async () => {
    const { host, handle } = renderEditor();
    const atom = host.querySelector<HTMLElement>("[data-image-atom-region=atom]")!;

    act(() => handle.current!.restoreSelection({ anchorUtf16: 6, focusUtf16: 7 }));
    document.dispatchEvent(new Event("selectionchange"));
    await waitFor(() => expect(atom).toHaveAttribute("data-atom-selected", "true"));

    act(() => handle.current!.restoreSelection({ anchorUtf16: 7, focusUtf16: 6 }));
    document.dispatchEvent(new Event("selectionchange"));
    await waitFor(() => expect(atom).toHaveAttribute("data-atom-selected", "true"));

    act(() => handle.current!.restoreSelection({ anchorUtf16: 2, focusUtf16: 2 }));
    document.dispatchEvent(new Event("selectionchange"));
    await waitFor(() => expect(atom).not.toHaveAttribute("data-atom-selected"));
  });

  it("maps image-only collapsed selections to the image's left and right caret edges", async () => {
    const { host, handle } = renderEditor({
      draft: { title: "", note: "support", imageOffsetUtf16: 0 }
    });
    const before = host.querySelector<HTMLElement>(
      '[data-image-atom-region="before"]'
    );
    const after = host.querySelector<HTMLElement>(
      '[data-image-atom-region="after"]'
    );
    expect(before).toHaveAttribute("data-image-atom-empty", "true");
    expect(after).toHaveAttribute("data-image-atom-empty", "true");

    act(() => {
      handle.current!.restoreSelection({ anchorUtf16: 0, focusUtf16: 0 });
      document.dispatchEvent(new Event("selectionchange"));
    });
    await waitFor(() =>
      expect(host).toHaveAttribute("data-image-atom-caret-side", "before")
    );

    act(() => {
      handle.current!.restoreSelection({ anchorUtf16: 1, focusUtf16: 1 });
      document.dispatchEvent(new Event("selectionchange"));
    });
    await waitFor(() =>
      expect(host).toHaveAttribute("data-image-atom-caret-side", "after")
    );
  });

  it("materializes and collapses only the typed side around an image-only atom", () => {
    const beforeEditor = renderEditor({
      draft: { title: "", note: "support", imageOffsetUtf16: 0 }
    });
    act(() =>
      beforeEditor.handle.current!.restoreSelection({
        anchorUtf16: 0,
        focusUtf16: 0
      })
    );
    beforeInput(beforeEditor.host, "insertText", "A");
    expect(beforeEditor.onDraftChange).toHaveBeenLastCalledWith({
      title: "A",
      note: "support",
      imageOffsetUtf16: 1
    });
    beforeEditor.rerenderEditor({
      draft: { title: "A", note: "support", imageOffsetUtf16: 1 }
    });
    expect(
      beforeEditor.host.querySelector('[data-image-atom-region="before"]')
    ).not.toHaveAttribute("data-image-atom-empty");
    expect(
      beforeEditor.host.querySelector('[data-image-atom-region="after"]')
    ).toHaveAttribute("data-image-atom-empty", "true");

    act(() =>
      beforeEditor.handle.current!.restoreSelection({
        anchorUtf16: 1,
        focusUtf16: 1
      })
    );
    beforeInput(beforeEditor.host, "deleteContentBackward");
    expect(beforeEditor.onDraftChange).toHaveBeenLastCalledWith({
      title: "",
      note: "support",
      imageOffsetUtf16: 0
    });
    beforeEditor.rerenderEditor({
      draft: { title: "", note: "support", imageOffsetUtf16: 0 }
    });
    expect(
      beforeEditor.host.querySelector('[data-image-atom-region="before"]')
    ).toHaveAttribute("data-image-atom-empty", "true");
    expect(beforeEditor.onEnter).not.toHaveBeenCalled();
    beforeEditor.unmount();

    const afterEditor = renderEditor({
      draft: { title: "", note: "support", imageOffsetUtf16: 0 }
    });
    act(() =>
      afterEditor.handle.current!.restoreSelection({
        anchorUtf16: 1,
        focusUtf16: 1
      })
    );
    beforeInput(afterEditor.host, "insertText", "B");
    expect(afterEditor.onDraftChange).toHaveBeenLastCalledWith({
      title: "B",
      note: "support",
      imageOffsetUtf16: 0
    });
    afterEditor.rerenderEditor({
      draft: { title: "B", note: "support", imageOffsetUtf16: 0 }
    });
    expect(
      afterEditor.host.querySelector('[data-image-atom-region="before"]')
    ).toHaveAttribute("data-image-atom-empty", "true");
    expect(
      afterEditor.host.querySelector('[data-image-atom-region="after"]')
    ).not.toHaveAttribute("data-image-atom-empty");

    act(() =>
      afterEditor.handle.current!.restoreSelection({
        anchorUtf16: 2,
        focusUtf16: 2
      })
    );
    beforeInput(afterEditor.host, "deleteContentBackward");
    expect(afterEditor.onDraftChange).toHaveBeenLastCalledWith({
      title: "",
      note: "support",
      imageOffsetUtf16: 0
    });
    afterEditor.rerenderEditor({
      draft: { title: "", note: "support", imageOffsetUtf16: 0 }
    });
    expect(
      afterEditor.host.querySelector('[data-image-atom-region="after"]')
    ).toHaveAttribute("data-image-atom-empty", "true");
    expect(afterEditor.onEnter).not.toHaveBeenCalled();
  });

  it("routes atom-adjacent deletion and atom-containing range deletion structurally", () => {
    const onAtomDelete = vi.fn();
    const { host, handle } = renderEditor({ onAtomDelete });

    act(() => handle.current!.restoreSelection({ anchorUtf16: 6, focusUtf16: 6 }));
    beforeInput(host, "deleteContentForward");
    act(() => handle.current!.restoreSelection({ anchorUtf16: 7, focusUtf16: 7 }));
    beforeInput(host, "deleteContentBackward");
    act(() => handle.current!.restoreSelection({ anchorUtf16: 5, focusUtf16: 8 }));
    beforeInput(host, "deleteContentBackward");

    expect(onAtomDelete).toHaveBeenNthCalledWith(1, "forward");
    expect(onAtomDelete).toHaveBeenNthCalledWith(2, "backward");
    expect(onAtomDelete).toHaveBeenNthCalledWith(3, "selection");
  });

  it("deletes one Unicode scalar from ordinary collapsed text carets", () => {
    const beforeEditor = renderEditor({
      draft: { title: "😀after", note: "support", imageOffsetUtf16: 2 }
    });
    act(() => beforeEditor.handle.current!.restoreSelection({ anchorUtf16: 0, focusUtf16: 0 }));
    beforeInput(beforeEditor.host, "deleteContentForward");
    expect(beforeEditor.onDraftChange).toHaveBeenLastCalledWith({
      title: "after",
      note: "support",
      imageOffsetUtf16: 0
    });
    beforeEditor.unmount();

    const afterEditor = renderEditor({
      draft: { title: "before😀after", note: "support", imageOffsetUtf16: 6 }
    });
    act(() => afterEditor.handle.current!.restoreSelection({ anchorUtf16: 9, focusUtf16: 9 }));
    beforeInput(afterEditor.host, "deleteContentBackward");
    expect(afterEditor.onDraftChange).toHaveBeenLastCalledWith({
      title: "beforeafter",
      note: "support",
      imageOffsetUtf16: 6
    });
  });

  it("publishes a normalized selection through its flush adapter only after deferred composition settles", async () => {
    let adapter: {
      flush(): Promise<"flushed" | "deferred" | "cancelled">;
      flushAndGetSelection?(): Promise<LogicalSelection | null>;
    } | null = null;
    const { host } = renderEditor({
      registerFlushAdapter: (registered) => {
        adapter = registered;
        return () => undefined;
      }
    });
    expect(adapter).not.toBeNull();
    expect(adapter).not.toHaveProperty("selection");
    selection(host, 2, 5);

    fireEvent.compositionStart(host);
    let settled = false;
    const selectionAfterFlush = adapter!.flushAndGetSelection!().then((value) => {
      settled = true;
      return value;
    });
    await Promise.resolve();
    expect(settled).toBe(false);
    fireEvent.compositionEnd(host);

    await expect(selectionAfterFlush).resolves.toEqual({
      anchorUtf16: 2,
      focusUtf16: 5
    });
  });

  it("fails closed for adapter selection after unmount or host disconnection", async () => {
    let adapter: {
      flushAndGetSelection?(): Promise<LogicalSelection | null>;
    } | null = null;
    const connected = renderEditor({
      registerFlushAdapter: (registered) => {
        adapter = registered;
        return () => undefined;
      }
    });
    selection(connected.host, 2, 2);
    Object.defineProperty(connected.host, "isConnected", {
      configurable: true,
      value: false
    });
    await expect(adapter!.flushAndGetSelection!()).resolves.toBeNull();
    connected.unmount();

    let unmountedAdapter: {
      flushAndGetSelection?(): Promise<LogicalSelection | null>;
    } | null = null;
    const mounted = renderEditor({
      registerFlushAdapter: (registered) => {
        unmountedAdapter = registered;
        return () => undefined;
      }
    });
    mounted.unmount();
    await expect(unmountedAdapter!.flushAndGetSelection!()).resolves.toBeNull();
  });

  it("does not create a new draft revision when a non-composition flush is unchanged", async () => {
    const { handle, onDraftChange } = renderEditor();

    await expect(handle.current!.flush()).resolves.toBe("flushed");

    expect(onDraftChange).not.toHaveBeenCalled();
  });

  it("keeps Korean IME DOM browser-owned and commits the final mapped value once", async () => {
    const { host, onDraftChange } = renderEditor();
    const before = host.querySelector<HTMLElement>("[data-image-atom-region=before]")!;

    fireEvent.compositionStart(host);
    before.textContent = "ㅎ";
    before.textContent = "하";
    before.textContent = "한";
    expect(onDraftChange).not.toHaveBeenCalled();

    fireEvent.compositionEnd(host);
    await waitFor(() =>
      expect(onDraftChange).toHaveBeenCalledWith({
        title: "한after",
        note: "support",
        imageOffsetUtf16: 1
      })
    );
    expect(onDraftChange).toHaveBeenCalledTimes(1);
  });

  it.each([
    {
      side: "before",
      offset: 0,
      expected: { title: "한", note: "support", imageOffsetUtf16: 1 }
    },
    {
      side: "after",
      offset: 1,
      expected: { title: "한", note: "support", imageOffsetUtf16: 0 }
    }
  ] as const)(
    "materializes the empty $side edge and commits Korean IME text once",
    async ({ side, offset, expected }) => {
      const { host, handle, onDraftChange } = renderEditor({
        draft: { title: "", note: "support", imageOffsetUtf16: 0 }
      });
      const region = host.querySelector<HTMLElement>(
        `[data-image-atom-region="${side}"]`
      )!;
      const otherSide = side === "before" ? "after" : "before";
      const otherRegion = host.querySelector<HTMLElement>(
        `[data-image-atom-region="${otherSide}"]`
      )!;

      host.focus();
      act(() =>
        handle.current!.restoreSelection({
          anchorUtf16: offset,
          focusUtf16: offset
        })
      );
      fireEvent.compositionStart(host);

      expect(region).not.toHaveAttribute("data-image-atom-empty");
      expect(otherRegion).toHaveAttribute("data-image-atom-empty", "true");

      const caretAid = region.querySelector<HTMLElement>(
        "[data-image-atom-caret-aid]"
      )!;
      let composingText: Text;
      if (caretAid.firstChild?.nodeType === Node.TEXT_NODE) {
        composingText = caretAid.firstChild as Text;
        composingText.data = "한";
      } else {
        composingText = document.createTextNode("한");
        caretAid.replaceWith(composingText);
      }
      document.getSelection()!.setBaseAndExtent(
        composingText,
        composingText.length,
        composingText,
        composingText.length
      );
      fireEvent.compositionEnd(host, { data: "한" });

      await waitFor(() => expect(onDraftChange).toHaveBeenCalledOnce());
      expect(onDraftChange).toHaveBeenCalledWith(expected);
      expect(host).toHaveAttribute("data-image-atom-editing", "true");
    }
  );

  it("restores both empty edge markers when Korean composition ends without text", async () => {
    const { host, handle, onDraftChange } = renderEditor({
      draft: { title: "", note: "support", imageOffsetUtf16: 0 }
    });
    const before = host.querySelector<HTMLElement>(
      '[data-image-atom-region="before"]'
    )!;
    act(() =>
      handle.current!.restoreSelection({ anchorUtf16: 0, focusUtf16: 0 })
    );
    fireEvent.compositionStart(host);
    expect(before).not.toHaveAttribute("data-image-atom-empty");

    fireEvent.compositionEnd(host, { data: "" });

    await waitFor(() => {
      expect(
        host.querySelector('[data-image-atom-region="before"]')
      ).toHaveAttribute("data-image-atom-empty", "true");
      expect(
        host.querySelector('[data-image-atom-region="after"]')
      ).toHaveAttribute("data-image-atom-empty", "true");
    });
    expect(onDraftChange).not.toHaveBeenCalled();
  });

  it.each(["before", "after"] as const)(
    "recovers the final Korean text when WebKit replaces the empty %s region",
    async (side) => {
      const { host, handle, onDraftChange } = renderEditor({
        draft: { title: "", note: "support", imageOffsetUtf16: 0 }
      });
      const before = host.querySelector<HTMLElement>(
        '[data-image-atom-region="before"]'
      )!;
      const atom = host.querySelector<HTMLElement>(
        '[data-image-atom-region="atom"]'
      )!;
      const after = host.querySelector<HTMLElement>(
        '[data-image-atom-region="after"]'
      )!;
      const offset = side === "before" ? 0 : 1;

      act(() =>
        handle.current!.restoreSelection({
          anchorUtf16: offset,
          focusUtf16: offset
        })
      );
      fireEvent.compositionStart(host);

      const carrier = document.createElement("span");
      carrier.style.whiteSpaceCollapse = "preserve";
      const text = document.createTextNode("한글");
      carrier.append(text);
      const browserBreak = document.createElement("br");
      if (side === "before") {
        before.remove();
        host.insertBefore(carrier, atom);
        host.insertBefore(browserBreak, atom);
      } else {
        after.remove();
        host.append(browserBreak, carrier);
      }
      document.getSelection()!.setBaseAndExtent(text, 2, text, 2);

      fireEvent.compositionEnd(host, { data: "글" });

      await waitFor(() => expect(onDraftChange).toHaveBeenCalledOnce());
      expect(onDraftChange).toHaveBeenCalledWith({
        title: "한글",
        note: "support",
        imageOffsetUtf16: side === "before" ? 2 : 0
      });
    }
  );

  it("keeps WebKit's displaced carrier across chained Korean syllables", async () => {
    const { host, handle, onDraftChange } = renderEditor({
      draft: { title: "", note: "support", imageOffsetUtf16: 0 }
    });
    const atom = host.querySelector<HTMLElement>(
      '[data-image-atom-region="atom"]'
    )!;
    const after = host.querySelector<HTMLElement>(
      '[data-image-atom-region="after"]'
    )!;
    act(() =>
      handle.current!.restoreSelection({ anchorUtf16: 1, focusUtf16: 1 })
    );
    fireEvent.compositionStart(host);

    const carrier = document.createElement("span");
    const text = document.createTextNode("한");
    carrier.append(text);
    after.remove();
    host.append(document.createElement("br"), carrier);
    document.getSelection()!.setBaseAndExtent(text, 1, text, 1);

    act(() => {
      fireEvent.compositionEnd(host, { data: "한" });
      expect(carrier.isConnected).toBe(true);
      fireEvent.compositionStart(host);
      text.data = "한글";
      document.getSelection()!.setBaseAndExtent(text, 2, text, 2);
      fireEvent.compositionEnd(host, { data: "글" });
    });

    await waitFor(() => expect(onDraftChange).toHaveBeenCalledTimes(2));
    expect(onDraftChange).toHaveBeenCalledWith({
      title: "한",
      note: "support",
      imageOffsetUtf16: 0
    });
    expect(onDraftChange).toHaveBeenLastCalledWith({
      title: "한글",
      note: "support",
      imageOffsetUtf16: 0
    });
    expect([...host.children].map((element) => element.getAttribute(
      "data-image-atom-region"
    ))).toEqual(["before", "atom", "after"]);
    expect(atom.parentElement).toBe(host);
  });

  it("freezes the controlled projection across an external rerender during composition", () => {
    const editor = renderEditor();
    const raw = editor.host.querySelector<HTMLElement>(
      "[data-image-atom-region=before] [data-image-atom-raw]"
    )!;

    fireEvent.compositionStart(editor.host);
    (raw.firstChild as Text).data = "ㅎ";
    editor.rerenderEditor({
      draft: { title: "externalafter", note: "support", imageOffsetUtf16: 8 }
    });
    expect(raw).toHaveTextContent("ㅎ");
    (raw.firstChild as Text).data = "한";
    fireEvent.compositionEnd(editor.host);

    expect(editor.onDraftChange).toHaveBeenCalledOnce();
    expect(editor.onDraftChange).toHaveBeenCalledWith({
      title: "한after",
      note: "support",
      imageOffsetUtf16: 1
    });
  });

  it("repairs composition-owned structure and restores its final selection", async () => {
    const { host, onDraftChange } = renderEditor();
    const before = host.querySelector<HTMLElement>("[data-image-atom-region=before]")!;

    fireEvent.compositionStart(host);
    before.innerHTML = "<b>한</b>";
    const text = before.querySelector("b")!.firstChild!;
    document.getSelection()!.setBaseAndExtent(text, 1, text, 1);
    fireEvent.compositionEnd(host);

    await waitFor(() => {
      expect(host.querySelectorAll("[data-image-atom-overlay]")).toHaveLength(2);
      expect(host.querySelector("[data-image-atom-region=before] b")).toBeNull();
    });
    expect(host.querySelectorAll("[data-image-atom-caret-aid]")).toHaveLength(0);
    beforeInput(host, "insertText", "X");
    expect(onDraftChange).toHaveBeenLastCalledWith({
      title: "한Xafter",
      note: "support",
      imageOffsetUtf16: 2
    });
  });

  it("cancels only the waiting flush when a mounted composition watchdog expires", async () => {
    vi.useFakeTimers();
    try {
      const { host, handle, onDraftChange } = renderEditor();
      const raw = host.querySelector<HTMLElement>(
        "[data-image-atom-region=before] [data-image-atom-raw]"
      )!;
      fireEvent.compositionStart(host);
      (raw.firstChild as Text).data = "한";
      const waiting = handle.current!.flush();
      const waitingSelection = handle.current!.flushAndGetSelection();

      await act(async () => vi.advanceTimersByTimeAsync(1_000));

      await expect(waiting).resolves.toBe("cancelled");
      await expect(waitingSelection).resolves.toBeNull();
      expect(raw).toHaveTextContent("한");
      expect(onDraftChange).not.toHaveBeenCalled();
      await expect(handle.current!.flush()).resolves.toBe("cancelled");

      fireEvent.compositionEnd(host);
      expect(onDraftChange).toHaveBeenCalledOnce();
      expect(onDraftChange).toHaveBeenCalledWith({
        title: "한after",
        note: "support",
        imageOffsetUtf16: 1
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not reset a browser-owned composition mutation before compositionend", async () => {
    const nonEmptyEditor = renderEditor();
    const { host } = nonEmptyEditor;
    const before = host.querySelector<HTMLElement>("[data-image-atom-region=before]")!;

    fireEvent.compositionStart(host);
    before.textContent = "한";
    await Promise.resolve();
    expect(before).toHaveTextContent("한");
    fireEvent.compositionEnd(host);
  });

  it("does not steal focus back after composition ends following a blur", () => {
    const { host } = renderEditor();
    const external = document.createElement("button");
    document.body.append(external);

    fireEvent.compositionStart(host);
    external.focus();
    fireEvent.compositionEnd(host);

    expect(external).toHaveFocus();
    external.remove();
  });

  it("flushes the final composition once after a deferred blur", async () => {
    const { host, handle, onDraftChange } = renderEditor();
    const before = host.querySelector<HTMLElement>("[data-image-atom-region=before]")!;

    fireEvent.compositionStart(host);
    before.textContent = "한";
    let settled = false;
    const completion = handle.current!.flush().then((result) => {
      settled = true;
      return result;
    });
    await Promise.resolve();
    expect(settled).toBe(false);
    fireEvent.blur(host);
    fireEvent.compositionEnd(host);
    await expect(completion).resolves.toBe("deferred");
    await waitFor(() => expect(onDraftChange).toHaveBeenCalledTimes(1));
    expect(onDraftChange).toHaveBeenLastCalledWith({
      title: "한after",
      note: "support",
      imageOffsetUtf16: 1
    });
  });

  it("coalesces concurrent composition flush waiters after one final mapping", async () => {
    const { host, handle, onDraftChange } = renderEditor();
    const before = host.querySelector<HTMLElement>("[data-image-atom-region=before]")!;

    fireEvent.compositionStart(host);
    before.textContent = "한";
    const first = handle.current!.flush();
    const second = handle.current!.flush();
    fireEvent.compositionEnd(host);

    await expect(Promise.all([first, second])).resolves.toEqual(["deferred", "deferred"]);
    expect(onDraftChange).toHaveBeenCalledTimes(1);
  });

  it("keeps tags and dates segment-local while reporting after-segment raw offsets", () => {
    const onTagClick = vi.fn();
    const onDateClick = vi.fn();
    const { host } = renderEditor({
      draft: { title: "before#after today", note: "support", imageOffsetUtf16: 6 },
      onTagClick,
      onDateClick,
      today: { year: 2026, month: 7, day: 18 }
    });
    const overlay = host.querySelector<HTMLElement>("[data-image-atom-region=after] [data-image-atom-overlay]")!;
    const tag = overlay.querySelector<HTMLButtonElement>(".notes-tag-token")!;
    const date = overlay.querySelector<HTMLButtonElement>(".notes-date-token")!;

    fireEvent.click(tag);
    fireEvent.click(date);

    expect(onTagClick).toHaveBeenCalledWith(expect.objectContaining({
      raw: "#after",
      startUtf16: 6,
      endUtf16: 12
    }));
    expect(onDateClick).toHaveBeenCalledWith(expect.objectContaining({
      raw: "today",
      startUtf16: 13,
      endUtf16: 18
    }), date);
  });

  it("does not trigger a date when the two bangs straddle the atom", () => {
    const onDateTrigger = vi.fn();
    const { host, handle } = renderEditor({
      draft: { title: "before!after", note: "support", imageOffsetUtf16: 7 },
      onDateTrigger
    });
    act(() => handle.current!.restoreSelection({ anchorUtf16: 8, focusUtf16: 8 }));

    beforeInput(host, "insertText", "!");

    expect(onDateTrigger).not.toHaveBeenCalled();
  });

  it("passes the just-edited full title to a typed-date trigger", () => {
    const onDateTrigger = vi.fn();
    const { host, handle } = renderEditor({
      draft: { title: "before!after", note: "support", imageOffsetUtf16: 6 },
      onDateTrigger
    });
    act(() => handle.current!.restoreSelection({ anchorUtf16: 8, focusUtf16: 8 }));

    beforeInput(host, "insertText", "!");

    expect(onDateTrigger).toHaveBeenCalledWith(
      { startUtf16: 6, endUtf16: 8 },
      host,
      "before!!after"
    );
  });

  it("formats before and after segments independently and rejects a cross-atom format range", () => {
    const beforeEditor = renderEditor();
    act(() => beforeEditor.handle.current!.restoreSelection({ anchorUtf16: 1, focusUtf16: 3 }));
    fireEvent.keyDown(beforeEditor.host, { key: "b", metaKey: true });
    expect(beforeEditor.onDraftChange).toHaveBeenLastCalledWith({
      title: "b**ef**oreafter",
      note: "support",
      imageOffsetUtf16: 10
    });
    beforeEditor.unmount();

    const afterEditor = renderEditor();
    act(() => afterEditor.handle.current!.restoreSelection({ anchorUtf16: 8, focusUtf16: 10 }));
    fireEvent.keyDown(afterEditor.host, { key: "b", metaKey: true });
    expect(afterEditor.onDraftChange).toHaveBeenLastCalledWith({
      title: "beforea**ft**er",
      note: "support",
      imageOffsetUtf16: 6
    });
    afterEditor.unmount();

    const crossEditor = renderEditor();
    act(() => crossEditor.handle.current!.restoreSelection({ anchorUtf16: 5, focusUtf16: 8 }));
    expect(fireEvent.keyDown(crossEditor.host, { key: "b", metaKey: true })).toBe(false);
    expect(crossEditor.onDraftChange).not.toHaveBeenCalled();
  });

  it("does not split a surrogate pair while extending a selection with Shift+Arrow", () => {
    const { host, handle, onDraftChange } = renderEditor({
      draft: { title: "😀after", note: "support", imageOffsetUtf16: 2 }
    });
    act(() => handle.current!.restoreSelection({ anchorUtf16: 2, focusUtf16: 2 }));
    fireEvent.keyDown(host, { key: "ArrowLeft", shiftKey: true });
    beforeInput(host, "insertText", "X");

    expect(onDraftChange).toHaveBeenLastCalledWith({
      title: "Xafter",
      note: "support",
      imageOffsetUtf16: 1
    });
  });

  it("cancels a pending structural composition flush after unmount without scraping DOM", async () => {
    const { host, handle, unmount, onDraftChange } = renderEditor();

    fireEvent.compositionStart(host);
    const waiting = handle.current!.flush();
    const waitingSelection = handle.current!.flushAndGetSelection();
    unmount();

    await expect(waiting).resolves.toBe("cancelled");
    await expect(waitingSelection).resolves.toBeNull();
    expect(onDraftChange).not.toHaveBeenCalled();
  });

  it("repairs unexpected non-composition DOM mutations without losing overlays or empty caret aids", async () => {
    const nonEmptyEditor = renderEditor();
    const { host } = nonEmptyEditor;
    const before = host.querySelector<HTMLElement>("[data-image-atom-region=before]")!;

    before.textContent = "tampered";

    await waitFor(() =>
      expect(
        host.querySelector<HTMLElement>("[data-image-atom-region=before] [data-image-atom-raw]")
      ).toHaveTextContent("before")
    );
    expect(host.querySelectorAll("[data-image-atom-overlay]")).toHaveLength(2);
    nonEmptyEditor.unmount();

    const emptyEditor = renderEditor({
      draft: { title: "", note: "support", imageOffsetUtf16: 0 }
    });
    emptyEditor.host.querySelector<HTMLElement>("[data-image-atom-region=before]")!.textContent = "tampered";
    await waitFor(() =>
      expect(emptyEditor.host.querySelectorAll("[data-image-atom-caret-aid]")).toHaveLength(2)
    );
    expect(emptyEditor.host.querySelectorAll("[data-image-atom-overlay]")).toHaveLength(2);
  });

  it("applies an authoritative draft that arrives during mutation repair", async () => {
    const editor = renderEditor();
    const raw = editor.host.querySelector<HTMLElement>(
      "[data-image-atom-region=before] [data-image-atom-raw]"
    )!;
    let rerendered = false;
    const concurrentRerender = new MutationObserver(() => {
      if (rerendered) return;
      rerendered = true;
      concurrentRerender.disconnect();
      editor.rerenderEditor({
        draft: { title: "serverafter", note: "server note", imageOffsetUtf16: 6 }
      });
    });
    concurrentRerender.observe(raw, { childList: true, subtree: true });

    raw.innerHTML = "<b>before</b>";

    await waitFor(() =>
      expect(
        editor.host.querySelector(
          "[data-image-atom-region=before] [data-image-atom-raw]"
        )
      ).toHaveTextContent("server")
    );
    expect(
      editor.host.querySelector("[data-image-atom-region=after] [data-image-atom-raw]")
    ).toHaveTextContent("after");
    expect(editor.onDraftChange).not.toHaveBeenCalled();
  });
});
