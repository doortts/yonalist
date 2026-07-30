import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
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

type MonacoGlobal = typeof globalThis & {
  MonacoEnvironment?: {
    getWorker: (_workerId: string, _label: string) => Worker;
  };
};

const monacoGlobal = globalThis as MonacoGlobal;
monacoGlobal.MonacoEnvironment ??= {
  getWorker: () => new EditorWorker()
};

export function MonacoOutlineSurface({
  nodes,
  index,
  rootId,
  paneId,
  store
}: {
  readonly nodes: readonly NoteView[];
  readonly index: OutlineIndex;
  readonly rootId: string;
  readonly paneId: "primary" | "secondary";
  readonly store: NotesStore;
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  const runtimeRef = useRef<MonacoRuntime | null>(null);
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
    () => buildMonacoOutlineProjection(
      nodes,
      index,
      rootId,
      (nodeId) => store.getNodeSnapshot(nodeId).title
    ),
    [index, nodeEpoch, nodes, rootId, store]
  );
  const latestProjectionRef = useRef(projection);
  latestProjectionRef.current = projection;

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
      applyingProjection: false
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
    });
    updateDecorations(decorations, initialProjection);
    return () => {
      runtimeRef.current = null;
      compositionEndListener.dispose();
      compositionStartListener.dispose();
      contentListener.dispose();
      decorations.clear();
      editor.dispose();
      model.dispose();
    };
  }, [paneId, rootId, store]);

  useEffect(() => {
    const runtime = runtimeRef.current;
    if (!runtime || runtime.projection === projection) return;
    const selection = runtime.editor.getSelection();
    const selectedNodeId = selection
      ? runtime.projection.nodeIdByLine[selection.positionLineNumber - 1]
      : undefined;
    const selectedColumn = selection?.positionColumn ?? 1;
    reconcileModel(runtime, projection);
    runtime.controller.setProjection(projection);
    updateDecorations(runtime.decorations, projection);
    const nextLine = selectedNodeId
      ? projection.lineByNodeId.get(selectedNodeId)
      : undefined;
    if (nextLine) {
      runtime.editor.setPosition({
        lineNumber: nextLine,
        column: Math.min(
          selectedColumn,
          runtime.model.getLineMaxColumn(nextLine)
        )
      });
    }
  }, [projection]);

  return (
    <div
      ref={hostRef}
      className="notes-monaco-outline"
      data-outline-pane-id={paneId}
    />
  );
}

interface MonacoRuntime {
  readonly editor: monaco.editor.IStandaloneCodeEditor;
  readonly model: monaco.editor.ITextModel;
  readonly decorations: monaco.editor.IEditorDecorationsCollection;
  readonly controller: MonacoOutlineController;
  projection: MonacoOutlineProjection;
  applyingProjection: boolean;
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
  collection.set(projection.lines.map((line, position) => ({
    range: new monaco.Range(position + 1, 1, position + 1, 1),
    options: {
      before: {
        content: `${"\u00a0".repeat(line.depth * 4)}\u2022\u00a0\u00a0`,
        inlineClassName: line.editable
          ? "notes-monaco-bullet-prefix"
          : "notes-monaco-image-prefix",
        cursorStops: monaco.editor.InjectedTextCursorStops.None
      },
      showIfCollapsed: true,
      isWholeLine: true,
      className: line.editable ? undefined : "notes-monaco-image-line"
    }
  })));
}
