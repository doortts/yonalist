import { Check, House, ImagePlus, MoreHorizontal, X } from "lucide-react";
import {
  lazy, Suspense, useRef, useState, type CSSProperties, type ReactNode
} from "react";
import type { NoteView } from "../../../packages/contracts/generated/NoteView";
import { handlePageKeyDown, RowMenuItem } from "./outlineSupport";
import { useMenuDismiss } from "./useMenuDismiss";
import type { NotesStore } from "./notesStore";
import type { OutlineIndex } from "./outlineIndex";
import {
  OutlineTextField, type OutlineTagToken
} from "./OutlineTextField";
import { useNotesNode } from "./useNotesNode";

const ImageNodeContent = lazy(() => import("./ImageNodeContent").then((module) => ({
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
  nodes,
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
  readonly nodes: readonly NoteView[];
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
  const { title } = useNotesNode(store, target.id);
  const targetNode = nodes.find((node) => node.id === target.id);
  const trail = zoomed ? zoomTrail(target.id, pageId, index) : null;
  return (
    <>
      {selectionToolbar ?? <div className="notes-outline-toolbar">
        <nav className="notes-breadcrumb" aria-label="Breadcrumb">
          <span className="notes-breadcrumb-segment">
            <button
              className="notes-breadcrumb-button notes-breadcrumb-home"
              type="button"
              aria-label="All pages"
              onClick={onHome}
            >
              <House size={15} aria-hidden="true" />
            </button>
          </span>
          <BreadcrumbCrumb
            label={pageTitle || "Untitled page"}
            current={!zoomed}
            onClick={zoomed ? onBack : undefined}
          />
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
  readonly imageDropTarget: boolean;
  readonly onPickImage: () => void;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const menuTriggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const onMenuKeyDown = useMenuDismiss(
    menuOpen, menuRef, menuTriggerRef, () => setMenuOpen(false)
  );
  const { title } = useNotesNode(store, target.id);
  const targetNode = nodes.find((node) => node.id === target.id);
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
              value={title}
              placeholder="Untitled page"
              onTagClick={onTagClick}
              onChange={(event) => store.setDraft(target.id, event.target.value)}
              onKeyDown={(event) => handlePageKeyDown(
                event,
                store,
                target.id,
                nodes,
                visibleNodes,
                index,
                visibleIndex,
                onBack
              )}
              onKeyUp={(event) => {
                if (event.key === "Backspace") store.endBackspaceGesture();
              }}
              onBlur={() => void store.flushDraft(target.id)}
            />
          </h2>}
        </div>
      </div>
      {imageDropTarget && <div className="notes-image-drop-position" />}
    </header>
  );
}
