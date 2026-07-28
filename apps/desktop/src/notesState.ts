import type { NoteView } from "../../../packages/contracts/generated/NoteView";
import type { PageSummary } from "../../../packages/contracts/generated/PageSummary";

export interface NotesState {
  readonly status: "idle" | "loading" | "ready" | "error";
  readonly sessionId: string | null;
  readonly revision: number;
  readonly pages: readonly PageSummary[];
  readonly activePageId: string | null;
  readonly nodes: readonly NoteView[];
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
