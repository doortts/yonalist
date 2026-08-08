import type * as monaco from "monaco-editor/esm/vs/editor/editor.api";

import type { NoteView } from "../../../../packages/contracts/generated/NoteView";
import { clipboardImageCandidates } from "../imageClipboard";
import type { ImageCandidate } from "../imageApi";
import { imageCandidates } from "../imagePicker";
import { hasErrorCode } from "../storeSupport";
import type {
  ImageInsertionAnchor,
  MonacoExternalHistoryStep
} from "./session";

export interface MonacoImageImportResult {
  /** The node ids the import created, in the order it created them. */
  readonly nodeIds: readonly string[];
  readonly nodes: readonly NoteView[];
}

/**
 * The store side of an image ingest: the same import the React outline runs,
 * plus the two notes commands an image undo needs (design §5 — the inverse of
 * an image creation is a subtree delete, which no editor batch can carry).
 */
export interface MonacoImageIngestPort {
  import(input: {
    readonly parentId: string;
    readonly beforeId: string | null;
    readonly candidates: readonly ImageCandidate[];
  }): Promise<MonacoImageImportResult>;
  /** The packaged app's OS drop, which hands over paths rather than bytes. */
  importPaths(input: {
    readonly parentId: string;
    readonly beforeId: string | null;
    readonly paths: readonly string[];
  }): Promise<MonacoImageImportResult>;
  remove(nodeIds: readonly string[]): Promise<void>;
  restore(nodeIds: readonly string[]): Promise<void>;
}

/** One gesture's payload: clipboard/DOM bytes, or native file paths. */
export type MonacoImagePayload =
  | { readonly candidates: readonly ImageCandidate[] }
  | { readonly paths: readonly string[] };

/** The part of the session an ingest touches. */
export interface MonacoImageIngestSession {
  canAcceptStructuralEdit(): boolean;
  /** The node a line belongs to; a note line reports its title's (design §1). */
  nodeIdAtLine(lineNumber: number): string | null;
  imageInsertionAnchor(nodeId: string | null): ImageInsertionAnchor | null;
  flush(reason: "blur" | "navigation" | "close"): Promise<void>;
  insertImageNodes(input: {
    readonly anchor: ImageInsertionAnchor;
    readonly nodes: readonly NoteView[];
    readonly external?: MonacoExternalHistoryStep;
  }): number | null;
  reportExternalFailure(cause: unknown): void;
}

/**
 * Design §5 in one call: drain the session batch so the editor queue and the
 * image IPC never race for a revision, import, then draw what came back.
 * Returns the line the first new picture sits on, or null when the gesture was
 * refused. A validation failure propagates to the pane that caught the
 * gesture, which is the only layer with somewhere to show it.
 */
export async function ingestImages(input: {
  readonly session: MonacoImageIngestSession;
  readonly port: MonacoImageIngestPort;
  readonly nodeId: string | null;
  readonly payload: MonacoImagePayload;
}): Promise<number | null> {
  const { session, port } = input;
  if (payloadSize(input.payload) === 0) return null;
  if (!session.canAcceptStructuralEdit()) return null;
  // A point that resolved to no line hands over the caret's node, and that
  // node may be one the metadata no longer titles. The gesture still has to
  // land, so it falls back to the page anchor — where a paste would go, and
  // the same fallback the conflict retry below takes.
  let anchor = session.imageInsertionAnchor(input.nodeId) ??
    session.imageInsertionAnchor(null);
  if (!anchor) return null;

  let result: MonacoImageImportResult;
  try {
    await session.flush("blur");
    result = await importOnce(input, anchor);
  } catch (cause) {
    if (!hasErrorCode(cause, "revision_conflict")) throw cause;
    // One retry: the flush above raced a write the queue had not yet drained.
    // That write may have moved or deleted the node the anchor named, so the
    // anchor is taken again from the metadata the second drain leaves behind —
    // and a node that is gone falls back the way no active node does.
    try {
      await session.flush("blur");
      const fresh = session.imageInsertionAnchor(input.nodeId) ??
        session.imageInsertionAnchor(null);
      if (!fresh) return null;
      anchor = fresh;
      result = await importOnce(input, anchor);
    } catch (retryCause) {
      session.reportExternalFailure(retryCause);
      return null;
    }
  }

  const created = result.nodeIds.flatMap((nodeId) => {
    const node = result.nodes.find((candidate) => candidate.id === nodeId);
    return node ? [node] : [];
  });
  if (created.length === 0) return null;
  return session.insertImageNodes({
    anchor,
    nodes: created,
    external: {
      undo: () => port.remove(result.nodeIds),
      redo: () => port.restore(result.nodeIds)
    }
  });
}

/**
 * Where a gesture wants its picture: the row a menu was opened on, or the
 * point a drop landed at. Absent means the caret's node.
 */
export type MonacoImageAnchor =
  | { readonly nodeId: string }
  | { readonly clientX: number; readonly clientY: number };

export interface BoundImageIngest {
  /**
   * Runs one gesture and puts the caret on the first picture it drew. The
   * promise rejects with whatever the import refused on, so the pane that
   * caught the gesture can show it — nothing below here has a place to.
   */
  run(
    payload: MonacoImagePayload,
    at?: MonacoImageAnchor | null
  ): Promise<void>;
  /** Highlights the line a drag is over; null takes the highlight down. */
  markDropPoint(at: MonacoImageAnchor | null): void;
  dispose(): void;
}

/**
 * Clipboard and OS drops on the editor host. Monaco owns paste and drop, so an
 * image payload is taken away from it the way a blocked key gesture is; every
 * other payload falls through untouched. The packaged app's file drop arrives
 * as a native window event instead, so `run` is exposed for that caller.
 */
export function bindImageIngest(
  editor: monaco.editor.ICodeEditor,
  deps: {
    readonly session: MonacoImageIngestSession;
    readonly port: MonacoImageIngestPort;
    readonly activeNodeId: () => string | null;
  }
): BoundImageIngest {
  const dropTarget = editor.createDecorationsCollection();
  const lineAt = (at: MonacoImageAnchor): number | null =>
    "nodeId" in at
      ? null
      : editor.getTargetAtClientPoint(at.clientX, at.clientY)
          ?.position?.lineNumber ?? null;
  const nodeIdAt = (at?: MonacoImageAnchor | null): string | null => {
    if (!at) return deps.activeNodeId();
    if ("nodeId" in at) return at.nodeId;
    const lineNumber = lineAt(at);
    const dropped = lineNumber === null
      ? null
      : deps.session.nodeIdAtLine(lineNumber);
    // A drop that hits no line lands where a paste would.
    return dropped ?? deps.activeNodeId();
  };
  const caretLine = (): number | null =>
    editor.getPosition()?.lineNumber ?? null;
  const markDropPoint = (at: MonacoImageAnchor | null): void => {
    // The OS drop's point is window-relative and this window carries its own
    // chrome, so it can resolve to no line at all. The gesture still lands —
    // on the caret's line, the same node `nodeIdAt` falls back to — so the
    // marker goes there rather than nowhere.
    const lineNumber = !at
      ? null
      : lineAt(at) ?? ("nodeId" in at ? null : caretLine());
    traceDrop(at ? "over" : "leave", at, lineNumber);
    dropTarget.set(lineNumber === null ? [] : [{
      range: {
        startLineNumber: lineNumber,
        startColumn: 1,
        endLineNumber: lineNumber,
        endColumn: 1
      },
      options: {
        isWholeLine: true,
        className: "yonalist-outline-drop-target"
      }
    }]);
  };
  const run = async (
    payload: MonacoImagePayload,
    at?: MonacoImageAnchor | null
  ): Promise<void> => {
    markDropPoint(null);
    const nodeId = nodeIdAt(at);
    traceDrop("drop", at ?? null, at ? lineAt(at) : null, nodeId);
    const lineNumber = await ingestImages({
      session: deps.session,
      port: deps.port,
      nodeId,
      payload
    });
    if (lineNumber === null) return;
    editor.setPosition({ lineNumber, column: 1 });
    editor.focus();
  };
  const host = editor.getDomNode();
  if (!host) return { run, markDropPoint, dispose: () => undefined };

  const onPaste = (event: ClipboardEvent): void => {
    if (!event.clipboardData) return;
    const candidates = clipboardImageCandidates(event.clipboardData);
    if (candidates.length === 0) return;
    event.preventDefault();
    event.stopPropagation();
    void run({ candidates }).catch(traceFailure);
  };
  const onDragOver = (event: DragEvent): void => {
    if (droppedImages(event).length === 0) return;
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = "copy";
    markDropPoint(pointOf(event));
  };
  const onDragLeave = (): void => markDropPoint(null);
  const onDrop = (event: DragEvent): void => {
    const candidates = droppedImages(event);
    if (candidates.length === 0) return;
    event.preventDefault();
    event.stopPropagation();
    void run({ candidates }, pointOf(event)).catch(traceFailure);
  };

  host.addEventListener("paste", onPaste, true);
  host.addEventListener("dragover", onDragOver, true);
  host.addEventListener("dragleave", onDragLeave, true);
  host.addEventListener("drop", onDrop, true);
  return {
    run,
    markDropPoint,
    dispose: () => {
      dropTarget.clear();
      host.removeEventListener("paste", onPaste, true);
      host.removeEventListener("dragover", onDragOver, true);
      host.removeEventListener("dragleave", onDragLeave, true);
      host.removeEventListener("drop", onDrop, true);
    }
  };
}

/**
 * The one breadcrumb the packaged app's drop leaves. That gesture never
 * touches the editor's DOM and its point is window-relative, so a point that
 * resolves to the wrong line — or to none — is otherwise invisible.
 * Development only; the branch folds away in a production build.
 */
let tracedLine: number | null = null;
function traceDrop(
  type: "over" | "leave" | "drop",
  at: MonacoImageAnchor | null,
  resolvedLine: number | null,
  anchorNodeId: string | null = null
): void {
  if (!import.meta.env.DEV) return;
  // `over` repeats for every pointer move; only a new line is news.
  if (type === "over" && resolvedLine === tracedLine) return;
  tracedLine = type === "over" ? resolvedLine : null;
  const point = at && "clientX" in at ? at : null;
  console.debug("[yonalist] image drop", {
    type,
    x: point?.clientX ?? null,
    y: point?.clientY ?? null,
    resolvedLine,
    anchorNodeId
  });
}

function traceFailure(cause: unknown): void {
  if (import.meta.env.DEV) console.debug("[yonalist] image drop failed", cause);
}

function payloadSize(payload: MonacoImagePayload): number {
  return "paths" in payload
    ? payload.paths.length
    : payload.candidates.length;
}

function importOnce(
  input: {
    readonly port: MonacoImageIngestPort;
    readonly payload: MonacoImagePayload;
  },
  anchor: ImageInsertionAnchor
): Promise<MonacoImageImportResult> {
  const { parentId, beforeId } = anchor;
  return "paths" in input.payload
    ? input.port.importPaths({
        parentId,
        beforeId,
        paths: input.payload.paths
      })
    : input.port.import({
        parentId,
        beforeId,
        candidates: input.payload.candidates
      });
}

function pointOf(event: DragEvent): MonacoImageAnchor {
  return { clientX: event.clientX, clientY: event.clientY };
}

function droppedImages(event: DragEvent): readonly ImageCandidate[] {
  return event.dataTransfer
    ? imageCandidates([...event.dataTransfer.files])
    : [];
}
