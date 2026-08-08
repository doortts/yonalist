import {
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type MutableRefObject
} from "react";
import * as monaco from "monaco-editor/esm/vs/editor/editor.api";
import EditorWorker from "monaco-editor/esm/vs/editor/editor.worker?worker";
import {
  attachDevelopmentBenchmarkRun
} from "virtual:yonalist-monaco-runtime-probe";

import {
  assertMonacoInternalCapabilities
} from "./monaco-outline/internalAdapter";
import type {
  MonacoImageAnchor,
  MonacoImageIngestPort,
  MonacoImagePayload
} from "./monaco-outline/imageIngest";
import { MonacoRowActions } from "./MonacoRowActions";
import type { ImageZonePort } from "./monaco-outline/imageZones";
import {
  MonacoOutlinePaneAdapter
} from "./monaco-outline/paneAdapter";
import {
  bindYonalistOutlineEditor,
  type BoundYonalistOutlineEditor
} from "./monaco-outline/plugin";
import type {
  MonacoOutlineSession
} from "./monaco-outline/session";
import type {
  MonacoSessionRegistry
} from "./monaco-outline/sessionRegistry";

type MonacoGlobal = typeof globalThis & {
  MonacoEnvironment?: {
    getWorker: (_workerId: string, _label: string) => Worker;
  };
};

const monacoGlobal = globalThis as MonacoGlobal;
monacoGlobal.MonacoEnvironment ??= {
  getWorker: () => new EditorWorker()
};

export interface MonacoOutlineFocusRequest {
  readonly epoch: number;
  readonly nodeId: string;
}

/**
 * The image gestures a pane catches outside the editor — an OS file drop, the
 * header's picker, a row menu's — handed to the editor that anchors them. The
 * surface publishes this while it is mounted; nothing else reaches the editor.
 */
export interface MonacoOutlineImageGestures {
  ingest(payload: MonacoImagePayload, at?: MonacoImageAnchor | null): void;
  /** Marks the line a native drag is over; only the editor can find it. */
  markDropPoint(at: MonacoImageAnchor | null): void;
}

/** Everything the outline's image rows need from the store, in one object. */
export type MonacoOutlineImagePort = ImageZonePort & MonacoImageIngestPort;

export default function MonacoOutlineSurface({
  pageId,
  paneId,
  zoomRootId,
  showCompleted,
  registry,
  focusRequest,
  gesturesRef,
  images,
  onPickImage,
  onSessionChange,
  onZoomRootChange,
  onOpenSplit,
  onUnsupported
}: {
  readonly pageId: string;
  readonly paneId: "primary" | "secondary";
  readonly zoomRootId: string | null;
  readonly showCompleted: boolean;
  readonly registry: MonacoSessionRegistry;
  readonly focusRequest: MonacoOutlineFocusRequest | null;
  /** Filled while the surface is mounted, so the pane can reach the editor. */
  readonly gesturesRef?: MutableRefObject<MonacoOutlineImageGestures | null>;
  /** Bytes, image writes and the lightbox host, all owned by NotesOutline. */
  readonly images?: MonacoOutlineImagePort;
  /** Opens the file picker for one row; absent hides the row action rail. */
  readonly onPickImage?: (nodeId: string) => void;
  readonly onSessionChange: (session: MonacoOutlineSession | null) => void;
  readonly onZoomRootChange: (nodeId: string) => void;
  readonly onOpenSplit: (nodeId: string) => void;
  readonly onUnsupported: (cause: unknown) => void;
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  const editorRef =
    useRef<monaco.editor.IStandaloneCodeEditor | null>(null);
  const paneRef = useRef<MonacoOutlinePaneAdapter | null>(null);
  const bindingRef = useRef<BoundYonalistOutlineEditor | null>(null);
  const zoomRef = useRef(zoomRootId);
  const completedRef = useRef(showCompleted);
  const onZoomRef = useRef(onZoomRootChange);
  const onOpenSplitRef = useRef(onOpenSplit);
  const onUnsupportedRef = useRef(onUnsupported);
  const onSessionChangeRef = useRef(onSessionChange);
  const imagesRef = useRef(images);
  const onPickImageRef = useRef(onPickImage);
  const handledFocusEpochRef = useRef<number | null>(null);
  const [session, setSession] = useState<MonacoOutlineSession | null>(null);
  const [pane, setPane] = useState<MonacoOutlinePaneAdapter | null>(null);
  zoomRef.current = zoomRootId;
  completedRef.current = showCompleted;
  onZoomRef.current = onZoomRootChange;
  onOpenSplitRef.current = onOpenSplit;
  onUnsupportedRef.current = onUnsupported;
  onSessionChangeRef.current = onSessionChange;
  imagesRef.current = images;
  onPickImageRef.current = onPickImage;

  useEffect(() => {
    let cancelled = false;
    let release: (() => Promise<void>) | null = null;
    let editor: monaco.editor.IStandaloneCodeEditor | null = null;
    let pane: MonacoOutlinePaneAdapter | null = null;
    let binding: BoundYonalistOutlineEditor | null = null;
    let blur: monaco.IDisposable | null = null;
    try {
      assertMonacoInternalCapabilities();
    } catch (cause) {
      onUnsupportedRef.current(cause);
      return;
    }
    void registry.acquire(pageId).then((lease) => {
      if (cancelled || !hostRef.current) {
        void lease.release();
        return;
      }
      release = lease.release;
      editor = monaco.editor.create(
        hostRef.current,
        editorOptions(lease.session.model)
      );
      editorRef.current = editor;
      pane = new MonacoOutlinePaneAdapter({
        paneId,
        editor,
        session: lease.session,
        zoomRootId: zoomRef.current,
        showCompleted: completedRef.current,
        navigation: {
          zoomSamePane: (nodeId) => onZoomRef.current(nodeId),
          openSecondary: (nodeId) => onOpenSplitRef.current(nodeId)
        },
        images: imagesRef.current && {
          residency: imagesRef.current.residency,
          resize: (nodeId, width) =>
            imagesRef.current!.resize(nodeId, width),
          openLightbox: (request) =>
            imagesRef.current?.openLightbox(request)
        }
      });
      paneRef.current = pane;
      binding = bindYonalistOutlineEditor(editor, {
        session: lease.session,
        pane,
        images: imagesRef.current && {
          import: (request) => imagesRef.current!.import(request),
          importPaths: (request) => imagesRef.current!.importPaths(request),
          remove: (nodeIds) => imagesRef.current!.remove(nodeIds),
          restore: (nodeIds) => imagesRef.current!.restore(nodeIds)
        }
      });
      bindingRef.current = binding;
      if (gesturesRef) {
        gesturesRef.current = {
          ingest: (payload, at) => bindingRef.current?.ingestImages(payload, at),
          markDropPoint: (at) => bindingRef.current?.markImageDropPoint(at)
        };
      }
      blur = editor.onDidBlurEditorText(() => {
        void lease.session.flush("blur").catch(() => undefined);
      });
      lease.session.ensureEditableLine();
      setSession(lease.session);
      setPane(pane);
      onSessionChangeRef.current(lease.session);
    }).catch((cause) => {
      if (!cancelled) onUnsupportedRef.current(cause);
    });
    return () => {
      cancelled = true;
      editorRef.current = null;
      paneRef.current = null;
      bindingRef.current = null;
      setPane(null);
      if (gesturesRef) gesturesRef.current = null;
      onSessionChangeRef.current(null);
      blur?.dispose();
      binding?.dispose();
      pane?.dispose();
      editor?.dispose();
      void release?.().catch(() => undefined);
    };
  }, [gesturesRef, pageId, paneId, registry]);

  useEffect(() => {
    if (!session || !editorRef.current) return;
    const benchmark = attachDevelopmentBenchmarkRun(
      editorRef.current,
      session
    );
    return () => {
      benchmark?.dispose();
    };
  }, [session]);

  useEffect(() => {
    if (
      !session ||
      !editorRef.current ||
      !focusRequest ||
      handledFocusEpochRef.current === focusRequest.epoch
    ) {
      return;
    }
    const lineNumber = session.metadata.current()
      .titleLineByNodeId.get(focusRequest.nodeId);
    if (lineNumber === undefined) return;
    handledFocusEpochRef.current = focusRequest.epoch;
    editorRef.current.setPosition({ lineNumber, column: 1 });
    editorRef.current.revealLineInCenterIfOutsideViewport(lineNumber);
    editorRef.current.focus();
  }, [focusRequest, session]);

  useEffect(() => {
    paneRef.current?.setZoomRoot(zoomRootId);
  }, [zoomRootId]);

  useEffect(() => {
    paneRef.current?.setShowCompleted(showCompleted);
  }, [showCompleted]);

  return (
    <>
      <div className="notes-monaco-outline-shell">
        <div
          ref={hostRef}
          className="notes-monaco-outline"
          data-outline-pane-id={paneId}
        />
        {pane && onPickImage && (
          <MonacoRowActions
            rows={pane.rowActions}
            onPickImage={(nodeId) => onPickImageRef.current?.(nodeId)}
            onDismiss={() => editorRef.current?.focus()}
          />
        )}
      </div>
      {session && <PersistenceStatus session={session} />}
    </>
  );
}

function PersistenceStatus({
  session
}: {
  readonly session: MonacoOutlineSession;
}) {
  const state = useSyncExternalStore(
    session.subscribePersistence,
    session.persistenceState.bind(session),
    session.persistenceState.bind(session)
  );
  if (state.kind === "unsaved" || state.kind === "saving") {
    return (
      <span className="notes-selection-visually-hidden" role="status">
        {state.kind === "saving" ? "Saving outline." : "Outline has unsaved changes."}
      </span>
    );
  }
  if (state.kind === "conflict" || state.kind === "fatal") {
    return (
      <span className="notes-inline-error" role="alert">
        {state.message}
      </span>
    );
  }
  return null;
}

function editorOptions(
  model: monaco.editor.ITextModel
): monaco.editor.IStandaloneEditorConstructionOptions {
  return {
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
    lineHeight: 25,
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
  };
}
