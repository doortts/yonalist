import type {
  NoteId,
  NoteNode,
  NoteSearchResult
} from "../../domain/notes";

export const IMAGE_NODE_LABEL = "Image";

export function noteNodePresentationLabel(
  node: Pick<NoteNode, "nodeKind" | "title">,
  title = node.title,
  emptyLabel = "Untitled note"
): string {
  return node.nodeKind === "image"
    ? IMAGE_NODE_LABEL
    : title.trim() || emptyLabel;
}

export function noteNodeNavigationLabel(
  node: Pick<NoteNode, "nodeKind"> &
    Partial<Pick<NoteNode, "title" | "imageOffsetUtf16">>,
  title = node.title,
  emptyLabel = "Untitled note",
  imageAttachmentOriginalName?: string
): string {
  const storedTitle = typeof title === "string" ? title.trim() : "";
  if (node.nodeKind !== "image") {
    return storedTitle || emptyLabel;
  }
  const imageOffsetUtf16 = node.imageOffsetUtf16;
  if (
    typeof title !== "string" ||
    typeof imageOffsetUtf16 !== "number" ||
    !Number.isSafeInteger(imageOffsetUtf16) ||
    imageOffsetUtf16 < 0 ||
    imageOffsetUtf16 > title.length ||
    (imageOffsetUtf16 > 0 &&
      imageOffsetUtf16 < title.length &&
      /[\uD800-\uDBFF]/.test(title[imageOffsetUtf16 - 1] ?? "") &&
      /[\uDC00-\uDFFF]/.test(title[imageOffsetUtf16] ?? ""))
  ) {
    return storedTitle || imageAttachmentOriginalName?.trim() || IMAGE_NODE_LABEL;
  }
  const primary = [
    title.slice(0, imageOffsetUtf16).trim(),
    title.slice(imageOffsetUtf16).trim()
  ]
    .filter(Boolean)
    .join(" ");
  return primary || imageAttachmentOriginalName?.trim() || IMAGE_NODE_LABEL;
}

export interface NoteSearchPresentation {
  readonly title: string;
  readonly parentTrail: readonly string[];
}

function searchResultLabel(label: string, kind: unknown): string {
  if (kind !== "text" && kind !== "image") {
    return "Note";
  }
  if (label.trim()) {
    return label;
  }
  if (kind === "text") {
    return "Untitled note";
  }
  return kind === "image" ? IMAGE_NODE_LABEL : "Note";
}

export function noteSearchPresentation(
  result: NoteSearchResult,
  _nodesById?: Readonly<Record<NoteId, NoteNode>>
): NoteSearchPresentation {
  return {
    title: searchResultLabel(result.displayLabel, result.nodeKind),
    parentTrail: result.parentTrail.map((label, index) =>
      searchResultLabel(label, result.parentTrailKinds?.[index])
    )
  };
}
