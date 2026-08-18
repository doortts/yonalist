import { readTodoBox, type TodoBox } from "./outlineClipboard";

export type SlashCommandId = "today" | "todo";

export interface SlashCommandDefinition {
  readonly id: SlashCommandId;
  readonly label: string;
  readonly description: string;
  /** What the menu draws beside it, which is not always what the id says. */
  readonly icon: "today" | "todo" | "bullet";
  /** Other names the query may reach this command by. */
  readonly aliases?: readonly string[];
}

export interface SlashCommandQuery {
  /** Where the slash stands. */
  readonly start: number;
  readonly end: number;
  readonly query: string;
}

export interface SlashCommandEdit {
  readonly value: string;
  readonly caret: number;
  readonly marker: "todo" | "bullet" | null;
  /** Set only where the marker's own change decides it. */
  readonly completed?: boolean;
}

export const slashCommands = [
  {
    id: "today",
    label: "Today",
    description: "Insert today's date",
    icon: "today"
  },
  {
    id: "todo",
    label: "To-do",
    description: "Change this bullet to a To-do",
    icon: "todo"
  }
] as const satisfies readonly SlashCommandDefinition[];

/**
 * What the menu offers a row wearing this marker. A row that is already a
 * To-do has nothing to gain from being offered one, so that entry becomes the
 * way back: same command, opposite direction, named for where it goes.
 */
function slashCommandsFor(
  marker: string | undefined
): readonly SlashCommandDefinition[] {
  if (marker !== "todo") return slashCommands;
  return slashCommands.map((command) => command.id === "todo"
    ? {
        id: command.id,
        label: "Change to bullet",
        description: "Take this To-do back to a plain bullet",
        icon: "bullet",
        // The reader who types the command's name should not have to know it
        // is named for where it goes on a row that already went.
        aliases: [command.label]
      }
    : command);
}

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

/**
 * A Markdown ordered-list prefix: digits, a dot, and the space that finishes
 * it. The number is the one the run starts at, so `3. ` opens a run at three.
 */
const orderedPrefix = /^(\d{1,9})\.[ \t]/u;

export interface OrderedEdit {
  readonly value: string;
  readonly caret: number;
  readonly start: number;
}

/**
 * The numbered marker a keystroke just finished at the start of a title. Same
 * shape as the task box above: the caret has to stand right after the prefix,
 * which is what makes this the keystroke that finished it, and a row whose
 * previous value already carried one is being edited, not marked.
 */
export function resolveOrderedInput(
  value: string,
  selectionStart: number | null,
  selectionEnd: number | null,
  previous: string
): OrderedEdit | null {
  if (selectionStart === null || selectionStart !== selectionEnd) return null;
  if (orderedPrefix.test(previous)) return null;
  const prefix = orderedPrefix.exec(value);
  if (!prefix || selectionStart !== prefix[0].length) return null;
  return {
    value: value.slice(prefix[0].length),
    caret: 0,
    start: Number(prefix[1])
  };
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
  | { readonly kind: "ordered"; readonly edit: OrderedEdit }
  | { readonly kind: "slash"; readonly query: SlashCommandQuery };

/**
 * The one question a title's own field asks of a change: does it finish a task
 * box or a numbered prefix, does it stand in a slash query, or is it just text.
 * The markers go first -- a row taking one is not typing a command.
 */
export function resolveTitleInput(
  previous: string,
  change: TitleChange
): TitleInput | null {
  const edit = resolveTodoBoxInput(
    change.value, change.selectionStart, change.selectionEnd, previous
  );
  if (edit) return { kind: "box", edit };
  const ordered = resolveOrderedInput(
    change.value, change.selectionStart, change.selectionEnd, previous
  );
  if (ordered) return { kind: "ordered", edit: ordered };
  const query = resolveSlashCommandQuery(
    change.value, change.selectionStart, change.selectionEnd
  );
  return query ? { kind: "slash", query } : null;
}

/**
 * The query the caret stands in, wherever in the row that is. A command opens
 * at a slash that begins a word -- the row's first character, or one after a
 * space -- so the slashes people write inside words stay punctuation:
 * `and/or`, `https://`, a date written `7/28`.
 */
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
    selectionEnd > value.length
  ) {
    return null;
  }
  const typed = value.slice(0, selectionEnd);
  const start = typed.lastIndexOf("/");
  if (start < 0) return null;
  const before = start === 0 ? "" : typed[start - 1];
  if (before !== "" && !/\s/u.test(before)) return null;
  const query = typed.slice(start + 1);
  if (!/^[a-z]*$/iu.test(query)) return null;
  // A slash with nothing typed after it is a slash. Only the row that opens
  // with one is unambiguously reaching for a command rather than writing one
  // -- everywhere else, Enter on a bare slash would convert the row instead of
  // starting the next one.
  if (query.length === 0 && start > 0) return null;
  return { start, end: selectionEnd, query };
}

const recentKey = "yonalist.slashCommandOrder.v1";

/**
 * The commands this reader reached for, most recent first. A menu of two is
 * short enough to read either way; what this saves is the reader who always
 * wants the same one having to look for where it landed.
 */
function recentSlashCommands(): readonly string[] {
  try {
    const raw = window.localStorage.getItem(recentKey);
    const parsed: unknown = raw ? JSON.parse(raw) : null;
    return Array.isArray(parsed)
      ? parsed.filter((id): id is string => typeof id === "string")
      : [];
  } catch {
    // No storage, or nothing readable in it: the declared order stands.
    return [];
  }
}

/**
 * The commands the reader has reached for, first. Their own step rather than
 * the filter's business: what the query leaves is a question about the query,
 * and what order it comes in is a question about this reader.
 */
export function orderSlashCommands(
  commands: readonly SlashCommandDefinition[],
  recent: readonly string[] = recentSlashCommands()
): readonly SlashCommandDefinition[] {
  // A command nobody has reached for sorts after every one that has, and keeps
  // the order it was declared in among its own kind.
  const reachedFor = (command: SlashCommandDefinition) => {
    const place = recent.indexOf(command.id);
    return place < 0 ? recent.length : place;
  };
  return [...commands].sort(
    (left, right) => reachedFor(left) - reachedFor(right)
  );
}

export function rememberSlashCommand(id: SlashCommandId): void {
  const order = [id, ...recentSlashCommands().filter((seen) => seen !== id)];
  try {
    window.localStorage.setItem(recentKey, JSON.stringify(order));
  } catch {
    // The menu still runs the command; only the order is forgotten.
  }
}

export function filterSlashCommands(
  query: string,
  marker?: string
): readonly SlashCommandDefinition[] {
  const normalized = query.toLocaleLowerCase("en-US").replaceAll("-", "");
  const named = (name: string) => name
    .toLocaleLowerCase("en-US")
    .replaceAll("-", "")
    .startsWith(normalized);
  return slashCommandsFor(marker).filter((command) =>
    named(command.label) || (command.aliases ?? []).some(named)
  );
}

export function applySlashCommand(
  source: string,
  query: SlashCommandQuery,
  command: SlashCommandId,
  today: string,
  /** What the row wears now, which is what the To-do command answers to. */
  marker?: string
): SlashCommandEdit {
  if (
    source.slice(query.start, query.end) !== `/${query.query}` ||
    !/^\d{4}-\d{2}-\d{2}$/u.test(today)
  ) {
    throw new Error("Slash command query no longer matches the source value.");
  }
  const before = source.slice(0, query.start);
  const after = source.slice(query.end);
  if (command === "todo") {
    // A row that goes back to a bullet leaves the tick behind with the box:
    // a finished row with no box to untick draws a line through itself and
    // gives the reader nothing to undo it with.
    return marker === "todo"
      ? { value: before + after, caret: query.start, marker: "bullet", completed: false }
      : { value: before + after, caret: query.start, marker: "todo" };
  }
  return {
    value: before + today + after,
    caret: query.start + today.length,
    marker: null
  };
}

export function localDateIso(date = new Date()): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}
