import type { NoteId, NotesHistoryContext, NotesStore } from "../../../domain/notes";

export type NotesRepositoryOperation = {
  [K in keyof NotesStore]: NotesStore[K] extends (...args: never[]) => unknown
    ? K
    : never;
}[keyof NotesStore];

export interface NotesRepositoryEvent {
  readonly sequence: number;
  readonly operation: NotesRepositoryOperation;
  readonly vaultRoot: string | null;
  readonly nodeId: NoteId | null;
  readonly historyEntryId: string | null;
  readonly historySessionId: string | null;
  readonly commandKind: string | null;
  readonly input: unknown;
  readonly arguments: readonly unknown[];
}

export interface NotesRepositoryEvents {
  readonly all: readonly NotesRepositoryEvent[];
  for(operation: NotesRepositoryOperation): readonly NotesRepositoryEvent[];
  clear(): void;
}

function nodeIdFrom(input: unknown): NoteId | null {
  if (typeof input === "string") return input as NoteId;
  if (typeof input !== "object" || input === null) return null;
  if ("nodeId" in input && typeof input.nodeId === "string") {
    return input.nodeId as NoteId;
  }
  if ("id" in input && typeof input.id === "string") return input.id as NoteId;
  return null;
}

function historyContextFrom(args: readonly unknown[]): NotesHistoryContext | null {
  return (
    args.find(
    (argument): argument is NotesHistoryContext =>
      typeof argument === "object" &&
      argument !== null &&
      "entryId" in argument &&
      typeof argument.entryId === "string"
    ) ?? null
  );
}

/**
 * Records semantic repository events without exposing Vitest call ordinals.
 *
 * Use `events.for(operation)` for inputs/history grouping and `events.all` only
 * when persistence order is itself product behavior. Indexed `mock.calls` is
 * reserved for identities a semantic event cannot represent, such as Blobs or
 * deferred resolvers.
 */
export function journalNotesRepository<TRepository extends NotesStore>(
  source: TRepository
): { repository: TRepository; events: NotesRepositoryEvents } {
  const journal: NotesRepositoryEvent[] = [];
  const wrappers = new Map<PropertyKey, unknown>();
  const events: NotesRepositoryEvents = {
    get all() {
      return journal;
    },
    for(operation) {
      return journal.filter((event) => event.operation === operation);
    },
    clear() {
      journal.length = 0;
    }
  };
  const repository = new Proxy(source, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver);
      if (typeof property !== "string" || typeof value !== "function") return value;

      const cached = wrappers.get(property);
      if (cached) return cached;

      const wrapped = (...args: unknown[]) => {
        const historyContext = historyContextFrom(args);
        journal.push({
          sequence: journal.length,
          operation: property as NotesRepositoryOperation,
          vaultRoot: typeof args[0] === "string" ? args[0] : null,
          nodeId: nodeIdFrom(args[1]),
          historyEntryId: historyContext?.entryId ?? null,
          historySessionId: historyContext?.sessionId ?? null,
          commandKind: historyContext?.commandKind ?? null,
          input: args[1],
          arguments: args
        });
        return Reflect.apply(value, target, args);
      };
      wrappers.set(property, wrapped);
      return wrapped;
    }
  });

  return { repository, events };
}
