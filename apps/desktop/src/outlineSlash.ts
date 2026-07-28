export type SlashCommandId = "today" | "todo";

export interface SlashCommandDefinition {
  readonly id: SlashCommandId;
  readonly label: string;
  readonly description: string;
}

export interface SlashCommandQuery {
  readonly start: 0;
  readonly end: number;
  readonly query: string;
}

export interface SlashCommandEdit {
  readonly value: string;
  readonly caret: number;
  readonly marker: "todo" | null;
}

export const slashCommands = [
  { id: "today", label: "Today", description: "Insert today's date" },
  { id: "todo", label: "To-do", description: "Change this bullet to a To-do" }
] as const satisfies readonly SlashCommandDefinition[];

export function resolveSlashCommandQuery(
  value: string,
  selectionStart: number | null,
  selectionEnd: number | null
): SlashCommandQuery | null {
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
  return /^[a-z]*$/iu.test(query)
    ? { start: 0, end: selectionEnd, query }
    : null;
}

export function filterSlashCommands(
  query: string
): readonly SlashCommandDefinition[] {
  const normalized = query.toLocaleLowerCase("en-US").replaceAll("-", "");
  return slashCommands.filter((command) =>
    command.label
      .toLocaleLowerCase("en-US")
      .replaceAll("-", "")
      .startsWith(normalized)
  );
}

export function applySlashCommand(
  source: string,
  query: SlashCommandQuery,
  command: SlashCommandId,
  today: string
): SlashCommandEdit {
  if (
    source.slice(query.start, query.end) !== `/${query.query}` ||
    !/^\d{4}-\d{2}-\d{2}$/u.test(today)
  ) {
    throw new Error("Slash command query no longer matches the source value.");
  }
  if (command === "todo") {
    return {
      value: source.slice(query.end),
      caret: 0,
      marker: "todo"
    };
  }
  return {
    value: today + source.slice(query.end),
    caret: today.length,
    marker: null
  };
}

export function localDateIso(date = new Date()): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}
