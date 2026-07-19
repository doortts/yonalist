import {
  forwardRef,
  type ClipboardEvent,
  type CompositionEvent,
  type DragEvent,
  type KeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type Ref,
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState
} from "react";
import type { NoteAttachment, NoteId, NoteNode } from "../../domain/notes";
import { NotesImageNodeContent } from "./NotesImageAttachment";
import {
  applyImageLogicalTextEdit,
  imageLogicalLength,
  joinImagePrimary,
  logicalToRawOffset,
  normalizeLogicalSelection,
  type ImagePrimaryValue,
  type LogicalSelection,
  validateImagePrimary
} from "./imageAtomModel";
import {
  IMAGE_ATOM_CARET_AID_ATTRIBUTE,
  IMAGE_ATOM_OVERLAY_ATTRIBUTE,
  imageAtomLogicalOffsetFromDomPoint,
  readImageAtomDomSelection,
  type ImageAtomDomRegions,
  writeImageAtomDomSelection
} from "./imageAtomDomSelection";
import {
  type ActiveImageAtomEditor,
  type ImageAtomEditorSelectionAuthority,
  type ImageAtomEditorSelectionSnapshot,
  type ImageAtomEditorFlushResult,
  type NotesImageAtomFlushAdapter
} from "./notesImageAtomEditorRegistry";
import { resolveInlineFormatShortcut, toggleInlineFormat } from "./inlineFormat";
import { NoteTokenText } from "./NoteTokenText";
import type { LocalDate, NoteDateMatch } from "./noteDates";
import type { NoteTagToken } from "./noteTokens";

export interface ImageAtomEditorHandle {
  focus(selection?: LogicalSelection): boolean;
  restoreSelection(selection: LogicalSelection): boolean;
  flush(): Promise<ImageAtomEditorFlushResult>;
  flushAndGetSelection(): Promise<LogicalSelection | null>;
  flushAndGetSelectionSnapshot(): Promise<ImageAtomEditorSelectionSnapshot | null>;
  containsAtomSelection(): boolean;
}

export interface ImageAtomEditorProps {
  readonly nodeId: NoteId;
  readonly draft: Pick<NoteNode, "title" | "note" | "imageOffsetUtf16">;
  readonly attachment: NoteAttachment;
  readonly onDraftChange: (
    draft: Pick<NoteNode, "title" | "note" | "imageOffsetUtf16">
  ) => void;
  readonly registerFlushAdapter?: (adapter: NotesImageAtomFlushAdapter) => () => void;
  readonly registerActiveEditor?: (
    editor: ActiveImageAtomEditor
  ) => () => void;
  readonly onEnter?: () => void;
  readonly onSupportingNote?: () => void;
  readonly onAtomDelete?: (kind: "forward" | "backward" | "selection") => void;
  readonly onUnhandledKeyDown?: (event: KeyboardEvent<HTMLDivElement>) => void;
  readonly onUndo?: () => void;
  readonly onRedo?: () => void;
  readonly onPaste?: (event: ClipboardEvent<HTMLDivElement>) => boolean;
  readonly onImageAtomPaste?: (event: globalThis.ClipboardEvent) => boolean;
  readonly onDrop?: (event: DragEvent<HTMLDivElement>) => boolean;
  readonly onTagClick?: (token: NoteTagToken) => void;
  readonly onDateClick?: (token: NoteDateMatch, anchor: HTMLButtonElement) => void;
  readonly onDateTrigger?: (
    range: { readonly startUtf16: number; readonly endUtf16: number },
    anchor: HTMLDivElement,
    source: string
  ) => void;
  readonly isTagActive?: (token: NoteTagToken) => boolean;
  readonly today?: LocalDate;
  readonly contentRef?: Ref<HTMLDivElement>;
  readonly readOnly?: boolean;
  readonly disabled?: boolean;
  readonly className?: string;
  readonly ariaLabel?: string;
  readonly onRemoveImage?: () => void;
}

type CompositionWaiter = (result: ImageAtomEditorFlushResult) => void;

const COMPOSITION_FLUSH_WATCHDOG_MS = 1_000;

function setRef<T>(ref: Ref<T> | undefined, value: T | null): void {
  if (typeof ref === "function") {
    ref(value);
  } else if (ref) {
    ref.current = value;
  }
}

function editableRegionText(region: HTMLElement | null): string {
  if (!region) return "";
  const text: string[] = [];
  const walker = document.createTreeWalker(region, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    let ignored = false;
    for (
      let parent = (node as Text).parentElement;
      parent && parent !== region;
      parent = parent.parentElement
    ) {
      if (
        parent.hasAttribute(IMAGE_ATOM_CARET_AID_ATTRIBUTE) ||
        parent.hasAttribute(IMAGE_ATOM_OVERLAY_ATTRIBUTE)
      ) {
        ignored = true;
        break;
      }
    }
    if (!ignored) text.push((node as Text).data);
  }
  return text.join("");
}

function hasControlledRegionStructure(
  region: HTMLElement,
  expectedText: string
): boolean {
  const raw = region.querySelector<HTMLElement>(":scope > [data-image-atom-raw]");
  const overlay = region.querySelector<HTMLElement>(
    ":scope > [data-image-atom-overlay-container]"
  );
  if (
    !raw ||
    !overlay ||
    region.children.length !== 2 ||
    !hasControlledOverlayStructure(overlay, expectedText)
  ) {
    return false;
  }
  return expectedText.length > 0
    ? raw.childNodes.length === 1 && raw.firstChild?.nodeType === Node.TEXT_NODE
    : raw.childNodes.length === 1 &&
        raw.firstElementChild?.hasAttribute(IMAGE_ATOM_CARET_AID_ATTRIBUTE) === true;
}

function hasOnlyTextChildren(element: Element): boolean {
  return [...element.childNodes].every((child) => child.nodeType === Node.TEXT_NODE);
}

function hasControlledOverlayStructure(
  container: HTMLElement,
  expectedText: string
): boolean {
  if (container.childNodes.length !== 1) return false;
  const root = container.firstElementChild;
  if (
    !root?.matches("span.notes-token-text[data-image-atom-overlay]") ||
    root.textContent !== expectedText
  ) {
    return false;
  }
  return [...root.childNodes].every((child) => {
    if (child.nodeType === Node.TEXT_NODE) return true;
    if (!(child instanceof Element)) return false;
    if (
      child.matches(
        "button.notes-tag-token, button.notes-date-token, button.notes-url-token, span.notes-date-token"
      )
    ) {
      return hasOnlyTextChildren(child);
    }
    if (!child.matches("span.notes-format-token")) return false;
    const parts = [...child.children];
    return (
      child.childNodes.length === 3 &&
      parts.length === 3 &&
      parts[0]?.matches("span.notes-format-marker") === true &&
      parts[1]?.matches("span.notes-format-content") === true &&
      parts[2]?.matches("span.notes-format-marker") === true &&
      parts.every(hasOnlyTextChildren)
    );
  });
}

function isAtomSelection(value: ImagePrimaryValue, selection: LogicalSelection): boolean {
  const start = Math.min(selection.anchorUtf16, selection.focusUtf16);
  const end = Math.max(selection.anchorUtf16, selection.focusUtf16);
  return start <= value.imageOffsetUtf16 && end > value.imageOffsetUtf16;
}

type ImageAtomSelectionUi = {
  readonly atomSelected: boolean;
  readonly caretSide: "before" | "after" | null;
};

function imageAtomSelectionUi(
  value: ImagePrimaryValue,
  selection: LogicalSelection | null,
  beforeEmpty: boolean,
  afterEmpty: boolean
): ImageAtomSelectionUi {
  if (!selection) return { atomSelected: false, caretSide: null };
  const collapsed = selection.anchorUtf16 === selection.focusUtf16;
  return {
    atomSelected: isAtomSelection(value, selection),
    caretSide:
      collapsed &&
      beforeEmpty &&
      selection.focusUtf16 === value.imageOffsetUtf16
        ? "before"
        : collapsed &&
            afterEmpty &&
            selection.focusUtf16 === value.imageOffsetUtf16 + 1
          ? "after"
          : null
  };
}

function isExactAtomSelection(
  value: ImagePrimaryValue,
  selection: LogicalSelection
): boolean {
  const beforeAtom = value.imageOffsetUtf16;
  const afterAtom = beforeAtom + 1;
  return (
    (selection.anchorUtf16 === beforeAtom && selection.focusUtf16 === afterAtom) ||
    (selection.anchorUtf16 === afterAtom && selection.focusUtf16 === beforeAtom)
  );
}

function isNestedImageControl(
  target: EventTarget | null,
  imageContent: HTMLElement | null
): boolean {
  if (!(target instanceof Element) || !imageContent?.contains(target)) {
    return false;
  }
  const interactive = target.closest(
    "button, a[href], input, select, textarea, [role=button], [role=separator], [tabindex]:not([tabindex='-1']), [contenteditable=true], [data-image-atom-interactive]"
  );
  // The image content root itself is focusable for keyboard entry, but its
  // non-control body remains the atom's pointer selection surface.
  return interactive !== null && interactive !== imageContent;
}

type CaretDocument = Document & {
  caretPositionFromPoint?: (
    x: number,
    y: number
  ) => { readonly offsetNode: Node; readonly offset: number } | null;
  caretRangeFromPoint?: (x: number, y: number) => Range | null;
};

function logicalOffsetFromClientPoint(
  regions: ImageAtomDomRegions,
  clientX: number,
  clientY: number,
  fallback: number
): number {
  const caretDocument = regions.host.ownerDocument as CaretDocument;
  const position = caretDocument.caretPositionFromPoint?.(clientX, clientY);
  const range = position ? null : caretDocument.caretRangeFromPoint?.(clientX, clientY);
  const node = position?.offsetNode ?? range?.startContainer;
  const offset = position?.offset ?? range?.startOffset;
  return node && offset !== undefined
    ? imageAtomLogicalOffsetFromDomPoint(regions, node, offset)
    : fallback;
}

function nextArrowSelection(
  value: ImagePrimaryValue,
  current: LogicalSelection,
  key: "ArrowLeft" | "ArrowRight",
  extend: boolean
): LogicalSelection | null {
  const selection = normalizeLogicalSelection(value, current);
  const direction = key === "ArrowLeft" ? -1 : 1;
  if (extend) {
    return {
      anchorUtf16: selection.anchorUtf16,
      focusUtf16: stepLogicalOffset(value, selection.focusUtf16, direction)
    };
  }
  if (selection.anchorUtf16 !== selection.focusUtf16) {
    const boundary = direction < 0
      ? Math.min(selection.anchorUtf16, selection.focusUtf16)
      : Math.max(selection.anchorUtf16, selection.focusUtf16);
    return { anchorUtf16: boundary, focusUtf16: boundary };
  }
  const atBeforeAtom = selection.focusUtf16 === value.imageOffsetUtf16;
  const atAfterAtom = selection.focusUtf16 === value.imageOffsetUtf16 + 1;
  if ((direction > 0 && atBeforeAtom) || (direction < 0 && atAfterAtom)) {
    const offset = selection.focusUtf16 + direction;
    return { anchorUtf16: offset, focusUtf16: offset };
  }
  return null;
}

function stepLogicalOffset(
  value: ImagePrimaryValue,
  offset: number,
  direction: -1 | 1
): number {
  const logical = Math.max(0, Math.min(imageLogicalLength(value), offset));
  if (direction > 0 && logical === value.imageOffsetUtf16) return logical + 1;
  if (direction < 0 && logical === value.imageOffsetUtf16 + 1) return logical - 1;
  const raw = logical <= value.imageOffsetUtf16 ? logical : logical - 1;
  let nextRaw = Math.max(0, Math.min(value.title.length, raw + direction));
  if (
    nextRaw > 0 &&
    nextRaw < value.title.length &&
    value.title.charCodeAt(nextRaw - 1) >= 0xd800 &&
    value.title.charCodeAt(nextRaw - 1) <= 0xdbff &&
    value.title.charCodeAt(nextRaw) >= 0xdc00 &&
    value.title.charCodeAt(nextRaw) <= 0xdfff
  ) {
    nextRaw += direction;
  }
  nextRaw = Math.max(0, Math.min(value.title.length, nextRaw));
  // Raw offset `imageOffsetUtf16` has two logical neighbours: before the atom
  // and after it. A scalar deletion/extension that remains inside the after
  // segment must land on the after-side boundary rather than accidentally
  // crossing the atom.
  if (
    nextRaw === value.imageOffsetUtf16 &&
    logical > value.imageOffsetUtf16 + 1
  ) {
    return value.imageOffsetUtf16 + 1;
  }
  return nextRaw <= value.imageOffsetUtf16 ? nextRaw : nextRaw + 1;
}

export const ImageAtomEditor = forwardRef<ImageAtomEditorHandle, ImageAtomEditorProps>(
  function ImageAtomEditor(
    {
      nodeId,
      draft,
      attachment,
      onDraftChange,
      registerFlushAdapter,
      registerActiveEditor,
      onEnter,
      onSupportingNote,
      onAtomDelete,
      onUnhandledKeyDown,
      onUndo,
      onRedo,
      onPaste,
      onImageAtomPaste,
      onDrop,
      onTagClick = () => undefined,
      onDateClick,
      onDateTrigger,
      isTagActive,
      today,
      contentRef,
      readOnly = false,
      disabled = false,
      className,
      ariaLabel = "Image note",
      onRemoveImage
    },
    forwardedRef
  ) {
    const hostRef = useRef<HTMLDivElement | null>(null);
    const beforeRef = useRef<HTMLSpanElement | null>(null);
    const atomRef = useRef<HTMLSpanElement | null>(null);
    const afterRef = useRef<HTMLSpanElement | null>(null);
    const atomContentRef = useRef<HTMLDivElement | null>(null);
    const imageGroupSelectionRef = useRef<LogicalSelection | null>(null);
    const composingRef = useRef(false);
    const unmountedRef = useRef(false);
    const compositionProjectionRef = useRef<ImagePrimaryValue | null>(null);
    const compositionInterruptedRef = useRef(false);
    const compositionWatchdogRef = useRef<number | null>(null);
    const compositionWaitersRef = useRef<CompositionWaiter[]>([]);
    const valueRef = useRef<ImagePrimaryValue>({
      title: draft.title,
      imageOffsetUtf16: draft.imageOffsetUtf16
    });
    const noteRef = useRef(draft.note);
    const appliedIncomingValueRef = useRef<ImagePrimaryValue>({
      title: draft.title,
      imageOffsetUtf16: draft.imageOffsetUtf16
    });
    const pendingIncomingValueRef = useRef<ImagePrimaryValue | null>(null);
    const onDraftChangeRef = useRef(onDraftChange);
    const onImageAtomPasteRef = useRef(onImageAtomPaste);
    const observerRef = useRef<MutationObserver | null>(null);
    const pointerAnchorRef = useRef<number | null>(null);
    const pointerActiveRef = useRef(false);
    const pointerDraggedRef = useRef(false);
    const pointerIdRef = useRef<number | null>(null);
    const selectionOwnerRef = useRef(Symbol("image-atom-selection-owner"));
    const selectionSignatureRef = useRef<string | null>(null);
    const selectionEpochRef = useRef(0);
    const selectionAuthorityRef = useRef<ImageAtomEditorSelectionAuthority>(
      { owner: selectionOwnerRef.current, epoch: 0 } as unknown as ImageAtomEditorSelectionAuthority
    );
    const projectionPendingRef = useRef(false);
    const projectionSelectionRef = useRef<LogicalSelection | null>(null);
    const [selectionUiState, setSelectionUiState] = useState<ImageAtomSelectionUi>({
      atomSelected: false,
      caretSide: null
    });
    const [editing, setEditing] = useState(false);
    const [projectionVersion, setProjectionVersion] = useState(0);

    const finishAtomPointerInteraction = (
      element: HTMLElement,
      dragged: boolean
    ) => {
      if (pointerIdRef.current !== null) {
        element.releasePointerCapture?.(pointerIdRef.current);
      }
      pointerActiveRef.current = false;
      pointerIdRef.current = null;
      pointerAnchorRef.current = null;
      pointerDraggedRef.current = dragged;
    };

    const incomingValue = {
      title: draft.title,
      imageOffsetUtf16: draft.imageOffsetUtf16
    };
    const incomingChanged =
      incomingValue.title !== appliedIncomingValueRef.current.title ||
      incomingValue.imageOffsetUtf16 !==
        appliedIncomingValueRef.current.imageOffsetUtf16;
    if (composingRef.current) {
      appliedIncomingValueRef.current = incomingValue;
      pendingIncomingValueRef.current = null;
    } else if (projectionPendingRef.current) {
      pendingIncomingValueRef.current = incomingChanged ? incomingValue : null;
    } else if (incomingChanged) {
      valueRef.current = incomingValue;
      appliedIncomingValueRef.current = incomingValue;
    }
    noteRef.current = draft.note;
    onDraftChangeRef.current = onDraftChange;
    onImageAtomPasteRef.current = onImageAtomPaste;
    const segments = validateImagePrimary(
      composingRef.current
        ? compositionProjectionRef.current ?? valueRef.current
        : valueRef.current
    );
    const unavailable = readOnly || disabled;

    const regions = useCallback(() => {
      const host = hostRef.current;
      const before = beforeRef.current;
      const atom = atomRef.current;
      const after = afterRef.current;
      return host && before && atom && after ? { host, before, atom, after } : null;
    }, []);

    const logicalSelection = useCallback((): LogicalSelection | null => {
      const currentRegions = regions();
      const selection = document.getSelection();
      return currentRegions && selection
        ? readImageAtomDomSelection(currentRegions, selection)
        : null;
    }, [regions]);

    const observeSemanticSelection = useCallback(
      (known?: LogicalSelection | null): LogicalSelection | null => {
        const selection = known === undefined ? logicalSelection() : known;
        const signature = selection
          ? `${selection.anchorUtf16}:${selection.focusUtf16}`
          : null;
        if (signature !== selectionSignatureRef.current) {
          selectionSignatureRef.current = signature;
          selectionEpochRef.current += 1;
          selectionAuthorityRef.current = {
            owner: selectionOwnerRef.current,
            epoch: selectionEpochRef.current
          } as unknown as ImageAtomEditorSelectionAuthority;
        }
        return selection;
      },
      [logicalSelection]
    );

    // Registry consumers may publish a selection only after their flush barrier
    // settles. Do not leak a DOM selection while IME composition, teardown, or
    // a disconnected host makes it stale; normalize the remaining selection
    // against the current controlled primary value before exposing it.
    const publishedSelection = useCallback((): LogicalSelection | null => {
      if (
        unmountedRef.current ||
        composingRef.current ||
        !hostRef.current?.isConnected
      ) {
        return null;
      }
      const selection = observeSemanticSelection();
      if (!selection) return null;
      try {
        return normalizeLogicalSelection(valueRef.current, selection);
      } catch {
        return null;
      }
    }, [observeSemanticSelection]);

    const restoreSelection = useCallback((selection: LogicalSelection): boolean => {
      const currentRegions = regions();
      const domSelection = document.getSelection();
      if (!currentRegions?.host.isConnected || !domSelection) return false;
      try {
        const normalized = normalizeLogicalSelection(valueRef.current, selection);
        writeImageAtomDomSelection(
          currentRegions,
          normalized,
          domSelection
        );
        observeSemanticSelection(normalized);
        return true;
      } catch {
        return false;
      }
    }, [observeSemanticSelection, regions]);

    const enterImageGroup = useCallback((selection: LogicalSelection): boolean => {
      const imageGroup = atomContentRef.current;
      if (!imageGroup?.isConnected) return false;
      imageGroupSelectionRef.current = selection;
      imageGroup.focus({ preventScroll: true });
      if (document.activeElement === imageGroup) return true;
      imageGroupSelectionRef.current = null;
      return false;
    }, []);

    const returnFromImageGroup = useCallback((): boolean => {
      if (unavailable) {
        imageGroupSelectionRef.current = null;
        return false;
      }
      const selection = imageGroupSelectionRef.current;
      const host = hostRef.current;
      if (
        !selection ||
        !isExactAtomSelection(valueRef.current, selection) ||
        !host?.isConnected
      ) {
        return false;
      }
      host.focus({ preventScroll: true });
      if (document.activeElement !== host || !restoreSelection(selection)) return false;
      imageGroupSelectionRef.current = null;
      return true;
    }, [restoreSelection, unavailable]);

    const forwardImageGroupKeyboardEvent = useCallback(
      (event: KeyboardEvent<HTMLDivElement>) => {
        atomContentRef.current?.dispatchEvent(
          new globalThis.KeyboardEvent("keydown", {
            key: event.key,
            code: event.code,
            altKey: event.altKey,
            ctrlKey: event.ctrlKey,
            metaKey: event.metaKey,
            shiftKey: event.shiftKey,
            bubbles: true,
            cancelable: true
          })
        );
      },
      []
    );

    const syncSelectionUi = useCallback(() => {
      const selection = observeSemanticSelection();
      const value = valueRef.current;
      const next = imageAtomSelectionUi(
        value,
        selection,
        value.imageOffsetUtf16 === 0,
        value.imageOffsetUtf16 === value.title.length
      );
      setSelectionUiState((current) =>
        current.atomSelected === next.atomSelected &&
        current.caretSide === next.caretSide
          ? current
          : next
      );
    }, [observeSemanticSelection]);

    useEffect(() => {
      document.addEventListener("selectionchange", syncSelectionUi);
      return () => document.removeEventListener("selectionchange", syncSelectionUi);
    }, [syncSelectionUi]);

    const publishDom = useCallback((selection?: LogicalSelection): void => {
      const currentRegions = regions();
      if (!currentRegions || composingRef.current) return;
      const next = joinImagePrimary({
        beforeText: editableRegionText(currentRegions.before),
        afterText: editableRegionText(currentRegions.after)
      });
      const changed =
        next.title !== valueRef.current.title ||
        next.imageOffsetUtf16 !== valueRef.current.imageOffsetUtf16;
      valueRef.current = next;
      if (changed) {
        onDraftChangeRef.current({ ...next, note: noteRef.current });
      }
      if (selection) restoreSelection(selection);
    }, [regions, restoreSelection]);

    const clearCompositionWatchdog = useCallback(() => {
      if (compositionWatchdogRef.current !== null) {
        window.clearTimeout(compositionWatchdogRef.current);
        compositionWatchdogRef.current = null;
      }
    }, []);

    const resolveCompositionWaiters = useCallback(
      (result: ImageAtomEditorFlushResult) => {
        clearCompositionWatchdog();
        for (const resolve of compositionWaitersRef.current.splice(0)) {
          resolve(result);
        }
      },
      [clearCompositionWatchdog]
    );

    const repairProjection = useCallback((selection: LogicalSelection | null) => {
      projectionPendingRef.current = true;
      projectionSelectionRef.current = selection;
      setProjectionVersion((version) => version + 1);
    }, []);

    const flush = useCallback(async (): Promise<ImageAtomEditorFlushResult> => {
      if (unmountedRef.current) return "cancelled";
      if (composingRef.current) {
        if (compositionInterruptedRef.current) return "cancelled";
        if (compositionWatchdogRef.current === null) {
          compositionWatchdogRef.current = window.setTimeout(() => {
            compositionWatchdogRef.current = null;
            if (!composingRef.current || unmountedRef.current) return;
            compositionInterruptedRef.current = true;
            for (const resolve of compositionWaitersRef.current.splice(0)) {
              resolve("cancelled");
            }
          }, COMPOSITION_FLUSH_WATCHDOG_MS);
        }
        return new Promise((resolve) => {
          compositionWaitersRef.current.push(resolve);
        });
      }
      publishDom(logicalSelection() ?? undefined);
      return "flushed";
    }, [logicalSelection, publishDom]);

    const flushAndGetSelectionSnapshot = useCallback(async (): Promise<ImageAtomEditorSelectionSnapshot | null> => {
      try {
        if ((await flush()) === "cancelled") return null;
        const selection = publishedSelection();
        return selection
          ? { selection, authority: selectionAuthorityRef.current }
          : null;
      } catch {
        return null;
      }
    }, [flush, publishedSelection]);

    const flushAndGetSelection = useCallback(async (): Promise<LogicalSelection | null> =>
      (await flushAndGetSelectionSnapshot())?.selection ?? null,
    [flushAndGetSelectionSnapshot]);

    const isSelectionAuthorityCurrent = useCallback(
      (authority: ImageAtomEditorSelectionAuthority): boolean => {
        const selection = observeSemanticSelection();
        return selection !== null && selectionAuthorityRef.current === authority;
      },
      [observeSemanticSelection]
    );

    const activeEditor = useMemo<ActiveImageAtomEditor>(
      () => ({
        nodeId,
        flush,
        flushAndGetSelection,
        flushAndGetSelectionSnapshot,
        isSelectionAuthorityCurrent,
        claimPaste: (event) => onImageAtomPasteRef.current?.(event) ?? false
      }),
      [
        flush,
        flushAndGetSelection,
        flushAndGetSelectionSnapshot,
        isSelectionAuthorityCurrent,
        nodeId
      ]
    );
    const activeRegistrationCleanupRef = useRef<(() => void) | null>(null);
    const deactivateActiveEditor = useCallback(() => {
      activeRegistrationCleanupRef.current?.();
      activeRegistrationCleanupRef.current = null;
    }, []);
    const activateActiveEditor = useCallback(() => {
      deactivateActiveEditor();
      activeRegistrationCleanupRef.current =
        registerActiveEditor?.(activeEditor) ?? null;
    }, [activeEditor, deactivateActiveEditor, registerActiveEditor]);

    useEffect(() => {
      deactivateActiveEditor();
      if (!unavailable && hostRef.current?.contains(document.activeElement)) {
        activateActiveEditor();
      }
      return deactivateActiveEditor;
    }, [activateActiveEditor, deactivateActiveEditor, unavailable]);

    useEffect(() => {
      if (unavailable) imageGroupSelectionRef.current = null;
    }, [unavailable]);

    useImperativeHandle(
      forwardedRef,
      () => ({
        focus(selection) {
          const host = hostRef.current;
          if (!host?.isConnected) return false;
          host.focus();
          if (document.activeElement !== host) return false;
          return selection ? restoreSelection(selection) : true;
        },
        restoreSelection,
        flush,
        flushAndGetSelection,
        flushAndGetSelectionSnapshot,
        containsAtomSelection: () => {
          const selected = logicalSelection();
          return selected ? isAtomSelection(valueRef.current, selected) : false;
        }
      }),
      [
        flush,
        flushAndGetSelection,
        flushAndGetSelectionSnapshot,
        logicalSelection,
        restoreSelection
      ]
    );

    useEffect(() => {
      if (!registerFlushAdapter) return;
      return registerFlushAdapter({ nodeId, flush, flushAndGetSelection });
    }, [flush, flushAndGetSelection, nodeId, registerFlushAdapter]);

    useEffect(() => {
      unmountedRef.current = false;
      const compositionWaiters = compositionWaitersRef.current;
      return () => {
        unmountedRef.current = true;
        imageGroupSelectionRef.current = null;
        clearCompositionWatchdog();
        observerRef.current?.disconnect();
        for (const resolve of compositionWaiters.splice(0)) {
          resolve("cancelled");
        }
      };
    }, [clearCompositionWatchdog]);

    useLayoutEffect(() => {
      const currentRegions = regions();
      if (!currentRegions || typeof MutationObserver === "undefined") return;
      const observer = new MutationObserver(() => {
        if (composingRef.current || projectionPendingRef.current) return;
        const expected = validateImagePrimary(valueRef.current);
        if (
          editableRegionText(currentRegions.before) === expected.beforeText &&
          editableRegionText(currentRegions.after) === expected.afterText &&
          hasControlledRegionStructure(currentRegions.before, expected.beforeText) &&
          hasControlledRegionStructure(currentRegions.after, expected.afterText)
        ) {
          return;
        }
        // Recreate the controlled region children instead of assigning
        // `textContent`: the latter destroys token overlays and empty caret
        // aids that React owns alongside the editable raw text.
        repairProjection(logicalSelection());
      });
      const resume = () => {
        observer.observe(currentRegions.host, {
          childList: true,
          characterData: true,
          subtree: true
        });
      };
      resume();
      observerRef.current = observer;
      return () => {
        observer.disconnect();
        if (observerRef.current === observer) observerRef.current = null;
      };
    }, [logicalSelection, projectionVersion, regions, repairProjection]);

    useLayoutEffect(() => {
      if (!projectionPendingRef.current) return;
      const pendingIncoming = pendingIncomingValueRef.current;
      if (pendingIncoming) {
        pendingIncomingValueRef.current = null;
        valueRef.current = pendingIncoming;
        appliedIncomingValueRef.current = pendingIncoming;
        setProjectionVersion((version) => version + 1);
        return;
      }
      projectionPendingRef.current = false;
      const expected = validateImagePrimary(valueRef.current);
      restoreSelection(
        projectionSelectionRef.current ?? {
          anchorUtf16: expected.beforeText.length,
          focusUtf16: expected.beforeText.length
        }
      );
      projectionSelectionRef.current = null;
    }, [projectionVersion, restoreSelection]);

    const applyLogicalEdit = useCallback((
      replacement: string,
      selectionOverride?: LogicalSelection
    ): void => {
      const selection = selectionOverride ?? logicalSelection();
      if (!selection) return;
      const result = applyImageLogicalTextEdit(valueRef.current, selection, replacement);
      if (result.removesAtom) {
        onAtomDelete?.("selection");
        return;
      }
      valueRef.current = result.value;
      onDraftChangeRef.current({ ...result.value, note: noteRef.current });
      if (
        replacement === "!" &&
        result.selection.focusUtf16 === result.selection.anchorUtf16
      ) {
        const endUtf16 = logicalToRawOffset(
          result.value,
          result.selection.focusUtf16,
          "after"
        );
        if (
          result.value.title.slice(endUtf16 - 2, endUtf16) === "!!" &&
          endUtf16 - 2 >=
            (result.selection.focusUtf16 <= result.value.imageOffsetUtf16
              ? 0
              : result.value.imageOffsetUtf16) &&
          hostRef.current
        ) {
          onDateTrigger?.(
            { startUtf16: endUtf16 - 2, endUtf16 },
            hostRef.current,
            result.value.title
          );
        }
      }
      queueMicrotask(() => restoreSelection(result.selection));
    }, [logicalSelection, onAtomDelete, onDateTrigger, restoreSelection]);

    const onBeforeInput = useCallback((event: InputEvent) => {
      if (unavailable || composingRef.current || event.isComposing) return;
      const { inputType, data } = event;
      const selection = logicalSelection();
      if (inputType === "insertText" || inputType === "insertReplacementText") {
        event.preventDefault();
        applyLogicalEdit(data ?? "");
        return;
      }
      if (inputType === "deleteContentForward" || inputType === "deleteContentBackward") {
        event.preventDefault();
        if (selection && isAtomSelection(valueRef.current, selection)) {
          onAtomDelete?.("selection");
          return;
        }
        const offset = valueRef.current.imageOffsetUtf16;
        if (
          selection &&
          ((inputType === "deleteContentForward" && selection.focusUtf16 === offset) ||
            (inputType === "deleteContentBackward" && selection.focusUtf16 === offset + 1))
        ) {
          onAtomDelete?.(inputType === "deleteContentForward" ? "forward" : "backward");
          return;
        }
        if (selection && selection.anchorUtf16 === selection.focusUtf16) {
          const neighbor = stepLogicalOffset(
            valueRef.current,
            selection.focusUtf16,
            inputType === "deleteContentForward" ? 1 : -1
          );
          if (neighbor !== selection.focusUtf16) {
            applyLogicalEdit("", {
              anchorUtf16: selection.focusUtf16,
              focusUtf16: neighbor
            });
          }
          return;
        }
        applyLogicalEdit("");
        return;
      }
      if (inputType === "insertParagraph") {
        event.preventDefault();
        onEnter?.();
        return;
      }
      if (inputType === "insertLineBreak") {
        event.preventDefault();
        onSupportingNote?.();
        return;
      }
      if (inputType === "historyUndo" || inputType === "historyRedo") {
        event.preventDefault();
        (inputType === "historyUndo" ? onUndo : onRedo)?.();
        return;
      }
      event.preventDefault();
    }, [applyLogicalEdit, logicalSelection, onAtomDelete, onEnter, onRedo, onSupportingNote, onUndo, unavailable]);

    useEffect(() => {
      const host = hostRef.current;
      if (!host) return;
      host.addEventListener("beforeinput", onBeforeInput);
      return () => host.removeEventListener("beforeinput", onBeforeInput);
    }, [onBeforeInput]);

    const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
      if (event.target !== event.currentTarget) return;
      if (unavailable || composingRef.current || event.nativeEvent.isComposing) return;
      const selected = logicalSelection();
      const exactAtomSelected =
        selected !== null && isExactAtomSelection(valueRef.current, selected);
      const plainF6 =
        event.key === "F6" &&
        !event.repeat &&
        !event.altKey &&
        !event.ctrlKey &&
        !event.metaKey &&
        !event.shiftKey;
      if (plainF6 && exactAtomSelected && enterImageGroup(selected)) {
        event.preventDefault();
        event.stopPropagation();
        return;
      }
      const opensImageActions =
        event.key === "ContextMenu" ||
        (event.key === "F10" &&
          event.shiftKey &&
          !event.altKey &&
          !event.ctrlKey &&
          !event.metaKey);
      if (opensImageActions && exactAtomSelected && enterImageGroup(selected)) {
        event.preventDefault();
        event.stopPropagation();
        forwardImageGroupKeyboardEvent(event);
        return;
      }
      if ((event.metaKey || event.ctrlKey) && !event.altKey) {
        if (event.key.toLowerCase() === "z") {
          event.preventDefault();
          (event.shiftKey ? onRedo : onUndo)?.();
          return;
        }
        const kind = resolveInlineFormatShortcut(event);
        if (kind && selected) {
          event.preventDefault();
          const value = valueRef.current;
          const start = Math.min(selected.anchorUtf16, selected.focusUtf16);
          const end = Math.max(selected.anchorUtf16, selected.focusUtf16);
          const before = end <= value.imageOffsetUtf16;
          const after = start >= value.imageOffsetUtf16 + 1;
          if (before || after) {
            const offset = after ? 1 : 0;
            const segmentStart = after ? start - value.imageOffsetUtf16 - 1 : start;
            const segmentEnd = after ? end - value.imageOffsetUtf16 - 1 : end;
            const segment = after
              ? value.title.slice(value.imageOffsetUtf16)
              : value.title.slice(0, value.imageOffsetUtf16);
            const edit = toggleInlineFormat(segment, segmentStart, segmentEnd, kind);
            const next = after
              ? joinImagePrimary({
                  beforeText: value.title.slice(0, value.imageOffsetUtf16),
                  afterText: edit.value
                })
              : joinImagePrimary({
                  beforeText: edit.value,
                  afterText: value.title.slice(value.imageOffsetUtf16)
                });
            valueRef.current = next;
            onDraftChangeRef.current({ ...next, note: noteRef.current });
            queueMicrotask(() => restoreSelection({
              anchorUtf16: edit.selectionStart + (after ? next.imageOffsetUtf16 + offset : 0),
              focusUtf16: edit.selectionEnd + (after ? next.imageOffsetUtf16 + offset : 0)
            }));
            return;
          }
        }
      }
      if (event.key === "Enter") {
        event.preventDefault();
        (event.shiftKey ? onSupportingNote : onEnter)?.();
        return;
      }
      if (
        (event.key === "ArrowLeft" || event.key === "ArrowRight") &&
        !event.altKey &&
        !event.ctrlKey &&
        !event.metaKey
      ) {
        const selected = logicalSelection();
        if (!selected) return;
        const next = nextArrowSelection(valueRef.current, selected, event.key, event.shiftKey);
        if (next) {
          event.preventDefault();
          restoreSelection(next);
        }
        return;
      }
      if (event.shiftKey && (event.key === "ArrowUp" || event.key === "ArrowDown")) {
        const selected = logicalSelection();
        if (selected) {
          event.preventDefault();
          restoreSelection({
            anchorUtf16: selected.anchorUtf16,
            focusUtf16:
              event.key === "ArrowUp" &&
              selected.anchorUtf16 >= valueRef.current.imageOffsetUtf16 + 1 &&
              selected.focusUtf16 >= valueRef.current.imageOffsetUtf16 + 1
                ? valueRef.current.imageOffsetUtf16
                : event.key === "ArrowDown" &&
                    selected.anchorUtf16 <= valueRef.current.imageOffsetUtf16 &&
                    selected.focusUtf16 <= valueRef.current.imageOffsetUtf16
                  ? valueRef.current.imageOffsetUtf16 + 1
                  : stepLogicalOffset(
                      valueRef.current,
                      selected.focusUtf16,
                      event.key === "ArrowUp" ? -1 : 1
                    )
          });
        }
      }
      if (!event.defaultPrevented) onUnhandledKeyDown?.(event);
    };

    const onCompositionStart = () => {
      clearCompositionWatchdog();
      composingRef.current = true;
      compositionInterruptedRef.current = false;
      compositionProjectionRef.current = { ...valueRef.current };
      observerRef.current?.disconnect();
    };

    const onCompositionEnd = (event: CompositionEvent<HTMLDivElement>) => {
      clearCompositionWatchdog();
      if (!composingRef.current) {
        repairProjection(null);
        if (document.activeElement !== event.currentTarget) setEditing(false);
        return;
      }
      composingRef.current = false;
      compositionInterruptedRef.current = false;
      const selection = logicalSelection();
      publishDom();
      compositionProjectionRef.current = null;
      repairProjection(selection);
      resolveCompositionWaiters("deferred");
      if (document.activeElement !== event.currentTarget) {
        setEditing(false);
      }
    };

    const selectAtom = (event: { shiftKey?: boolean }) => {
      const value = valueRef.current;
      const current = logicalSelection();
      restoreSelection(
        event.shiftKey && current
          ? { anchorUtf16: current.anchorUtf16, focusUtf16: value.imageOffsetUtf16 + 1 }
          : { anchorUtf16: value.imageOffsetUtf16, focusUtf16: value.imageOffsetUtf16 + 1 }
      );
    };

    const beforeOverlay = useMemo(
      () => (
        <NoteTokenText
          data-image-atom-overlay="true"
          aria-hidden={editing || undefined}
          text={segments.beforeText}
          onTagClick={onTagClick}
          today={today}
          isTagActive={isTagActive}
          onDateClick={onDateClick}
        />
      ),
      [editing, isTagActive, onDateClick, onTagClick, segments.beforeText, today]
    );
    const afterOverlay = useMemo(
      () => (
        <NoteTokenText
          data-image-atom-overlay="true"
          aria-hidden={editing || undefined}
          text={segments.afterText}
          onTagClick={(token) => onTagClick({
            ...token,
            startUtf16: token.startUtf16 + segments.beforeText.length,
            endUtf16: token.endUtf16 + segments.beforeText.length
          })}
          today={today}
          isTagActive={isTagActive}
          onDateClick={
            onDateClick
              ? (token, anchor) => onDateClick({
                  ...token,
                  startUtf16: token.startUtf16 + segments.beforeText.length,
                  endUtf16: token.endUtf16 + segments.beforeText.length
                }, anchor)
              : undefined
          }
        />
      ),
      [editing, isTagActive, onDateClick, onTagClick, segments.afterText, segments.beforeText.length, today]
    );

    const rawTextStyle = { opacity: editing ? 1 : 0 };
    const overlayStyle = {
      position: "absolute" as const,
      inset: 0,
      pointerEvents: editing ? ("none" as const) : ("auto" as const),
      visibility: editing ? ("hidden" as const) : ("visible" as const)
    };
    const revealRawText = (event: ReactPointerEvent<HTMLSpanElement>) => {
      if (unavailable) return;
      event.preventDefault();
      const currentRegions = regions();
      if (!currentRegions) return;
      const fallback = currentRegions.before.contains(event.currentTarget)
        ? valueRef.current.imageOffsetUtf16
        : valueRef.current.imageOffsetUtf16 + 1;
      const caret = logicalOffsetFromClientPoint(
        currentRegions,
        event.clientX,
        event.clientY,
        fallback
      );
      setEditing(true);
      queueMicrotask(() => {
        hostRef.current?.focus();
        restoreSelection({ anchorUtf16: caret, focusUtf16: caret });
      });
    };

    return (
      <div
        ref={(element) => {
          hostRef.current = element;
          setRef(contentRef, element);
        }}
        className={["notes-image-atom-editor", className].filter(Boolean).join(" ")}
        data-image-atom-editing={editing ? "true" : "false"}
        data-image-atom-caret-side={selectionUiState.caretSide ?? undefined}
        role="textbox"
        aria-label={ariaLabel}
        aria-multiline="true"
        aria-readonly={unavailable || undefined}
        contentEditable={!unavailable}
        suppressContentEditableWarning
        onKeyDown={onKeyDown}
        onCompositionStart={onCompositionStart}
        onCompositionEnd={onCompositionEnd}
        onFocus={(event) => {
          if (!unavailable) {
            activateActiveEditor();
            if (event.target === event.currentTarget) {
              setEditing(true);
            }
          }
        }}
        onBlur={(event) => {
          if (
            event.relatedTarget instanceof Node &&
            event.currentTarget.contains(event.relatedTarget)
          ) {
            return;
          }
          if (!composingRef.current) setEditing(false);
          deactivateActiveEditor();
          void flush();
        }}
        onPaste={(event) => {
          if (onImageAtomPaste?.(event.nativeEvent) || onPaste?.(event)) {
            event.preventDefault();
            return;
          }
          if (unavailable) return;
          let plainText = "";
          try {
            plainText = event.clipboardData?.getData("text/plain") ?? "";
          } catch {
            return;
          }
          if (!plainText) return;
          event.preventDefault();
          applyLogicalEdit(plainText);
        }}
        onDrop={(event) => {
          if (onDrop?.(event)) event.preventDefault();
        }}
      >
        <span
          key={`before:${projectionVersion}`}
          ref={beforeRef}
          data-image-atom-region="before"
          data-image-atom-empty={segments.beforeText.length === 0 || undefined}
          data-notes-native-selection-surface
        >
          <span
            data-image-atom-raw
            aria-hidden={!editing || undefined}
            style={rawTextStyle}
          >
            {segments.beforeText || <span {...{ [IMAGE_ATOM_CARET_AID_ATTRIBUTE]: "true" }} aria-hidden="true">{"\u200b"}</span>}
          </span>
          {beforeOverlay && (
            <span
              data-image-atom-overlay-container
              contentEditable={false}
              style={overlayStyle}
              onPointerDown={revealRawText}
            >
              {beforeOverlay}
            </span>
          )}
        </span>
        <span
          ref={atomRef}
          data-image-atom-region="atom"
          data-atom-selected={selectionUiState.atomSelected || undefined}
          data-notes-native-selection-surface
          contentEditable={false}
          onClick={(event) => {
            if (isNestedImageControl(event.target, atomContentRef.current)) return;
            if (pointerDraggedRef.current) {
              pointerDraggedRef.current = false;
              return;
            }
            selectAtom(event);
          }}
          onPointerDown={(event) => {
            if (
              event.button === 0 &&
              !isNestedImageControl(event.target, atomContentRef.current)
            ) {
              event.preventDefault();
              const imageOffset = valueRef.current.imageOffsetUtf16;
              if (event.shiftKey) {
                pointerAnchorRef.current =
                  logicalSelection()?.anchorUtf16 ?? imageOffset;
              } else {
                const bounds = event.currentTarget.getBoundingClientRect();
                pointerAnchorRef.current =
                  bounds.width > 0 && event.clientX >= bounds.left + bounds.width / 2
                    ? imageOffset + 1
                    : imageOffset;
              }
              pointerActiveRef.current = true;
              pointerDraggedRef.current = false;
              pointerIdRef.current = Number.isFinite(event.pointerId)
                ? event.pointerId
                : null;
              if (pointerIdRef.current !== null) {
                event.currentTarget.setPointerCapture?.(pointerIdRef.current);
              }
              hostRef.current?.focus();
              restoreSelection({
                anchorUtf16: event.shiftKey ? pointerAnchorRef.current : imageOffset,
                focusUtf16: imageOffset + 1
              });
            }
          }}
          onPointerMove={(event) => {
            if (
              event.buttons !== 1 ||
              !pointerActiveRef.current ||
              pointerAnchorRef.current === null ||
              (pointerIdRef.current !== null && event.pointerId !== pointerIdRef.current)
            ) {
              return;
            }
            if (event.defaultPrevented) {
              finishAtomPointerInteraction(event.currentTarget, true);
              return;
            }
            const currentRegions = regions();
            if (!currentRegions) return;
            pointerDraggedRef.current = true;
            restoreSelection({
              anchorUtf16: pointerAnchorRef.current,
              focusUtf16: logicalOffsetFromClientPoint(
                currentRegions,
                event.clientX,
                event.clientY,
                valueRef.current.imageOffsetUtf16 + 1
              )
            });
          }}
          onPointerUp={(event) => {
            finishAtomPointerInteraction(
              event.currentTarget,
              pointerDraggedRef.current
            );
          }}
          onPointerCancel={(event) => {
            finishAtomPointerInteraction(event.currentTarget, false);
          }}
        >
          <NotesImageNodeContent
            nodeId={nodeId}
            attachment={attachment}
            contentRef={atomContentRef}
            onKeyDown={onUnhandledKeyDown}
            onEscape={returnFromImageGroup}
            onRemoveImage={onRemoveImage}
            readOnly={readOnly}
            disabled={disabled}
          />
        </span>
        <span
          key={`after:${projectionVersion}`}
          ref={afterRef}
          data-image-atom-region="after"
          data-image-atom-empty={segments.afterText.length === 0 || undefined}
          data-notes-native-selection-surface
        >
          <span
            data-image-atom-raw
            aria-hidden={!editing || undefined}
            style={rawTextStyle}
          >
            {segments.afterText || <span {...{ [IMAGE_ATOM_CARET_AID_ATTRIBUTE]: "true" }} aria-hidden="true">{"\u200b"}</span>}
          </span>
          {afterOverlay && (
            <span
              data-image-atom-overlay-container
              contentEditable={false}
              style={overlayStyle}
              onPointerDown={revealRawText}
            >
              {afterOverlay}
            </span>
          )}
        </span>
      </div>
    );
  }
);
