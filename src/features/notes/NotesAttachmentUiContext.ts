import { createContext, useContext } from "react";
import {
  nativeNotesAttachmentUi,
  type NotesAttachmentUiBoundary
} from "./notesAttachmentController";

export const NotesAttachmentUiContext =
  createContext<NotesAttachmentUiBoundary>(nativeNotesAttachmentUi);

export function useNotesAttachmentUi(): NotesAttachmentUiBoundary {
  return useContext(NotesAttachmentUiContext);
}
