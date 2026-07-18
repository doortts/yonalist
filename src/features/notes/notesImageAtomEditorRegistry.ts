import type { NoteId } from "../../domain/notes";
import type { LogicalSelection } from "./imageAtomModel";

export type ImageAtomEditorFlushResult = "flushed" | "deferred" | "cancelled";

declare const imageAtomEditorSelectionAuthorityBrand: unique symbol;
declare const notesImageAtomEditorAuthorityBrand: unique symbol;

/** Opaque semantic-selection owner/version; it contains no DOM Selection. */
export interface ImageAtomEditorSelectionAuthority {
  readonly [imageAtomEditorSelectionAuthorityBrand]: true;
}

export interface ImageAtomEditorSelectionSnapshot {
  readonly selection: LogicalSelection;
  readonly authority: ImageAtomEditorSelectionAuthority;
}

/** Opaque active registration plus semantic-selection authority. */
export interface NotesImageAtomEditorAuthority {
  readonly [notesImageAtomEditorAuthorityBrand]: true;
}

interface CapturedNotesImageAtomEditorAuthority
  extends NotesImageAtomEditorAuthority {
  readonly token: symbol;
  readonly editor: ActiveImageAtomEditor;
  readonly selectionAuthority: ImageAtomEditorSelectionAuthority;
}

export interface NotesImageAtomFlushAdapter {
  readonly nodeId: NoteId;
  flush(): Promise<ImageAtomEditorFlushResult>;
  flushAndGetSelection?(): Promise<LogicalSelection | null>;
}

export interface ActiveImageAtomEditor extends NotesImageAtomFlushAdapter {
  flushAndGetSelection(): Promise<LogicalSelection | null>;
  flushAndGetSelectionSnapshot(): Promise<ImageAtomEditorSelectionSnapshot | null>;
  isSelectionAuthorityCurrent(
    authority: ImageAtomEditorSelectionAuthority
  ): boolean;
  claimPaste(event: ClipboardEvent): boolean;
}

export interface NotesImageAtomEditorRegistry {
  register(editor: ActiveImageAtomEditor): () => void;
  active(): ActiveImageAtomEditor | null;
  activeSelection(): Promise<{ nodeId: NoteId; selection: LogicalSelection } | null>;
  capturePasteAuthority(
    nodeId: NoteId,
    selectionAuthority: ImageAtomEditorSelectionAuthority
  ): NotesImageAtomEditorAuthority | null;
  isPasteAuthorityCurrent(authority: NotesImageAtomEditorAuthority): boolean;
  flushAll(): Promise<boolean>;
  claimPaste(event: ClipboardEvent): boolean;
}

export function createNotesImageAtomEditorRegistry(): NotesImageAtomEditorRegistry {
  const registrations: Array<{
    readonly token: symbol;
    readonly editor: ActiveImageAtomEditor;
  }> = [];
  let inFlightFlush: Promise<boolean> | null = null;

  return {
    register(editor) {
      const token = Symbol("image-atom-editor");
      registrations.push({ token, editor });
      return () => {
        const index = registrations.findIndex(
          (registration) => registration.token === token
        );
        if (index >= 0) registrations.splice(index, 1);
      };
    },
    active: () => registrations.at(-1)?.editor ?? null,
    capturePasteAuthority(nodeId, selectionAuthority) {
      const registration = registrations.at(-1);
      if (
        !registration ||
        registration.editor.nodeId !== nodeId ||
        !registration.editor.isSelectionAuthorityCurrent(selectionAuthority)
      ) {
        return null;
      }
      return {
        token: registration.token,
        editor: registration.editor,
        selectionAuthority
      } as unknown as CapturedNotesImageAtomEditorAuthority;
    },
    isPasteAuthorityCurrent(opaque) {
      const authority = opaque as CapturedNotesImageAtomEditorAuthority;
      const registration = registrations.at(-1);
      return Boolean(
        registration &&
          registration.token === authority.token &&
          registration.editor === authority.editor &&
          registration.editor.isSelectionAuthorityCurrent(
            authority.selectionAuthority
          )
      );
    },
    async activeSelection() {
      const registration = registrations.at(-1);
      if (!registration) return null;
      let selection: LogicalSelection | null;
      try {
        selection = await registration.editor.flushAndGetSelection();
      } catch {
        return null;
      }
      if (!selection) return null;
      const current = registrations.at(-1);
      if (
        current?.token !== registration.token ||
        !registrations.some(({ token }) => token === registration.token)
      ) {
        return null;
      }
      return { nodeId: registration.editor.nodeId, selection };
    },
    flushAll() {
      if (inFlightFlush) return inFlightFlush;
      const flushed = new Set<symbol>();
      const completion = (async () => {
        let succeeded = true;
        while (true) {
          const batch = registrations.filter(({ token }) => !flushed.has(token));
          if (batch.length === 0) return succeeded;
          for (const { token } of batch) flushed.add(token);
          const results = await Promise.all(
            batch.map(async ({ editor }) => {
              try {
                return await editor.flush();
              } catch {
                return "cancelled" as const;
              }
            })
          );
          if (results.some((result) => result === "cancelled")) {
            succeeded = false;
          }
        }
      })();
      inFlightFlush = completion;
      void completion.then(
        () => {
          if (inFlightFlush === completion) inFlightFlush = null;
        },
        () => {
          if (inFlightFlush === completion) inFlightFlush = null;
        }
      );
      return completion;
    },
    claimPaste(event) {
      return registrations.at(-1)?.editor.claimPaste(event) ?? false;
    }
  };
}
