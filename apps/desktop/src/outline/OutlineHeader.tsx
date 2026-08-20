import { Check, House, ImagePlus, MoreHorizontal, X } from "lucide-react";
import {
  lazy, Suspense, useEffect, useRef, useState, type CSSProperties,
  type ReactNode
} from "react";
import { flushSync } from "react-dom";
import type { NoteView } from "../../../../packages/contracts/generated/NoteView";
import {
  handleImagePageKeyDown, handlePageKeyDown
} from "./outlineSupport";
import { RowMenuItem } from "../RowMenuItem";
import { useMenuDismiss } from "../useMenuDismiss";
import type { NotesStore } from "../notesStore";
import type { OutlineIndex } from "./outlineIndex";
import {
  OutlineTextField, type OutlineTagToken
} from "./OutlineTextField";
import { SupportingNoteField } from "../SupportingNoteField";
import { useNotesNode } from "../useNotesNode";
import { ROOT_ID } from "../store/storeSupport";

const ImageNodeContent = lazy(() => import("../image/ImageNodeContent").then((module) => ({
  default: module.ImageNodeContent
})));

function crumbLabel(node: NoteView): string {
  return node.kind === "image" ? "(image)" : node.text || "Untitled";
}

/**
 * The zoom root's ancestors between it and the page, page-most first. The
 * loaded viewport can stop short of the page, so an unknown parent truncates
 * the trail instead of guessing at it.
 */
function zoomTrail(zoomRootId: string, pageId: string, index: OutlineIndex): {
  readonly ancestors: readonly NoteView[];
  readonly truncated: boolean;
} {
  const ancestors: NoteView[] = [];
  const seen = new Set<string>([zoomRootId]);
  let parentId = index.node(zoomRootId)?.parentId ?? null;
  while (parentId !== null && parentId !== pageId && !seen.has(parentId)) {
    const parent = index.node(parentId);
    if (!parent) return { ancestors: ancestors.reverse(), truncated: true };
    seen.add(parentId);
    ancestors.push(parent);
    parentId = parent.parentId;
  }
  return { ancestors: ancestors.reverse(), truncated: false };
}

function BreadcrumbCrumb({
  label,
  current,
  onClick
}: {
  readonly label: string;
  readonly current?: boolean;
  readonly onClick?: () => void;
}) {
  return (
    <span className="notes-breadcrumb-segment">
      <span aria-hidden="true">›</span>
      <button
        className="notes-breadcrumb-button"
        type="button"
        aria-current={current ? "page" : undefined}
        disabled={!onClick}
        onClick={onClick}
      >
        {label}
      </button>
    </span>
  );
}

export function OutlineHeader({
  store,
  target,
  index,
  pageId,
  pageTitle,
  zoomed,
  showCompleted,
  error,
  onToggleCompleted,
  onBack,
  onHome,
  onZoomTo,
  onClose,
  selectionToolbar,
  exportMenu
}: {
  readonly store: NotesStore;
  readonly target: { readonly id: string; readonly text: string };
  readonly index: OutlineIndex;
  readonly pageId: string;
  readonly pageTitle: string;
  readonly zoomed: boolean;
  readonly showCompleted: boolean;
  readonly error: string | null;
  readonly onToggleCompleted: () => void;
  readonly onBack: () => void;
  readonly onHome: () => void;
  readonly onZoomTo: (nodeId: string) => void;
  readonly onClose?: () => void;
  readonly selectionToolbar?: ReactNode;
  readonly exportMenu?: ReactNode;
}) {
  const { node: targetNode, title } = useNotesNode(store, target.id);
  const trail = zoomed ? zoomTrail(target.id, pageId, index) : null;
  // Home is the house crumb, so on it the house is where a page crumb would
  // otherwise be: the level to come back to, and nothing once you are there.
  const atRoot = pageId === ROOT_ID;
  return (
    <>
      <div
        className="notes-outline-toolbar"
        data-tauri-drag-region="deep"
      >
        <nav className="notes-breadcrumb" aria-label="Breadcrumb">
          <span className="notes-breadcrumb-segment">
            <button
              className="notes-breadcrumb-button notes-breadcrumb-home"
              type="button"
              aria-label="All pages"
              data-tooltip="All pages"
              data-tooltip-align="left"
              aria-current={atRoot && !zoomed ? "page" : undefined}
              disabled={atRoot && !zoomed}
              onClick={atRoot ? onBack : onHome}
            >
              <House size={15} aria-hidden="true" />
            </button>
          </span>
          {!atRoot && <BreadcrumbCrumb
            label={pageTitle || "Untitled page"}
            current={!zoomed}
            onClick={zoomed ? onBack : undefined}
          />}
          {trail && <>
            {trail.truncated && <BreadcrumbCrumb label="…" />}
            {trail.ancestors.map((ancestor) => (
              <BreadcrumbCrumb
                key={ancestor.id}
                label={crumbLabel(ancestor)}
                onClick={() => onZoomTo(ancestor.id)}
              />
            ))}
            <BreadcrumbCrumb
              current
              label={targetNode?.kind === "image"
                ? "(image)"
                : title || "Untitled"}
            />
          </>}
        </nav>
        {exportMenu}
        <button
          className="notes-completed-toggle"
          type="button"
          aria-label="Completed items"
          data-tooltip={showCompleted ? "Hide completed items" : "Show completed items"}
          data-tooltip-align="right"
          data-active={!showCompleted ? "true" : undefined}
          aria-pressed={showCompleted}
          onClick={onToggleCompleted}
        >
          <Check size={16} aria-hidden="true" />
        </button>
        {onClose && (
          <button
            className="notes-completed-toggle"
            type="button"
            aria-label="Close split"
            data-tooltip="Close split"
            data-tooltip-align="right"
            onClick={onClose}
          >
            <X size={16} aria-hidden="true" />
          </button>
        )}
      </div>
      {/* A zero-height sticky box: the pill has to stay under the toolbar as
          the rows scroll past, and it must not push them down when it appears.
          The box is also what the pill measures the pane's width by. */}
      {selectionToolbar && (
        <div className="notes-selection-float">{selectionToolbar}</div>
      )}
      {error && <div className="notes-inline-error" role="alert">{error}</div>}
    </>
  );
}

/**
 * The page (or zoom root) title. It renders inside the outline's centered
 * content column rather than beside the toolbar, so it shares the rows' left
 * edge and scrolls away with them.
 */
export function OutlinePageHeading({
  store,
  target,
  nodes,
  visibleNodes,
  index,
  visibleIndex,
  onBack,
  onTagClick,
  onDateClick,
  imageDropTarget,
  onPickImage
}: {
  readonly store: NotesStore;
  readonly target: { readonly id: string; readonly text: string };
  readonly nodes: readonly NoteView[];
  readonly visibleNodes: readonly NoteView[];
  readonly index: OutlineIndex;
  readonly visibleIndex: OutlineIndex;
  readonly onBack: () => void;
  readonly onTagClick: (token: OutlineTagToken) => void;
  readonly onDateClick?: (date: string, anchor: DOMRect) => void;
  readonly imageDropTarget: boolean;
  readonly onPickImage: () => void;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const menuTriggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const onMenuKeyDown = useMenuDismiss(
    menuOpen, menuRef, menuTriggerRef, () => setMenuOpen(false)
  );
  const { node: targetNode, title, note, noteDraft } =
    useNotesNode(store, target.id);
  const noteRef = useRef<HTMLTextAreaElement>(null);
  const visibleNote = noteDraft ?? note;
  const [noteOpen, setNoteOpen] = useState(
    () => visibleNote.trim().length > 0
  );
  useEffect(() => {
    if (visibleNote.trim().length > 0) setNoteOpen(true);
  }, [visibleNote]);
  const openNoteAndFocus = () => {
    // Same as the row's: focus rides the commit, since a frame callback never
    // runs while the window is occluded or backgrounded.
    flushSync(() => setNoteOpen(true));
    noteRef.current?.focus();
  };
  return (
    <header
      className="notes-page-header"
      data-outline-header-id={target.id}
    >
      <div className="notes-page-title-row">
        <span className="notes-page-menu-slot">
          <button
            ref={menuTriggerRef}
            className="notes-bullet-menu-trigger"
            type="button"
            aria-label={`Actions for ${target.text || "Untitled"}`}
            data-tooltip="Page actions"
            data-tooltip-align="left"
            aria-haspopup="menu"
            aria-expanded={menuOpen}
            data-popup-open={menuOpen ? "true" : undefined}
            onClick={() => setMenuOpen((value) => !value)}
          >
            <MoreHorizontal size={15} aria-hidden="true" />
          </button>
          {menuOpen && (
            <div
              ref={menuRef}
              className="notes-bullet-menu"
              role="menu"
              aria-label="Page actions"
              onKeyDown={onMenuKeyDown}
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
              <ImageNodeContent
                node={targetNode}
                store={store}
                onKeyDown={(event) => handleImagePageKeyDown(
                  event,
                  store,
                  target.id,
                  nodes,
                  visibleNodes,
                  index,
                  visibleIndex,
                  onBack,
                  openNoteAndFocus
                )}
              />
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
              value={title}
              placeholder="Untitled page"
              onTagClick={onTagClick}
              onDateClick={onDateClick}
              onChange={(event) => store.setDraft(target.id, event.target.value)}
              onKeyDown={(event) => handlePageKeyDown(
                event,
                store,
                target.id,
                nodes,
                visibleNodes,
                index,
                visibleIndex,
                onBack,
                openNoteAndFocus
              )}
              onKeyUp={(event) => {
                if (event.key === "Backspace") store.endBackspaceGesture();
              }}
              onBlur={() => void store.flushDraft(target.id)}
            />
          </h2>}
          {noteOpen && (
            <SupportingNoteField
              ref={noteRef}
              store={store}
              nodeId={target.id}
              value={visibleNote}
              ariaLabel="Page note"
              className="notes-page-note"
              containerClassName="notes-page-note-field"
              // Down out of the page note lands on the first body row; with no
              // row to land on it stays put, and Shift+Enter starts the first
              // child instead.
              targets={() => ({
                nextRowId: visibleNodes[0]?.id ?? null,
                fallbackFocusId: null,
                createParentId: target.id
              })}
              onTagClick={onTagClick}
              onDateClick={onDateClick}
              onAutoHide={() => setNoteOpen(false)}
            />
          )}
        </div>
      </div>
      {imageDropTarget && <div className="notes-image-drop-position" />}
    </header>
  );
}
