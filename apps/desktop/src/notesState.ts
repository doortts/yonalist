import type { NoteView } from "../../../packages/contracts/generated/NoteView";
import type { PageSummary } from "../../../packages/contracts/generated/PageSummary";

export interface NotesState {
  readonly status: "idle" | "loading" | "ready" | "error";
  readonly sessionId: string | null;
  readonly revision: number;
  readonly pages: readonly PageSummary[];
  readonly activePageId: string | null;
  readonly nodes: readonly NoteView[];
  /** The active page's own node, which `nodes` never lists. */
  readonly pageNode: NoteView | null;
  /**
   * The open page nobody has written into yet. It exists in this window and
   * nowhere else until the first command reaches it.
   */
  readonly provisionalPageId: string | null;
  readonly drafts: Readonly<Record<string, string>>;
  readonly noteDrafts: Readonly<Record<string, string>>;
  readonly canUndo: boolean;
  readonly canRedo: boolean;
  readonly undoDepth: number;
  readonly redoDepth: number;
  readonly beforeCursor: string | null;
  readonly afterCursor: string | null;
  readonly error: string | null;
  readonly pendingWrites: number;
}

export const initialNotesState: NotesState = {
  status: "idle",
  sessionId: null,
  revision: 0,
  pages: [],
  activePageId: null,
  nodes: [],
  pageNode: null,
  provisionalPageId: null,
  drafts: {},
  noteDrafts: {},
  canUndo: false,
  canRedo: false,
  undoDepth: 0,
  redoDepth: 0,
  beforeCursor: null,
  afterCursor: null,
  error: null,
  pendingWrites: 0
};
