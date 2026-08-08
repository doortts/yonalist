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
  remove(nodeIds: readonly string[]): Promise<void>;
  restore(nodeIds: readonly string[]): Promise<void>;
}

/** The part of the session an ingest touches. */
export interface MonacoImageIngestSession {
  canAcceptStructuralEdit(): boolean;
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
 * refused. A validation failure propagates — the store surfaces its message.
 */
export async function ingestImages(input: {
  readonly session: MonacoImageIngestSession;
  readonly port: MonacoImageIngestPort;
  readonly nodeId: string | null;
  readonly candidates: readonly ImageCandidate[];
}): Promise<number | null> {
  const { session, port } = input;
  if (input.candidates.length === 0) return null;
  if (!session.canAcceptStructuralEdit()) return null;
  const anchor = session.imageInsertionAnchor(input.nodeId);
  if (!anchor) return null;

  let result: MonacoImageImportResult;
  try {
    result = await importOnce(input, anchor);
  } catch (cause) {
    if (!hasErrorCode(cause, "revision_conflict")) throw cause;
    // One retry: the flush above raced a write the queue had not yet drained.
    try {
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
 * Clipboard and OS drops on the editor host. Monaco owns paste and drop, so an
 * image payload is taken away from it the way a blocked key gesture is; every
 * other payload falls through untouched.
 */
export function bindImageIngest(
  editor: monaco.editor.ICodeEditor,
  deps: {
    readonly session: MonacoImageIngestSession;
    readonly port: MonacoImageIngestPort;
    readonly activeNodeId: () => string | null;
  }
): () => void {
  const host = editor.getDomNode();
  if (!host) return () => undefined;

  const run = (candidates: readonly ImageCandidate[]): void => {
    void ingestImages({
      session: deps.session,
      port: deps.port,
      nodeId: deps.activeNodeId(),
      candidates
    }).then((lineNumber) => {
      if (lineNumber === null) return;
      editor.setPosition({ lineNumber, column: 1 });
      editor.focus();
    }).catch(() => undefined);
  };

  const onPaste = (event: ClipboardEvent): void => {
    if (!event.clipboardData) return;
    const candidates = clipboardImageCandidates(event.clipboardData);
    if (candidates.length === 0) return;
    event.preventDefault();
    event.stopPropagation();
    run(candidates);
  };
  const onDragOver = (event: DragEvent): void => {
    if (droppedImages(event).length === 0) return;
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = "copy";
  };
  const onDrop = (event: DragEvent): void => {
    const candidates = droppedImages(event);
    if (candidates.length === 0) return;
    event.preventDefault();
    event.stopPropagation();
    run(candidates);
  };

  host.addEventListener("paste", onPaste, true);
  host.addEventListener("dragover", onDragOver, true);
  host.addEventListener("drop", onDrop, true);
  return () => {
    host.removeEventListener("paste", onPaste, true);
    host.removeEventListener("dragover", onDragOver, true);
    host.removeEventListener("drop", onDrop, true);
  };
}

function importOnce(
  input: {
    readonly session: MonacoImageIngestSession;
    readonly port: MonacoImageIngestPort;
    readonly candidates: readonly ImageCandidate[];
  },
  anchor: ImageInsertionAnchor
): Promise<MonacoImageImportResult> {
  return input.session.flush("blur").then(() => input.port.import({
    parentId: anchor.parentId,
    beforeId: anchor.beforeId,
    candidates: input.candidates
  }));
}

function droppedImages(event: DragEvent): readonly ImageCandidate[] {
  return event.dataTransfer
    ? imageCandidates([...event.dataTransfer.files])
    : [];
}
