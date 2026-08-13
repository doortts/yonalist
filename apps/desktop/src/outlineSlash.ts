import { readTodoBox, type TodoBox } from "./outlineClipboard";

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

/**
 * The box a title's start reads as, the bare pair `[]` included: that is what a
 * hand types when it does not stop to put the space in. Only the typed path
 * takes it -- GFM writes a character between the brackets, so a paste that read
 * the pair as a box would eat characters nobody meant as one.
 */
function readTypedBox(content: string): TodoBox | null {
  return readTodoBox(
    content.startsWith("[]") ? `[ ]${content.slice(2)}` : content
  );
}

export interface TodoBoxEdit {
  readonly value: string;
  readonly caret: number;
  readonly completed: boolean;
}

/**
 * The box a keystroke just finished at the very start of a title, or `null`.
 * The space is required, so a title that has to read `[ ] something` is still
 * typeable; the caret has to stand right after it, which is what makes this the
 * keystroke that completed the box rather than an edit somewhere else in the row.
 * `previous` is the value the row held before this change: a row that already
 * carried a whole box carries it as characters, so no edit inside such a row can
 * be the keystroke that finished one, whatever the caret ends up next to.
 */
export function resolveTodoBoxInput(
  value: string,
  selectionStart: number | null,
  selectionEnd: number | null,
  previous: string
): TodoBoxEdit | null {
  if (selectionStart === null || selectionStart !== selectionEnd) return null;
  if (readTypedBox(previous)?.spaced) return null;
  const box = readTypedBox(value);
  // The offsets are the row's own: `rest` is a suffix of it either way.
  if (!box?.spaced || selectionStart !== value.length - box.rest.length) {
    return null;
  }
  return { value: box.rest, caret: 0, completed: box.completed };
}

/** What the two policies below read off the field the change landed in. */
export interface TitleChange {
  readonly value: string;
  readonly selectionStart: number | null;
  readonly selectionEnd: number | null;
}

/** What one change to a title is, once both policies have had it. */
export type TitleInput =
  | { readonly kind: "box"; readonly edit: TodoBoxEdit }
  | { readonly kind: "slash"; readonly query: SlashCommandQuery };

/**
 * The one question a title's own field asks of a change: does it finish a task
 * box, does it stand in a slash query, or is it just text. The box goes first --
 * a row taking a marker is not typing a command.
 */
export function resolveTitleInput(
  previous: string,
  change: TitleChange
): TitleInput | null {
  const edit = resolveTodoBoxInput(
    change.value, change.selectionStart, change.selectionEnd, previous
  );
  if (edit) return { kind: "box", edit };
  // A caret reported at the start of a value that already begins with `/` says
  // nothing about where the query ends, so the whole value is the query.
  const caret = change.selectionStart === 0 && change.value.startsWith("/")
    ? change.value.length
    : change.selectionStart;
  const query = resolveSlashCommandQuery(change.value, caret, caret);
  return query ? { kind: "slash", query } : null;
}

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
