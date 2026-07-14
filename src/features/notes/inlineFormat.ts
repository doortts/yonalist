import type { NoteFormatKind } from "./noteTokens";

/**
 * The literal marker strings that wrap each inline-formatting kind. These are
 * plain text stored verbatim in the note (see {@link NoteFormatToken}); the
 * editing shortcuts below only ever insert or remove these exact characters.
 */
export const INLINE_FORMAT_MARKERS: Record<NoteFormatKind, string> = {
  strong: "**",
  em: "*",
  strike: "~~",
  code: "`"
};

export interface InlineFormatEdit {
  readonly value: string;
  readonly selectionStart: number;
  readonly selectionEnd: number;
}

/**
 * True when `marker` sits at `index` AND (for single-character markers) is not
 * part of a longer run of the same character. A `*` that abuts another `*`
 * belongs to a wider `**` bold marker; treating it as emphasis would corrupt
 * the bold marker, so the guard makes italic toggling NEST inside bold instead.
 */
function isIsolatedMarkerAt(
  value: string,
  index: number,
  marker: string
): boolean {
  if (index < 0 || value.slice(index, index + marker.length) !== marker) {
    return false;
  }
  if (marker.length > 1) {
    return true;
  }
  return (
    value[index - 1] !== marker && value[index + marker.length] !== marker
  );
}

/**
 * True when a single-character marker at either edge of `selected` extends into
 * a wider marker (e.g. `**bold**` begins with `**`, so a `*` toggle must not
 * strip it). Two-character markers never trigger this.
 */
function selectionEdgesExtendMarker(selected: string, marker: string): boolean {
  return (
    marker.length === 1 &&
    (selected[marker.length] === marker ||
      selected[selected.length - marker.length - 1] === marker)
  );
}

/**
 * Toggle an inline-formatting marker around the current textarea selection,
 * returning the next value and selection. Pure — the caller applies the result.
 *
 * Semantics (Workflowy/markdown-subset):
 * - Collapsed caret sitting inside an empty pair (`**|**`) removes the pair.
 * - Collapsed caret otherwise inserts an empty pair with the caret between it.
 * - A selection already wrapped by the marker (either the markers are part of
 *   the selection, or they sit immediately outside it) is unwrapped.
 * - Any other selection is wrapped; the selection tracks the original content.
 */
export function toggleInlineFormat(
  value: string,
  selectionStart: number,
  selectionEnd: number,
  kind: NoteFormatKind
): InlineFormatEdit {
  const marker = INLINE_FORMAT_MARKERS[kind];
  const markerLength = marker.length;
  const start = Math.max(0, Math.min(selectionStart, selectionEnd));
  const end = Math.min(value.length, Math.max(selectionStart, selectionEnd));

  if (start === end) {
    // Toggle off an empty pair the caret sits inside: `foo **|** bar`.
    if (
      value.slice(start - markerLength, start) === marker &&
      value.slice(end, end + markerLength) === marker
    ) {
      return {
        value: value.slice(0, start - markerLength) + value.slice(end + markerLength),
        selectionStart: start - markerLength,
        selectionEnd: start - markerLength
      };
    }
    return {
      value: value.slice(0, start) + marker + marker + value.slice(end),
      selectionStart: start + markerLength,
      selectionEnd: start + markerLength
    };
  }

  const selected = value.slice(start, end);

  // Markers captured inside the selection: `[**bold**]` -> `[bold]`. The edge
  // guard keeps a `*` toggle from stripping the outer `*` of `[**bold**]`
  // (which would leave `*bold*`); instead it nests, wrapping to `***bold***`.
  if (
    selected.length >= markerLength * 2 &&
    selected.startsWith(marker) &&
    selected.endsWith(marker) &&
    !selectionEdgesExtendMarker(selected, marker)
  ) {
    const inner = selected.slice(markerLength, selected.length - markerLength);
    return {
      value: value.slice(0, start) + inner + value.slice(end),
      selectionStart: start,
      selectionEnd: start + inner.length
    };
  }

  // Markers sitting immediately outside the selection: `**[bold]**` -> `[bold]`.
  // `isIsolatedMarkerAt` prevents an italic toggle from consuming one `*` of an
  // enclosing `**bold**`; it nests to `***bold***` instead.
  if (
    isIsolatedMarkerAt(value, start - markerLength, marker) &&
    isIsolatedMarkerAt(value, end, marker)
  ) {
    return {
      value:
        value.slice(0, start - markerLength) +
        selected +
        value.slice(end + markerLength),
      selectionStart: start - markerLength,
      selectionEnd: end - markerLength
    };
  }

  return {
    value: value.slice(0, start) + marker + selected + marker + value.slice(end),
    selectionStart: start + markerLength,
    selectionEnd: end + markerLength
  };
}

export interface InlineFormatShortcutEvent {
  readonly key: string;
  readonly metaKey: boolean;
  readonly ctrlKey: boolean;
  readonly shiftKey: boolean;
  readonly altKey: boolean;
}

/**
 * Resolve a keyboard event to an inline-formatting kind, or null. Cmd/Ctrl+B →
 * strong, Cmd/Ctrl+I → em, Cmd/Ctrl+Shift+X → strike. The primary modifier is
 * Cmd or Ctrl (either platform); Alt never participates.
 */
export function resolveInlineFormatShortcut(
  event: InlineFormatShortcutEvent
): NoteFormatKind | null {
  if (event.altKey || !(event.metaKey || event.ctrlKey)) {
    return null;
  }
  const key = event.key.toLowerCase();
  if (key === "b" && !event.shiftKey) {
    return "strong";
  }
  if (key === "i" && !event.shiftKey) {
    return "em";
  }
  if (key === "x" && event.shiftKey) {
    return "strike";
  }
  return null;
}
