import {
  Check, ChevronDown, ChevronRight, Circle, Copy, MessageSquareText,
  ImagePlus, MoreHorizontal, SquareCheckBig, Star, Trash2
} from "lucide-react";
import {
  lazy, memo, Suspense, useEffect, useRef, useState, type CSSProperties
} from "react";
import type { NoteView } from "../../../packages/contracts/generated/NoteView";
import { NotesStore } from "./notesStore";
import {
  endOutlineEnterGesture, handleImagePrimaryKeyDown, handleMultilinePaste,
  handleOutlineKeyDown, RowMenuItem
} from "./outlineSupport";
import { focusOutlineEditor } from "./outlineFocus";
import {
  resolveSupportingNoteKey, supportingNoteFocusTarget
} from "./outlineKeyboard";
import {
  TodoCheckbox, TodoProgressIndicator, type TodoProgress
} from "./outlineTodo";
import {
  applySlashCommand, filterSlashCommands, localDateIso,
  resolveSlashCommandQuery, type SlashCommandId,
  type SlashCommandQuery
} from "./outlineSlash";
import {
  OutlineTextField
} from "./OutlineTextField";
import type { OutlineRowRuntime } from "./outlineRowRuntime";
import { useNotesNode } from "./useNotesNode";

const SlashCommandMenu = lazy(() => import("./SlashCommandMenu").then((module) => ({
  default: module.SlashCommandMenu
})));
const ImageNodeContent = lazy(() => import("./ImageNodeContent").then((module) => ({
  default: module.ImageNodeContent
})));

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
  const [menuOpen, setMenuOpen] = useState(false);
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
        data-marker-kind={node.marker}
        data-empty-bullet={(draft ?? node.text).length === 0 ? "true" : undefined}
        style={{ "--notes-depth": depth } as CSSProperties}
      >
        <div className="notes-node-main">
          <span className="notes-node-menu-slot">
            <button
              className="notes-bullet-menu-trigger"
              type="button"
              aria-label={`Actions for ${(draft ?? node.text) || "Untitled"}`}
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
                  icon={<MessageSquareText size={14} aria-hidden="true" />}
                  label={visibleNote.trim().length > 0 ? "Edit note" : "Add note"}
                  onClick={() => {
                    setMenuOpen(false);
                    openNoteAndFocus();
                  }}
                />
                <RowMenuItem
                  icon={node.marker === "todo"
                    ? <Circle size={14} aria-hidden="true" />
                    : <SquareCheckBig size={14} aria-hidden="true" />}
                  label={node.marker === "todo" ? "Change to bullet" : "To-do"}
                  onClick={() => {
                    setMenuOpen(false);
                    void store.setMarker(
                      node.id,
                      node.marker === "todo" ? "bullet" : "todo"
                    );
                  }}
                />
                <RowMenuItem
                  icon={<Copy size={14} aria-hidden="true" />}
                  label="Duplicate"
                  onClick={() => {
                    setMenuOpen(false);
                    const current = runtime.read();
                    const nextSiblingId = current.index.nextSiblingId(node.id);
                    void store.duplicate(
                      node.id,
                      node.parentId ?? current.pageId,
                      nextSiblingId
                    );
                  }}
                />
                <RowMenuItem
                  icon={<ImagePlus size={14} aria-hidden="true" />}
                  label="Upload image"
                  onClick={() => {
                    setMenuOpen(false);
                    runtime.read().onPickImage(node.id);
                  }}
                />
                <RowMenuItem
                  icon={<Check size={14} aria-hidden="true" />}
                  label={node.completed ? "Mark incomplete" : "Complete"}
                  onClick={() => {
                    setMenuOpen(false);
                    void store.setCompleted(node.id, !node.completed);
                  }}
                />
                <RowMenuItem
                  icon={<Star size={14} aria-hidden="true" />}
                  label={node.starred ? "Unstar" : "Star"}
                  onClick={() => {
                    setMenuOpen(false);
                    void store.setStarred(node.id, !node.starred);
                  }}
                />
                <RowMenuItem
                  danger
                  icon={<Trash2 size={14} aria-hidden="true" />}
                  label="Move to Trash"
                  onClick={() => {
                    setMenuOpen(false);
                    void store.deleteSubtree(node.id);
                  }}
                />
              </div>
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
              runtime.read().onDragHandlePointerDown(node.id, event)}
            onKeyDown={(event) =>
              runtime.read().onDragHandleKeyDown(node.id, event)}
            onClick={(event) => {
              if (runtime.read().consumeDragHandleClick(node.id)) {
                event.preventDefault();
                return;
              }
              runtime.read().onZoom(node.id, event.shiftKey);
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
                  const current = runtime.read();
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
                    current.selectionActions
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
            onTagClick={(token) => runtime.read().onTagClick(token)}
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
              const current = runtime.read();
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
          <OutlineTextField
            ref={noteRef}
            className="notes-node-note"
            containerClassName="notes-node-note-field"
            data-node-id={node.id}
            data-outline-field="note"
            aria-label={`Supporting note: ${(draft ?? node.text) || "Untitled"}`}
            rows={1}
            value={visibleNote}
            placeholder="Add a supporting note"
            onTagClick={(token) => runtime.read().onTagClick(token)}
            onChange={(event) => store.setNoteDraft(node.id, event.target.value)}
            onKeyDown={(event) => {
              const resolution = resolveSupportingNoteKey({
                key: event.key,
                altKey: event.altKey,
                ctrlKey: event.ctrlKey,
                metaKey: event.metaKey,
                shiftKey: event.shiftKey,
                isComposing: event.nativeEvent.isComposing,
                repeat: event.repeat,
                selectionStart: event.currentTarget.selectionStart,
                selectionEnd: event.currentTarget.selectionEnd,
                value: event.currentTarget.value
              });
              if (!resolution) return;
              event.preventDefault();
              const scope = event.currentTarget.closest<HTMLElement>(".notes-outline");
              if (!scope) return;
              const current = runtime.read();
              const focusId = supportingNoteFocusTarget(
                resolution,
                node.id,
                current.visibleNodes.map((candidate) => candidate.id)
              );
              if (resolution === "nextTitleOrCreate" && focusId === node.id) {
                void store.flushNoteDraft(node.id)
                  .then(() => store.createNode(
                    node.parentId ?? current.pageId
                  ))
                  .then((id) => requestAnimationFrame(
                    () => focusOutlineEditor(scope, id, "start")
                  ));
                return;
              }
              void store.flushNoteDraft(node.id).then(() => requestAnimationFrame(
                () => focusOutlineEditor(scope, focusId, "preserve")
              ));
            }}
            onBlur={(event) => {
              const submittedNote = event.currentTarget.value;
              void store.flushNoteDraft(node.id).then(() => {
                if (submittedNote.trim().length === 0) setNoteOpen(false);
              });
            }}
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
