import { ChevronDown, ChevronRight, MoreHorizontal } from "lucide-react";
import {
  lazy, memo, Suspense, useEffect, useRef, useState, type CSSProperties,
  type KeyboardEvent, type PointerEvent
} from "react";
import type { NoteView } from "../../../packages/contracts/generated/NoteView";
import { NotesStore } from "./notesStore";
import type { OutlineIndex } from "./outlineIndex";
import {
  endOutlineEnterGesture, handleImagePrimaryKeyDown, handleMultilinePaste,
  handleOutlineKeyDown, type SelectionKeyboardActions
} from "./outlineSupport";
import { supportingNoteFocusTarget } from "./outlineKeyboard";
import {
  TodoCheckbox, TodoProgressIndicator, type TodoProgress
} from "./outlineTodo";
import {
  applySlashCommand, filterSlashCommands, localDateIso,
  resolveSlashCommandQuery, type SlashCommandId,
  type SlashCommandQuery
} from "./outlineSlash";
import {
  OutlineTextField, type OutlineTagToken
} from "./OutlineTextField";
import { SupportingNoteField } from "./SupportingNoteField";
import { useNotesNode } from "./useNotesNode";
import type { SelectionMovePlans } from "./selectionMoves";

const SlashCommandMenu = lazy(() => import("./SlashCommandMenu").then((module) => ({
  default: module.SlashCommandMenu
})));
const ImageNodeContent = lazy(() => import("./ImageNodeContent").then((module) => ({
  default: module.ImageNodeContent
})));
const OutlineRowMenu = lazy(() => import("./OutlineRowMenu").then((module) => ({
  default: module.OutlineRowMenu
})));
const OutlineMoveChooser = lazy(() =>
  import("./OutlineMoveChooser").then((module) => ({
    default: module.OutlineMoveChooser
  })));
const OutlineTagChooser = lazy(() =>
  import("./OutlineTagChooser").then((module) => ({
    default: module.OutlineTagChooser
  })));

export interface OutlineRowRuntimeState {
  readonly visibleNodes: readonly NoteView[];
  readonly index: OutlineIndex;
  readonly visibleIndex: OutlineIndex;
  readonly pageId: string;
  readonly selectionHeadId: string | null;
  readonly hasSelection: boolean;
  /** Roots the selection commands act on; more than one opens selection mode. */
  readonly selectionRootIds: readonly string[];
  readonly selectionPlans: SelectionMovePlans;
  readonly allSelectedCompleted: boolean;
  /** Why Cut would lose data across the selection, or `null` when it is safe. */
  readonly selectionCutRefusal: string | null;
  /** Whether the whole forest has loaded; Move To waits on it. */
  readonly forestComplete: boolean;
  readonly onZoom: (nodeId: string, split: boolean) => void;
  readonly onZoomOut: () => void;
  readonly onExtendSelection: (originId: string, headId: string) => void;
  readonly onClearSelection: () => void;
  readonly onTagClick: (token: OutlineTagToken) => void;
  readonly onPickImage: (nodeId: string) => void;
  /** Clipboard for an image row with nothing selected around it. */
  readonly onCopyImage: (nodeId: string) => void;
  readonly onCutImage: (nodeId: string) => void;
  readonly selectionActions: SelectionKeyboardActions;
  readonly onDragHandlePointerDown: (
    nodeId: string,
    event: PointerEvent<HTMLButtonElement>
  ) => void;
  readonly onDragHandleKeyDown: (
    nodeId: string,
    event: KeyboardEvent<HTMLButtonElement>
  ) => void;
  readonly consumeDragHandleClick: (nodeId: string) => boolean;
}

/**
 * The mutable box a memoized row reads at event time. Rows cannot take the
 * pane's per-render closures as props without re-rendering on every keystroke,
 * so the pane refreshes this before the rows render and the rows read it when
 * an event actually fires.
 */
export class OutlineRowRuntime {
  state!: OutlineRowRuntimeState;
}

interface OutlineRowProps {
  readonly node: NoteView;
  readonly store: NotesStore;
  readonly selected: boolean;
  readonly depth: number;
  readonly hasChildren: boolean;
  readonly todoProgress: TodoProgress | null;
  readonly imageDropTarget: boolean;
  readonly dragSource: boolean;
  readonly runtime: OutlineRowRuntime;
}

export const OutlineRow = memo(function OutlineRow({
  node: outlineNode, store, selected, depth, hasChildren, todoProgress,
  imageDropTarget, dragSource, runtime
}: OutlineRowProps) {
  const {
    node: confirmedNode,
    titleDraft: draft,
    noteDraft
  } = useNotesNode(store, outlineNode.id);
  const node = confirmedNode ?? outlineNode;
  const editorRef = useRef<HTMLTextAreaElement>(null);
  const noteRef = useRef<HTMLTextAreaElement>(null);
  const menuTriggerRef = useRef<HTMLButtonElement>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [moveOpen, setMoveOpen] = useState(false);
  // The menu item and `⌃⌘M` open the one chooser mounted below by flipping
  // this: a second mount point would mean two dialogs racing for the same row.
  const openMoveChooser = () => setMoveOpen(true);
  const [tagsOpen, setTagsOpen] = useState(false);
  const [slashMenu, setSlashMenu] = useState<{
    readonly query: SlashCommandQuery;
    readonly commands: ReturnType<typeof filterSlashCommands>;
    readonly activeIndex: number;
  } | null>(null);
  const [noteOpen, setNoteOpen] = useState(
    () => (noteDraft ?? node.note).trim().length > 0
  );
  const visibleNote = noteDraft ?? node.note;
  const openNoteAndFocus = () => {
    setNoteOpen(true);
    requestAnimationFrame(() => noteRef.current?.focus());
  };
  const applyCurrentSlashCommand = (commandId: SlashCommandId) => {
    if (!slashMenu) return;
    const source = draft ?? node.text;
    const edit = applySlashCommand(
      source,
      slashMenu.query,
      commandId,
      localDateIso()
    );
    setSlashMenu(null);
    void store.applySlashEdit(node.id, edit.value, edit.marker).then(() => {
      requestAnimationFrame(() => {
        editorRef.current?.focus();
        editorRef.current?.setSelectionRange(edit.caret, edit.caret);
      });
    });
  };
  useEffect(() => {
    if (visibleNote.trim().length > 0) setNoteOpen(true);
  }, [visibleNote]);
  // The legacy menu's eleven-item variant is the selection one: it shows when
  // the clicked row is inside a live multi-row selection, and acts on the
  // selection, not the row. The chooser inherits the same scope.
  const menuMode = selected && runtime.state.selectionRootIds.length > 1
    ? "selection"
    : "row";
  return (
    <li
      className="notes-outline-item"
      data-drag-source={dragSource ? "true" : undefined}
      role="listitem"
    >
      <div
        className="notes-node"
        data-outline-id={node.id}
        data-completed={node.completed ? "true" : undefined}
        data-selected={selected ? "true" : undefined}
        data-range-selected={selected ? "true" : undefined}
        // One image alone in the selection is a selected character, not a
        // selected line, so the row band steps aside for it.
        data-solo-image-selection={selected &&
          node.kind === "image" &&
          runtime.state.selectionRootIds.length === 1 ? "true" : undefined}
        data-marker-kind={node.marker}
        data-empty-bullet={(draft ?? node.text).length === 0 ? "true" : undefined}
        style={{ "--notes-depth": depth } as CSSProperties}
      >
        <div className="notes-node-main">
          <span className="notes-node-menu-slot">
            <button
              ref={menuTriggerRef}
              className="notes-bullet-menu-trigger"
              type="button"
              aria-label={`Actions for ${(draft ?? node.text) || "Untitled"}`}
              aria-haspopup="menu"
              aria-expanded={menuOpen}
              data-popup-open={menuOpen ? "true" : undefined}
              onClick={() => setMenuOpen((value) => !value)}
            >
              <MoreHorizontal size={15} aria-hidden="true" />
            </button>
            {menuOpen && (
              <Suspense fallback={null}>
                <OutlineRowMenu
                  node={node}
                  store={store}
                  hasNote={visibleNote.trim().length > 0}
                  mode={menuMode}
                  runtime={runtime}
                  triggerRef={menuTriggerRef}
                  onClose={() => setMenuOpen(false)}
                  onAddNote={openNoteAndFocus}
                  onDuplicate={() => {
                    const current = runtime.state;
                    void store.duplicate(
                      node.id,
                      node.parentId ?? current.pageId,
                      current.index.nextSiblingId(node.id)
                    );
                  }}
                  onPickImage={() => runtime.state.onPickImage(node.id)}
                  onMoveTo={openMoveChooser}
                  onTags={() => setTagsOpen(true)}
                />
              </Suspense>
            )}
            {moveOpen && (
              <Suspense fallback={null}>
                <OutlineMoveChooser
                  mode={menuMode}
                  nodes={store.getSnapshot().nodes}
                  movingRootIds={menuMode === "selection"
                    ? runtime.state.selectionRootIds
                    : [node.id]}
                  rootId={runtime.state.pageId}
                  store={store}
                  triggerRef={menuTriggerRef}
                  onClose={() => setMoveOpen(false)}
                />
              </Suspense>
            )}
            {tagsOpen && (
              <Suspense fallback={null}>
                <OutlineTagChooser
                  nodes={store.getSnapshot().nodes}
                  targetIds={menuMode === "selection"
                    ? runtime.state.selectionRootIds
                    : [node.id]}
                  store={store}
                  triggerRef={menuTriggerRef}
                  onClose={() => setTagsOpen(false)}
                />
              </Suspense>
            )}
          </span>
          <span className="notes-node-arrow-slot">
            {hasChildren && (
              <button
                className="notes-row-icon-button notes-collapse-button"
                type="button"
                aria-label={`${node.collapsed ? "Expand" : "Collapse"} ${
                  (draft ?? node.text) || "Untitled"
                }`}
                aria-expanded={!node.collapsed}
                onPointerDown={(event) => event.stopPropagation()}
                onClick={() => void store.setCollapsed(node.id, !node.collapsed)}
              >
                {node.collapsed
                  ? <ChevronRight size={12} aria-hidden="true" />
                  : <ChevronDown size={12} aria-hidden="true" />}
              </button>
            )}
          </span>
          <button
            className="notes-node-bullet"
            type="button"
            aria-label="Zoom to item"
            data-sortable-activator="true"
            data-collapsed={hasChildren && node.collapsed ? "true" : undefined}
            onPointerDown={(event) =>
              runtime.state.onDragHandlePointerDown(node.id, event)}
            onKeyDown={(event) =>
              runtime.state.onDragHandleKeyDown(node.id, event)}
            onClick={(event) => {
              if (runtime.state.consumeDragHandleClick(node.id)) {
                event.preventDefault();
                return;
              }
              runtime.state.onZoom(node.id, event.shiftKey);
            }}
          >
            <span className="notes-node-bullet-dot" />
          </button>
          {node.marker === "todo" && (
            <TodoCheckbox
              checked={node.completed}
              label={`${node.completed ? "Mark incomplete" : "Mark complete"}: ${
                (draft ?? node.text) || "Untitled"
              }`}
              onToggle={() => void store.setCompleted(node.id, !node.completed)}
            />
          )}
          {node.kind === "image" ? (
            <Suspense fallback={
              <div className="notes-image-attachment-placeholder" role="status">
                Loading image
              </div>
            }>
              <ImageNodeContent
                node={node}
                store={store}
                onPaste={(event) => handleMultilinePaste(event, store, node)}
                onKeyDown={(event) => {
                  const current = runtime.state;
                  handleImagePrimaryKeyDown(
                    event,
                    store,
                    node,
                    store.getSnapshot().nodes,
                    current.visibleNodes,
                    current.index,
                    current.visibleIndex,
                    current.pageId,
                    () => current.onZoom(node.id, false),
                    current.onZoomOut,
                    current.selectionHeadId,
                    current.hasSelection,
                    current.onExtendSelection,
                    current.onClearSelection,
                    openNoteAndFocus,
                    openMoveChooser,
                    current.selectionActions,
                    current.onCopyImage,
                    current.onCutImage,
                    current.selectionRootIds.length === 1
                      ? current.selectionRootIds[0]!
                      : null
                  );
                }}
              />
            </Suspense>
          ) : <OutlineTextField
            ref={editorRef}
            markdown
            className="notes-node-title"
            containerClassName="notes-node-title-field"
            data-node-id={node.id}
            data-outline-field="title"
            aria-label="Note text"
            rows={1}
            value={draft ?? node.text}
            aria-expanded={slashMenu ? true : undefined}
            onTagClick={(token) => runtime.state.onTagClick(token)}
            onChange={(event) => {
              const value = event.currentTarget.value;
              const rawCaret = event.currentTarget.selectionStart;
              const caret = rawCaret === 0 && value.startsWith("/")
                ? value.length
                : rawCaret;
              store.setDraft(node.id, value);
              const query = resolveSlashCommandQuery(
                value,
                caret,
                caret
              );
              const commands = query ? filterSlashCommands(query.query) : [];
              setSlashMenu(query && commands.length > 0
                ? { query, commands, activeIndex: 0 }
                : null);
            }}
            onKeyDown={(event) => {
              if (slashMenu) {
                if (event.key === "ArrowDown" || event.key === "ArrowUp") {
                  event.preventDefault();
                  const delta = event.key === "ArrowDown" ? 1 : -1;
                  setSlashMenu((current) => current ? {
                    ...current,
                    activeIndex: (
                      current.activeIndex + delta + current.commands.length
                    ) % current.commands.length
                  } : null);
                  return;
                }
                if (event.key === "Enter" && !event.nativeEvent.isComposing) {
                  event.preventDefault();
                  applyCurrentSlashCommand(
                    slashMenu.commands[slashMenu.activeIndex]!.id
                  );
                  return;
                }
                if (event.key === "Escape") {
                  event.preventDefault();
                  setSlashMenu(null);
                  return;
                }
              }
              const current = runtime.state;
              const latestNodes = store.getSnapshot().nodes;
              const latestById = new Map(
                latestNodes.map((candidate) => [candidate.id, candidate])
              );
              const latestVisibleNodes = current.visibleNodes.map(
                (candidate) => latestById.get(candidate.id) ?? candidate
              );
              handleOutlineKeyDown(
                event,
                store,
                latestById.get(node.id) ?? node,
                latestNodes,
                latestVisibleNodes,
                current.index,
                current.visibleIndex,
                current.pageId,
                () => current.onZoom(node.id, false),
                current.onZoomOut,
                current.selectionHeadId,
                current.hasSelection,
                current.onExtendSelection,
                current.onClearSelection,
                openNoteAndFocus,
                openMoveChooser,
                visibleNote,
                current.selectionActions
              );
            }}
            onKeyUp={(event) => {
              if (event.key === "Backspace") store.endBackspaceGesture();
              if (event.key === "Enter") endOutlineEnterGesture(event.currentTarget);
            }}
            onPaste={(event) => handleMultilinePaste(event, store, node)}
            onBlur={() => void store.flushDraft(node.id)}
          />}
        </div>
        {noteOpen && (
          <SupportingNoteField
            ref={noteRef}
            store={store}
            nodeId={node.id}
            value={visibleNote}
            ariaLabel={`Supporting note: ${(draft ?? node.text) || "Untitled"}`}
            className="notes-node-note"
            containerClassName="notes-node-note-field"
            targets={() => {
              const current = runtime.state;
              const nextId = supportingNoteFocusTarget(
                "nextTitle",
                node.id,
                current.visibleNodes.map((candidate) => candidate.id)
              );
              return {
                nextRowId: nextId === node.id ? null : nextId,
                fallbackFocusId: node.id,
                createParentId: node.parentId ?? current.pageId
              };
            }}
            onTagClick={(token) => runtime.state.onTagClick(token)}
            onAutoHide={() => setNoteOpen(false)}
          />
        )}
        <TodoProgressIndicator value={todoProgress} />
        {imageDropTarget && <div className="notes-image-drop-position" />}
      </div>
      {slashMenu && editorRef.current && (
        <Suspense fallback={null}>
          <SlashCommandMenu
            anchor={editorRef.current}
            commands={slashMenu.commands}
            activeIndex={slashMenu.activeIndex}
            onSelect={applyCurrentSlashCommand}
          />
        </Suspense>
      )}
    </li>
  );
});
