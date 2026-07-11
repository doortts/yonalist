import type {
  NoteSearchTag,
  NoteStructuredSearchQuery,
  NoteTagPrefix
} from "../../domain/notes";
import { tokenizeNoteText } from "./noteTokens";

export const NOTE_SEARCH_QUERY_LIMITS = {
  maxTextUtf8Bytes: 4096,
  maxUniqueTagAlternatives: 64,
  maxOrGroups: 16,
  maxAlternativesPerOrGroup: 16
} as const;

export type NoteSearchQueryValidationErrorCode =
  | "textTooLong"
  | "tooManyUniqueTags"
  | "tooManyOrGroups"
  | "tooManyOrAlternatives";

export type NoteSearchQueryValidationResult =
  | { ok: true; query: NoteStructuredSearchQuery }
  | {
      ok: false;
      error: {
        code: NoteSearchQueryValidationErrorCode;
        message: string;
      };
    };

function tagKey(tag: Pick<NoteSearchTag, "prefix" | "normalizedTag">): string {
  return `${tag.prefix}\u0000${tag.normalizedTag}`;
}

function compareTags(left: NoteSearchTag, right: NoteSearchTag): number {
  const leftKey = tagKey(left);
  const rightKey = tagKey(right);
  return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
}

function normalizeDisplay(displayTag: string, normalizedTag: string): string {
  const display = displayTag.trim().replace(/^[#@]/u, "");
  return display || normalizedTag;
}

function canonicalTag(tag: NoteSearchTag): NoteSearchTag | null {
  const normalizedTag = tag.normalizedTag
    .trim()
    .replace(/^[#@]/u, "")
    .toLowerCase();
  if (!normalizedTag) {
    return null;
  }
  return {
    prefix: tag.prefix,
    normalizedTag,
    displayTag: normalizeDisplay(tag.displayTag, normalizedTag)
  };
}

function canonicalTags(tags: readonly NoteSearchTag[]): NoteSearchTag[] {
  const byKey = new Map<string, NoteSearchTag>();
  for (const source of tags) {
    const tag = canonicalTag(source);
    if (!tag) {
      continue;
    }
    const key = tagKey(tag);
    const existing = byKey.get(key);
    if (!existing || tag.displayTag < existing.displayTag) {
      byKey.set(key, tag);
    }
  }
  return [...byKey.values()].sort(compareTags);
}

function canonicalText(text: string): string {
  return text.trim().split(/\s+/u).filter(Boolean).join(" ");
}

export function canonicalizeNoteSearchQuery(
  query: NoteStructuredSearchQuery
): NoteStructuredSearchQuery {
  const requiredTags = canonicalTags(query.requiredTags);
  const groupsByKey = new Map<string, NoteSearchTag[]>();

  for (const sourceGroup of query.orGroups) {
    const group = canonicalTags(sourceGroup);
    if (group.length === 0) {
      continue;
    }
    if (group.length === 1) {
      requiredTags.push(group[0]);
      continue;
    }
    const key = group.map(tagKey).join("\u0001");
    const existing = groupsByKey.get(key);
    groupsByKey.set(key, existing ? canonicalTags([...existing, ...group]) : group);
  }

  return {
    text: canonicalText(query.text),
    requiredTags: canonicalTags(requiredTags),
    excludedTags: canonicalTags(query.excludedTags),
    orGroups: [...groupsByKey.entries()]
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([, group]) => group)
  };
}

function validationError(
  code: NoteSearchQueryValidationErrorCode,
  message: string
): NoteSearchQueryValidationResult {
  return { ok: false, error: { code, message } };
}

export function validateAndCanonicalizeNoteSearchQuery(
  query: NoteStructuredSearchQuery
): NoteSearchQueryValidationResult {
  if (
    new TextEncoder().encode(query.text).length >
    NOTE_SEARCH_QUERY_LIMITS.maxTextUtf8Bytes
  ) {
    return validationError(
      "textTooLong",
      "Structured Notes search text exceeds 4096 UTF-8 bytes."
    );
  }
  if (query.orGroups.length > NOTE_SEARCH_QUERY_LIMITS.maxOrGroups) {
    return validationError(
      "tooManyOrGroups",
      "Structured Notes search has more than 16 OR groups."
    );
  }
  if (
    query.orGroups.some(
      (group) =>
        group.length > NOTE_SEARCH_QUERY_LIMITS.maxAlternativesPerOrGroup
    )
  ) {
    return validationError(
      "tooManyOrAlternatives",
      "Structured Notes search OR group has more than 16 alternatives."
    );
  }

  const canonical = canonicalizeNoteSearchQuery(query);
  const uniqueTags = new Set([
    ...canonical.requiredTags.map(tagKey),
    ...canonical.excludedTags.map(tagKey),
    ...canonical.orGroups.flatMap((group) => group.map(tagKey))
  ]);
  if (uniqueTags.size > NOTE_SEARCH_QUERY_LIMITS.maxUniqueTagAlternatives) {
    return validationError(
      "tooManyUniqueTags",
      "Structured Notes search has more than 64 unique tag alternatives."
    );
  }

  return { ok: true, query: canonical };
}

interface ParsedClause {
  excluded: boolean;
  tag: NoteSearchTag;
}

function parseTagClause(term: string): ParsedClause | null {
  const excluded = term.startsWith("-");
  const source = excluded ? term.slice(1) : term;
  const tokens = tokenizeNoteText(source);
  if (
    tokens.length !== 1 ||
    tokens[0].kind !== "tag" ||
    tokens[0].raw !== source
  ) {
    return null;
  }

  return {
    excluded,
    tag: {
      prefix: tokens[0].prefix as NoteTagPrefix,
      normalizedTag: tokens[0].normalized,
      displayTag: tokens[0].display
    }
  };
}

function parseRawNoteSearchQuery(source: string): NoteStructuredSearchQuery {
  const terms = source.trim() ? source.trim().split(/\s+/u) : [];
  const consumed = new Set<number>();
  const orGroups: NoteSearchTag[][] = [];

  for (let index = 0; index + 2 < terms.length; index += 1) {
    if (consumed.has(index)) {
      continue;
    }
    const first = parseTagClause(terms[index]);
    const second = parseTagClause(terms[index + 2]);
    if (
      !first ||
      first.excluded ||
      terms[index + 1] !== "OR" ||
      !second ||
      second.excluded
    ) {
      continue;
    }

    const group = [first.tag, second.tag];
    consumed.add(index);
    consumed.add(index + 1);
    consumed.add(index + 2);
    let end = index + 2;
    while (end + 2 < terms.length && terms[end + 1] === "OR") {
      const alternative = parseTagClause(terms[end + 2]);
      if (!alternative || alternative.excluded) {
        break;
      }
      group.push(alternative.tag);
      consumed.add(end + 1);
      consumed.add(end + 2);
      end += 2;
    }
    orGroups.push(group);
    index = end;
  }

  const textTerms: string[] = [];
  const requiredTags: NoteSearchTag[] = [];
  const excludedTags: NoteSearchTag[] = [];
  terms.forEach((term, index) => {
    if (consumed.has(index)) {
      return;
    }
    const clause = parseTagClause(term);
    if (!clause) {
      textTerms.push(term);
    } else if (clause.excluded) {
      excludedTags.push(clause.tag);
    } else {
      requiredTags.push(clause.tag);
    }
  });

  return {
    text: textTerms.join(" "),
    requiredTags,
    excludedTags,
    orGroups
  };
}

export function parseNoteSearchQuery(source: string): NoteStructuredSearchQuery {
  return canonicalizeNoteSearchQuery(parseRawNoteSearchQuery(source));
}

export function parseAndValidateNoteSearchQuery(
  source: string
): NoteSearchQueryValidationResult {
  return validateAndCanonicalizeNoteSearchQuery(parseRawNoteSearchQuery(source));
}

export function canonicalNoteSearchQueryKey(
  query: NoteStructuredSearchQuery
): string {
  const canonical = canonicalizeNoteSearchQuery(query);
  const compactTag = ({ prefix, normalizedTag }: NoteSearchTag) => [
    prefix,
    normalizedTag
  ];
  return JSON.stringify({
    text: canonical.text,
    requiredTags: canonical.requiredTags.map(compactTag),
    excludedTags: canonical.excludedTags.map(compactTag),
    orGroups: canonical.orGroups.map((group) => group.map(compactTag))
  });
}
