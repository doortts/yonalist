import { describe, expectTypeOf, it } from "vitest";
import type {
  NotesWorkspaceActions,
  UseNotesWorkspaceHookResult,
  UseNotesWorkspaceOptions
} from "./notesWorkspaceTypes";

describe("notesWorkspaceTypes", () => {
  it("exposes the stable hook contract without importing the runtime", () => {
    expectTypeOf<UseNotesWorkspaceOptions>().toHaveProperty("repository");
    expectTypeOf<NotesWorkspaceActions>().toHaveProperty("createRoot");
    expectTypeOf<UseNotesWorkspaceHookResult>().toHaveProperty("stateSlice");
  });
});
