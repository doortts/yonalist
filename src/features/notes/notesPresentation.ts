import type {
  NoteId,
  NoteNode,
  NoteNodeKind,
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
  node: Pick<NoteNode, "nodeKind"> & Partial<Pick<NoteNode, "title">>,
  title = node.title,
  emptyLabel = "Untitled note"
): string {
  const storedTitle = typeof title === "string" ? title.trim() : "";
  return node.nodeKind === "image"
    ? storedTitle || IMAGE_NODE_LABEL
    : storedTitle || emptyLabel;
}

type KindAwareSearchResult = NoteSearchResult & {
  readonly nodeKind?: unknown;
  readonly parentTrailKinds?: unknown;
};

export interface NoteSearchPresentation {
  readonly title: string;
  readonly parentTrail: readonly string[];
}

function noteNodeKind(value: unknown): NoteNodeKind | undefined {
  return value === "text" || value === "image" ? value : undefined;
}

function searchLabel(title: string, kind: NoteNodeKind | undefined): string {
  if (kind) {
    return noteNodeNavigationLabel({ nodeKind: kind, title });
  }
  return "Note";
}

export function noteSearchPresentation(
  result: NoteSearchResult,
  _nodesById?: Readonly<Record<NoteId, NoteNode>>
): NoteSearchPresentation {
  const metadata = result as KindAwareSearchResult;
  const resultKind = noteNodeKind(metadata.nodeKind);
  const metadataParentKinds = Array.isArray(metadata.parentTrailKinds)
    ? metadata.parentTrailKinds
    : [];

  return {
    title: searchLabel(result.title, resultKind),
    parentTrail: result.parentTrail.map((title, index) =>
      searchLabel(title, noteNodeKind(metadataParentKinds[index]))
    )
  };
}
