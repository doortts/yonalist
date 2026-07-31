import { Check, ImagePlus, MoreHorizontal, X } from "lucide-react";
import {
  lazy,
  Suspense,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type ReactNode
} from "react";
import type { NoteView } from "../../../packages/contracts/generated/NoteView";
import { handlePageKeyDown, RowMenuItem } from "./outlineSupport";
import type { NotesStore } from "./notesStore";
import type { OutlineIndex } from "./outlineIndex";
import {
  OutlineTextField, type OutlineTagToken
} from "./OutlineTextField";
import { useNotesNode } from "./useNotesNode";

const ImageNodeContent = lazy(() => import("./ImageNodeContent").then((module) => ({
  default: module.ImageNodeContent
})));

type CanonicalTitleHistoryEvent = Pick<
  KeyboardEvent<HTMLTextAreaElement>,
  | "key"
  | "ctrlKey"
  | "metaKey"
  | "shiftKey"
  | "preventDefault"
  | "stopPropagation"
>;

export function blockPendingCanonicalTitleKey(
  event: CanonicalTitleHistoryEvent,
  pending: boolean | undefined
): boolean {
  if (!pending) return false;
  if (event.key === "Enter") {
    event.preventDefault();
    event.stopPropagation();
  }
  return true;
}

export function handleCanonicalTitleHistory(
  event: CanonicalTitleHistoryEvent,
  undo: (() => void) | undefined,
  redo: (() => void) | undefined
): boolean {
  if (
    (!event.ctrlKey && !event.metaKey) ||
    event.key.toLowerCase() !== "z" ||
    !undo ||
    !redo
  ) {
    return false;
  }
  event.preventDefault();
  event.stopPropagation();
  if (event.shiftKey) redo();
  else undo();
  return true;
}

export function OutlineHeader({
  store,
  target,
  nodes,
  visibleNodes,
  index,
  visibleIndex,
  pageTitle,
  zoomed,
  showCompleted,
  error,
  onToggleCompleted,
  onBack,
  onTagClick,
  onClose,
  selectionToolbar,
  exportMenu,
  imageDropTarget,
  onPickImage,
  titleValue,
  titleReadOnly,
  onTitleChange,
  onTitleBlur,
  onTitleUndo,
  onTitleRedo,
  onCreateFirstChild
}: {
  readonly store: NotesStore;
  readonly target: { readonly id: string; readonly text: string };
  readonly nodes: readonly NoteView[];
  readonly visibleNodes: readonly NoteView[];
  readonly index: OutlineIndex;
  readonly visibleIndex: OutlineIndex;
  readonly pageTitle: string;
  readonly zoomed: boolean;
  readonly showCompleted: boolean;
  readonly error: string | null;
  readonly onToggleCompleted: () => void;
  readonly onBack: () => void;
  readonly onTagClick: (token: OutlineTagToken) => void;
  readonly onClose?: () => void;
  readonly selectionToolbar?: ReactNode;
  readonly exportMenu?: ReactNode;
  readonly imageDropTarget: boolean;
  readonly onPickImage: () => void;
  readonly titleValue?: string;
  readonly titleReadOnly?: boolean;
  readonly onTitleChange?: (value: string) => void;
  readonly onTitleBlur?: () => void;
  readonly onTitleUndo?: () => void;
  readonly onTitleRedo?: () => void;
  readonly onCreateFirstChild?: (parentId: string) => void;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const { title } = useNotesNode(store, target.id);
  const targetNode = nodes.find((node) => node.id === target.id);
  return (
    <>
      {selectionToolbar ?? <div className="notes-outline-toolbar">
        {zoomed ? (
          <button className="text-button" type="button" onClick={onBack}>
            {pageTitle}
          </button>
        ) : <span className="eyebrow">Notes</span>}
        {exportMenu}
        <button
          className="notes-completed-toggle"
          type="button"
          aria-label="Completed items"
          aria-pressed={showCompleted}
          onClick={onToggleCompleted}
        >
          <Check size={16} aria-hidden="true" />
        </button>
        {onClose && (
          <button className="notes-completed-toggle" type="button" aria-label="Close split" onClick={onClose}>
            <X size={16} aria-hidden="true" />
          </button>
        )}
      </div>}
      {error && <div className="notes-inline-error" role="alert">{error}</div>}
      <header
        className="notes-page-header"
        data-outline-header-id={target.id}
      >
        <div className="notes-page-title-row">
          <span className="notes-page-menu-slot">
            <button
              className="notes-bullet-menu-trigger"
              type="button"
              aria-label={`Actions for ${target.text || "Untitled"}`}
              data-popup-open={menuOpen ? "true" : undefined}
              onClick={() => setMenuOpen((value) => !value)}
            >
              <MoreHorizontal size={15} aria-hidden="true" />
            </button>
            {menuOpen && (
              <div
                className="notes-bullet-menu"
                role="menu"
                style={{
                  "--available-height": "420px",
                  position: "absolute",
                  insetInlineStart: 0,
                  insetBlockStart: 28
                } as CSSProperties}
              >
                <RowMenuItem
                  icon={<ImagePlus size={14} aria-hidden="true" />}
                  label="Upload image"
                  onClick={() => {
                    setMenuOpen(false);
                    onPickImage();
                  }}
                />
              </div>
            )}
          </span>
          <div className="notes-page-primary">
            {targetNode?.kind === "image" ? (
              <Suspense fallback={
                <div className="notes-image-attachment-placeholder" role="status">
                  Loading image
                </div>
              }>
                <ImageNodeContent node={targetNode} store={store} />
              </Suspense>
            ) : <h2 className="notes-page-heading">
              <OutlineTextField
                markdown
                className="notes-page-title"
                containerClassName="notes-page-title-field"
                data-node-id={target.id}
                data-outline-field="title"
                aria-label="Page title"
                rows={1}
                value={titleValue ?? title}
                placeholder="Untitled page"
                readOnly={titleReadOnly}
                onTagClick={onTagClick}
                onChange={(event) => {
                  if (titleReadOnly) return;
                  const value = event.target.value;
                  if (onTitleChange) onTitleChange(value);
                  else store.setDraft(target.id, value);
                }}
                onKeyDown={(event) => {
                  if (blockPendingCanonicalTitleKey(
                    event,
                    titleReadOnly
                  )) {
                    return;
                  }
                  if (handleCanonicalTitleHistory(
                    event,
                    onTitleUndo,
                    onTitleRedo
                  )) {
                    return;
                  }
                  handlePageKeyDown(
                    event,
                    store,
                    target.id,
                    nodes,
                    visibleNodes,
                    index,
                    visibleIndex,
                    onBack,
                    onCreateFirstChild
                  );
                }}
                onKeyUp={(event) => {
                  if (event.key === "Backspace") store.endBackspaceGesture();
                }}
                onBlur={() => {
                  if (onTitleBlur) onTitleBlur();
                  else void store.flushDraft(target.id);
                }}
              />
            </h2>}
          </div>
        </div>
        {imageDropTarget && <div className="notes-image-drop-position" />}
      </header>
    </>
  );
}
