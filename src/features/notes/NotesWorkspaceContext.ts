import { createContext, useContext } from "react";
import type { UseNotesWorkspaceResult } from "./useNotesWorkspace";

export const NotesWorkspaceContext = createContext<UseNotesWorkspaceResult | null>(
  null
);

export function useNotesWorkspaceContext(): UseNotesWorkspaceResult {
  const workspace = useContext(NotesWorkspaceContext);
  if (!workspace) {
    throw new Error("useNotesWorkspaceContext must be used within NotesWorkspaceContext.");
  }
  return workspace;
}
