import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore
} from "react";
import * as monaco from "monaco-editor/esm/vs/editor/editor.api";
import EditorWorker from "monaco-editor/esm/vs/editor/editor.worker?worker";
import type { NoteView } from "../../../packages/contracts/generated/NoteView";
import type { NotesStore } from "./notesStore";
import type { OutlineIndex } from "./outlineIndex";
import {
  buildMonacoOutlineProjection,
  planMonacoProjectionEdit,
  type MonacoOutlineProjection
} from "./monacoOutlineProjection";
import { MonacoOutlineController } from "./monacoOutlineController";
import {
  resolveMonacoOutlineGesture
} from "./monacoOutlineKeyboard";
import {
  buildMonacoOutlineDecorations,
  isMonacoCaretOnTextSide,
  scheduleMonacoOutlineCaretNormalization
} from "./monacoOutlineCaret";
import {
  executeMonacoOutlineGesture,
  type MonacoOutlineCommandContext,
  type MonacoOutlineCommandRuntime
} from "./monacoOutlineCommands";
import { shouldRestoreMonacoOutlineFocus } from "./monacoOutlineFocus";
import { runMonacoOutlineReconciliation } from "./monacoOutlineReconciliation";
import { shouldSeedMonacoOutline } from "./monacoOutlineSeed";

type MonacoGlobal = typeof globalThis & {
  MonacoEnvironment?: {
    getWorker: (_workerId: string, _label: string) => Worker;
  };
};

const monacoGlobal = globalThis as MonacoGlobal;
monacoGlobal.MonacoEnvironment ??= {
  getWorker: () => new EditorWorker()
};

export default function MonacoOutlineSurface({
  nodes,
  index,
  rootId,
  paneId,
  store,
  structuralContextComplete
}: {
  readonly nodes: readonly NoteView[];
  readonly index: OutlineIndex;
  readonly rootId: string;
  readonly paneId: "primary" | "secondary";
  readonly store: NotesStore;
  readonly structuralContextComplete: boolean;
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  const runtimeRef = useRef<MonacoRuntime | null>(null);
  const [compositionEpoch, setCompositionEpoch] = useState(0);
  const nodeIds = useMemo(() => nodes.map((node) => node.id), [nodes]);
  const subscribeNodes = useCallback(
    (listener: () => void) => store.subscribeNodes(nodeIds, listener),
    [nodeIds, store]
  );
  const getNodeEpoch = useCallback(
    () => store.getNodeEpoch(nodeIds),
    [nodeIds, store]
  );
  const nodeEpoch = useSyncExternalStore(
    subscribeNodes,
    getNodeEpoch,
    getNodeEpoch
  );
  const projection = useMemo(
    () => {
      void nodeEpoch;
      return buildMonacoOutlineProjection(
        nodes,
        index,
        rootId,
        (nodeId) => store.getNodeSnapshot(nodeId).title
      );
    },
    [index, nodeEpoch, nodes, rootId, store]
  );
  const latestProjectionRef = useRef(projection);
  latestProjectionRef.current = projection;
  const latestContextRef = useRef<MonacoOutlineCommandContext>({
    index,
    rootId,
    structuralContextComplete
  });
  latestContextRef.current = {
    index,
    rootId,
    structuralContextComplete
  };

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const initialProjection = latestProjectionRef.current;
    const model = monaco.editor.createModel(
      initialProjection.value,
      "plaintext",
      monaco.Uri.parse(
        `inmemory://yonalist/${paneId}/${encodeURIComponent(rootId)}`
      )
    );
    const editor = monaco.editor.create(host, {
      model,
      ariaLabel: "Notes outline editor",
      automaticLayout: true,
      fontFamily: [
        "Inter",
        "ui-sans-serif",
        "system-ui",
        "-apple-system",
        "BlinkMacSystemFont",
        "\"Segoe UI\"",
        "sans-serif"
      ].join(", "),
      fontSize: 16,
      fontWeight: "400",
      lineHeight: 28,
      lineNumbers: "off",
      lineNumbersMinChars: 0,
      glyphMargin: false,
      folding: false,
      lineDecorationsWidth: 0,
      minimap: { enabled: false },
      overviewRulerLanes: 0,
      overviewRulerBorder: false,
      hideCursorInOverviewRuler: true,
      renderLineHighlight: "none",
      renderWhitespace: "none",
      scrollBeyondLastLine: false,
      scrollBeyondLastColumn: 0,
      smoothScrolling: false,
      cursorSmoothCaretAnimation: "off",
      wordWrap: "on",
      wrappingIndent: "none",
      links: false,
      matchBrackets: "never",
      occurrencesHighlight: "off",
      selectionHighlight: false,
      quickSuggestions: false,
      suggestOnTriggerCharacters: false,
      wordBasedSuggestions: "off",
      formatOnPaste: false,
      formatOnType: false,
      padding: { top: 0, bottom: 0 },
      fixedOverflowWidgets: true
    });
    const decorations = editor.createDecorationsCollection();
    const controller = new MonacoOutlineController(
      initialProjection,
      (nodeId, text) => store.setDraft(nodeId, text)
    );
    const runtime: MonacoRuntime = {
      editor,
      model,
      decorations,
      projection: initialProjection,
      controller,
      applyingProjection: false,
      enterGesture: null,
      pendingCaret: null,
      caretNormalizationEpoch: 0
    };
    runtimeRef.current = runtime;
    const contentListener = model.onDidChangeContent((event) => {
      if (runtime.applyingProjection) return;
      const result = controller.applyContentChange(
        event.changes.map((change) => ({
          startLineNumber: change.range.startLineNumber,
          endLineNumber: change.range.endLineNumber,
          text: change.text
        })),
        (lineNumber) => model.getLineContent(lineNumber)
      );
      if (result === "structural" || result === "rejected") {
        reconcileModel(runtime, runtime.projection);
      }
    });
    const compositionStartListener = editor.onDidCompositionStart(() => {
      controller.beginComposition();
    });
    const compositionEndListener = editor.onDidCompositionEnd(() => {
      controller.endComposition(
        (lineNumber) => model.getLineContent(lineNumber)
      );
      setCompositionEpoch((epoch) => epoch + 1);
    });
    const keyDownListener = editor.onKeyDown((event) => {
      const selection = editor.getSelection();
      if (!selection) return;
      const browserEvent = event.browserEvent;
      const plainBackspace = browserEvent.key === "Backspace" &&
        !browserEvent.altKey &&
        !browserEvent.ctrlKey &&
        !browserEvent.metaKey &&
        !browserEvent.shiftKey &&
        !browserEvent.isComposing;
      const backspaceGroup = plainBackspace
        ? store.beginBackspaceGesture(browserEvent.repeat)
        : (store.endBackspaceGesture(), null);
      const gesture = resolveMonacoOutlineGesture({
        key: browserEvent.key,
        altKey: browserEvent.altKey,
        ctrlKey: browserEvent.ctrlKey,
        metaKey: browserEvent.metaKey,
        shiftKey: browserEvent.shiftKey,
        isComposing: browserEvent.isComposing,
        repeat: browserEvent.repeat,
        platform: outlinePlatform(),
        lineNumber: selection.startLineNumber,
        endLineNumber: selection.endLineNumber,
        startColumn: selection.startColumn,
        endColumn: selection.endColumn,
        projection: runtime.projection
      });
      if (gesture.kind === "native") return;
      event.preventDefault();
      if (gesture.kind === "undo" || gesture.kind === "redo") {
        event.stopPropagation();
        window.dispatchEvent(new KeyboardEvent("keydown", {
          key: "z",
          ctrlKey: browserEvent.ctrlKey,
          metaKey: browserEvent.metaKey,
          shiftKey: gesture.kind === "redo"
        }));
        return;
      }
      if (gesture.kind === "moveVertical") {
        event.stopPropagation();
        moveCaretVertically(
          runtime,
          hostRef.current,
          gesture.direction,
          () => runtimeRef.current === runtime
        );
        return;
      }
      event.stopPropagation();
      executeMonacoOutlineGesture(
        gesture,
        browserEvent.repeat,
        backspaceGroup,
        runtime,
        store,
        latestContextRef.current
      );
    });
    const keyUpListener = editor.onKeyUp((event) => {
      if (event.browserEvent.key === "Enter") runtime.enterGesture = null;
      if (event.browserEvent.key === "Backspace") store.endBackspaceGesture();
    });
    updateDecorations(decorations, initialProjection);
    seedEmptyOutline(runtime, initialProjection, store, rootId);
    return () => {
      runtimeRef.current = null;
      keyUpListener.dispose();
      keyDownListener.dispose();
      compositionEndListener.dispose();
      compositionStartListener.dispose();
      contentListener.dispose();
      decorations.clear();
      editor.dispose();
      model.dispose();
    };
  }, [paneId, rootId, store]);

  useLayoutEffect(() => {
    const runtime = runtimeRef.current;
    if (!runtime || runtime.projection === projection) return;
    runMonacoOutlineReconciliation(
      runtime.controller.isCompositionActive(),
      () => {
        if (seedEmptyOutline(runtime, projection, store, rootId)) return;
        const selection = runtime.editor.getSelection();
        const selectedNodeId = selection
          ? runtime.projection.nodeIdByLine[selection.positionLineNumber - 1]
          : undefined;
        const selectedColumn = selection?.positionColumn ?? 1;
        const pendingCaret = runtime.pendingCaret;
        const restoreFocus = shouldRestoreMonacoOutlineFocus(
          runtime.editor.hasTextFocus(),
          pendingCaret !== null
        );
        const pendingLine = pendingCaret
          ? projection.lineByNodeId.get(pendingCaret.nodeId)
          : undefined;
        const host = hostRef.current;
        const normalizationEpoch =
          pendingCaret?.column === 1 && pendingLine
            ? ++runtime.caretNormalizationEpoch
            : null;
        if (normalizationEpoch !== null) {
          host?.setAttribute("data-caret-normalizing", "true");
        }
        reconcileModel(runtime, projection);
        runtime.controller.setProjection(projection);
        updateDecorations(runtime.decorations, projection);
        runtime.pendingCaret = null;
        const nextLine = pendingCaret
          ? pendingLine
          : selectedNodeId
            ? projection.lineByNodeId.get(selectedNodeId)
            : undefined;
        const nextColumn = pendingCaret?.column ?? selectedColumn;
        if (nextLine) {
          const position = {
            lineNumber: nextLine,
            column: Math.min(
              nextColumn,
              runtime.model.getLineMaxColumn(nextLine)
            )
          };
          runtime.editor.setPosition(position);
          if (restoreFocus) {
            runtime.editor.focus();
            runtime.editor.revealPositionInCenterIfOutsideViewport(
              position,
              monaco.editor.ScrollType.Immediate
            );
          }
          if (normalizationEpoch !== null) {
            scheduleMonacoOutlineCaretNormalization({
              editor: runtime.editor,
              position,
              isCurrent: () =>
                runtimeRef.current === runtime &&
                runtime.caretNormalizationEpoch === normalizationEpoch,
              isCaretOnTextSide: () =>
                host !== null && isMonacoCaretOnTextSide(host),
              hideCaret: () =>
                host?.setAttribute("data-caret-normalizing", "true"),
              showCaret: () =>
                host?.removeAttribute("data-caret-normalizing")
            });
          }
        } else if (
          normalizationEpoch !== null &&
          runtime.caretNormalizationEpoch === normalizationEpoch
        ) {
          host?.removeAttribute("data-caret-normalizing");
        }
      }
    );
  }, [compositionEpoch, projection, rootId, store]);

  return (
    <div
      ref={hostRef}
      className="notes-monaco-outline"
      data-outline-pane-id={paneId}
    />
  );
}

interface MonacoRuntime extends MonacoOutlineCommandRuntime {
  readonly editor: monaco.editor.IStandaloneCodeEditor;
  readonly model: monaco.editor.ITextModel;
  readonly decorations: monaco.editor.IEditorDecorationsCollection;
  readonly controller: MonacoOutlineController;
  projection: MonacoOutlineProjection;
  applyingProjection: boolean;
  caretNormalizationEpoch: number;
}

function outlinePlatform(): "mac" | "other" {
  return /Mac|iPhone|iPad|iPod/iu.test(globalThis.navigator?.platform ?? "")
    ? "mac"
    : "other";
}

function seedEmptyOutline(
  runtime: MonacoRuntime,
  projection: MonacoOutlineProjection,
  store: NotesStore,
  rootId: string
): boolean {
  if (!shouldSeedMonacoOutline(
    projection.lines.length,
    store.getSnapshot().nodes,
    rootId
  )) {
    return false;
  }
  const pending = store.beginCreateNode(rootId);
  runtime.pendingCaret = { nodeId: pending.id, column: 1 };
  void pending.committed.catch(() => undefined);
  return true;
}

function reconcileModel(
  runtime: MonacoRuntime,
  projection: MonacoOutlineProjection
): void {
  const edit = planMonacoProjectionEdit({
    ...runtime.projection,
    value: runtime.model.getValue()
  }, projection);
  runtime.applyingProjection = true;
  try {
    if (edit) {
      runtime.model.applyEdits([{
        range: new monaco.Range(
          edit.startLineNumber,
          edit.startColumn,
          edit.endLineNumber,
          edit.endColumn
        ),
        text: edit.text
      }]);
    }
    runtime.projection = projection;
  } finally {
    runtime.applyingProjection = false;
  }
}

function updateDecorations(
  collection: monaco.editor.IEditorDecorationsCollection,
  projection: MonacoOutlineProjection
): void {
  collection.set(buildMonacoOutlineDecorations(projection));
}

function moveCaretVertically(
  runtime: MonacoRuntime,
  host: HTMLElement | null,
  direction: "up" | "down",
  isMounted: () => boolean
): void {
  runtime.editor.trigger(
    "yonalist-outline",
    direction === "up" ? "cursorUp" : "cursorDown",
    undefined
  );
  if (!host) return;
  const position = runtime.editor.getPosition();
  if (!position || position.column !== 1) {
    host.removeAttribute("data-caret-normalizing");
    return;
  }
  const normalizationEpoch = ++runtime.caretNormalizationEpoch;
  scheduleMonacoOutlineCaretNormalization({
    editor: runtime.editor,
    position,
    isCurrent: () =>
      isMounted() &&
      runtime.caretNormalizationEpoch === normalizationEpoch,
    isCaretOnTextSide: () => isMonacoCaretOnTextSide(host),
    hideCaret: () =>
      host.setAttribute("data-caret-normalizing", "true"),
    showCaret: () =>
      host.removeAttribute("data-caret-normalizing"),
    moveCaretToTextSide: () => {
      runtime.editor.trigger(
        "yonalist-outline",
        "cursorRight",
        undefined
      );
      if (runtime.model.getLineMaxColumn(position.lineNumber) > 1) {
        runtime.editor.trigger(
          "yonalist-outline",
          "cursorLeft",
          undefined
        );
      }
    }
  });
}
