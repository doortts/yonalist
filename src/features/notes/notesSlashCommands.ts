import type { LocalDate } from "./noteDates";
import { formatLocalDateIso } from "./noteDates";

import type { NoteMarkerKind } from "../../domain/notes";

export type NotesSlashCommandId = "today" | "todo";

export interface NotesSlashCommandDefinition {
  readonly id: NotesSlashCommandId;
  readonly label: string;
  readonly description: string;
}

export interface NotesSlashCommandQuery {
  readonly startUtf16: 0;
  readonly endUtf16: number;
  readonly query: string;
}

interface NotesSlashCommandEditBase {
  readonly value: string;
  readonly caretUtf16: number;
}

export type NotesSlashCommandEdit =
  | (NotesSlashCommandEditBase & { readonly kind: "text" })
  | (NotesSlashCommandEditBase & {
      readonly kind: "marker";
      readonly markerKind: NoteMarkerKind;
    });

export const notesSlashCommandDefinitions = [
  {
    id: "today",
    label: "Today",
    description: "Insert today's date"
  },
  {
    id: "todo",
    label: "To-do",
    description: "Change this bullet to a To-do"
  }
] as const satisfies readonly NotesSlashCommandDefinition[];

export function resolveNotesSlashCommandQuery(
  value: string,
  selectionStart: number | null,
  selectionEnd: number | null
): NotesSlashCommandQuery | null {
  if (
    selectionStart === null ||
    selectionEnd === null ||
    selectionStart !== selectionEnd ||
    selectionEnd < 1 ||
    selectionEnd > value.length ||
    value[0] !== "/"
  ) {
    return null;
  }
  const query = value.slice(1, selectionEnd);
  if (!/^[a-z]*$/iu.test(query)) {
    return null;
  }
  return { startUtf16: 0, endUtf16: selectionEnd, query };
}

export function filterNotesSlashCommands(
  query: string
): readonly NotesSlashCommandDefinition[] {
  const normalized = query.toLocaleLowerCase("en-US").replaceAll("-", "");
  return notesSlashCommandDefinitions.filter((command) =>
    command.label
      .toLocaleLowerCase("en-US")
      .replaceAll("-", "")
      .startsWith(normalized)
  );
}

export function applyNotesSlashCommand(
  source: string,
  query: NotesSlashCommandQuery,
  commandId: NotesSlashCommandId,
  today: LocalDate
): NotesSlashCommandEdit {
  if (
    query.startUtf16 !== 0 ||
    !Number.isSafeInteger(query.endUtf16) ||
    query.endUtf16 < 1 ||
    query.endUtf16 > source.length ||
    source.slice(0, query.endUtf16) !== `/${query.query}`
  ) {
    throw new Error("Slash command query no longer matches the source value.");
  }

  if (commandId === "todo") {
    return {
      kind: "marker",
      markerKind: "todo",
      value: source.slice(query.endUtf16),
      caretUtf16: 0
    };
  }
  const replacement = formatLocalDateIso(today);
  return {
    kind: "text",
    value: replacement + source.slice(query.endUtf16),
    caretUtf16: replacement.length
  };
}
