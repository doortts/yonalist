import type {
  NotesWorkspaceCommandOutcome,
  NotesWorkspaceCoordinatorSession
} from "./notesWorkspaceCoordinator";
import type { BufferedWorkspaceCommand } from "./useNotesHistoryController";

export function resolveBufferedWorkspaceCommands(
  commands: BufferedWorkspaceCommand[]
): void {
  for (const command of commands) command.resolve("skipped");
}

export function enqueueBufferedWorkspaceCommands(
  session: NotesWorkspaceCoordinatorSession,
  commands: BufferedWorkspaceCommand[]
): void {
  for (const command of commands) {
    let completion: Promise<NotesWorkspaceCommandOutcome>;
    try {
      completion = command.structural
        ? session.enqueueStructural(command.work, {
            selectionPolicy: command.selectionPolicy
          })
        : session.enqueue(command.work);
    } catch {
      command.resolve("skipped");
      continue;
    }
    void completion.then(command.resolve, () => command.resolve("failed"));
  }
}
