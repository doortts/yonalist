const CLIPBOARD_FAILURE_MESSAGE = "The clipboard could not be written.";

export type NotesClipboardWriteOutcome =
  | {
      readonly kind: "success";
      readonly method: "event" | "multiMime" | "plainText";
    }
  | { readonly kind: "failure"; readonly message: string };

export interface NotesClipboardEvent {
  readonly clipboardData: {
    setData(type: string, value: string): void;
  } | null;
  preventDefault(): void;
}

interface NotesClipboardApi {
  write?(items: ClipboardItem[]): Promise<void>;
  writeText?(text: string): Promise<void>;
}

export interface NotesClipboardItemConstructor {
  new (items: Record<string, Blob>): ClipboardItem;
  supports?(type: string): boolean;
}

interface NotesBlobConstructor {
  new (parts?: BlobPart[], options?: BlobPropertyBag): Blob;
}

/** Browser capabilities are injected by the UI boundary for deterministic tests. */
export interface NotesClipboardGlobals {
  readonly clipboard?: NotesClipboardApi;
  readonly ClipboardItem?: NotesClipboardItemConstructor;
  readonly Blob?: NotesBlobConstructor;
}

function clipboardFailure(): NotesClipboardWriteOutcome {
  return { kind: "failure", message: CLIPBOARD_FAILURE_MESSAGE };
}

/**
 * Writes during a native copy/cut event. Clipboard event mutation must remain
 * synchronous, so this API intentionally does not return a promise.
 */
export function writeNotesClipboardEvent(
  event: NotesClipboardEvent,
  text: string
): NotesClipboardWriteOutcome {
  if (event.clipboardData === null) {
    return clipboardFailure();
  }

  try {
    event.clipboardData.setData("text/plain", text);
    event.clipboardData.setData("text/markdown", text);
    event.preventDefault();
    return { kind: "success", method: "event" };
  } catch {
    return clipboardFailure();
  }
}

/**
 * Writes toolbar copy/cut text. Multi-MIME ClipboardItem support is preferred;
 * `writeText` is attempted whenever that path is unavailable or rejects.
 */
export async function writeNotesClipboardText(
  text: string,
  globals: NotesClipboardGlobals
): Promise<NotesClipboardWriteOutcome> {
  const { clipboard, ClipboardItem, Blob } = globals;

  if (
    clipboard?.write !== undefined &&
    ClipboardItem !== undefined &&
    Blob !== undefined
  ) {
    try {
      const item = new ClipboardItem({
        "text/plain": new Blob([text], { type: "text/plain" }),
        "text/markdown": new Blob([text], { type: "text/markdown" })
      });
      await clipboard.write([item]);
      return { kind: "success", method: "multiMime" };
    } catch {
      // A supported rich write can still be denied. The plain-text capability
      // remains a valid fallback and must be attempted before reporting failure.
    }
  }

  if (clipboard?.writeText !== undefined) {
    try {
      await clipboard.writeText(text);
      return { kind: "success", method: "plainText" };
    } catch {
      return clipboardFailure();
    }
  }

  return clipboardFailure();
}
