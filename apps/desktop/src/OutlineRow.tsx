import {
  Check, ChevronDown, ChevronRight, Circle, Copy, MessageSquareText,
  MoreHorizontal, SquareCheckBig, Star, Trash2
} from "lucide-react";
import {
  lazy, Suspense, useEffect, useRef, useState, type CSSProperties,
  type KeyboardEvent, type PointerEvent
} from "react";
import type { NoteView } from "../../../packages/contracts/generated/NoteView";
import { NotesStore } from "./notesStore";
import type { OutlineIndex } from "./outlineIndex";
import {
  endOutlineEnterGesture, handleMultilinePaste, handleOutlineKeyDown, RowMenuItem,
  type SelectionKeyboardActions
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
  OutlineTextField, type OutlineTagToken
} from "./OutlineTextField";

const SlashCommandMenu = lazy(() => import("./SlashCommandMenu").then((module) => ({
  default: module.SlashCommandMenu
})));

export function OutlineRow({
  node, pageId, nodes, visibleNodes, index, visibleIndex, draft, noteDraft,
  store, selected, onZoom,
  onZoomOut, selectionHeadId, hasSelection, onExtendSelection,
  onClearSelection, onTagClick, todoProgress, selectionActions, dragSource,
  onDragHandlePointerDown, onDragHandleKeyDown, consumeDragHandleClick
}: {
  readonly node: NoteView;
  readonly pageId: string;
  readonly nodes: readonly NoteView[];
  readonly visibleNodes: readonly NoteView[];
  readonly index: OutlineIndex;
  readonly visibleIndex: OutlineIndex;
  readonly draft: string | undefined;
  readonly noteDraft: string | undefined;
  readonly store: NotesStore;
  readonly selected: boolean;
  readonly onZoom: (split: boolean) => void;
  readonly onZoomOut: () => void;
  readonly selectionHeadId: string | null;
  readonly hasSelection: boolean;
  readonly onExtendSelection: (originId: string, headId: string) => void;
  readonly onClearSelection: () => void;
  readonly onTagClick: (token: OutlineTagToken) => void;
  readonly todoProgress: TodoProgress | null;
  readonly selectionActions: SelectionKeyboardActions;
  readonly dragSource: boolean;
  readonly onDragHandlePointerDown: (
    event: PointerEvent<HTMLButtonElement>
  ) => void;
  readonly onDragHandleKeyDown: (
    event: KeyboardEvent<HTMLButtonElement>
  ) => void;
  readonly consumeDragHandleClick: () => boolean;
}) {
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
  const depth = index.depthOf(node.id, pageId);
  const hasChildren = index.hasChildren(node.id);
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
                    const nextSiblingId = index.nextSiblingId(node.id);
                    void store.duplicate(
                      node.id,
                      node.parentId ?? pageId,
                      nextSiblingId
                    );
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
            onPointerDown={onDragHandlePointerDown}
            onKeyDown={onDragHandleKeyDown}
            onClick={(event) => {
              if (consumeDragHandleClick()) {
                event.preventDefault();
                return;
              }
              onZoom(event.shiftKey);
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
          <OutlineTextField
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
            onTagClick={onTagClick}
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
              handleOutlineKeyDown(
                event,
                store,
                node,
                nodes,
                visibleNodes,
                index,
                visibleIndex,
                pageId,
                () => onZoom(false),
                onZoomOut,
                selectionHeadId,
                hasSelection,
                onExtendSelection,
                onClearSelection,
                openNoteAndFocus,
                visibleNote,
                selectionActions
              );
            }}
            onKeyUp={(event) => {
              if (event.key === "Backspace") store.endBackspaceGesture();
              if (event.key === "Enter") endOutlineEnterGesture(event.currentTarget);
            }}
            onPaste={(event) => handleMultilinePaste(event, store, node)}
            onBlur={() => void store.flushDraft(node.id)}
          />
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
            onTagClick={onTagClick}
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
              const focusId = supportingNoteFocusTarget(
                resolution,
                node.id,
                visibleNodes.map((candidate) => candidate.id)
              );
              if (resolution === "nextTitleOrCreate" && focusId === node.id) {
                void store.flushNoteDraft(node.id)
                  .then(() => store.createNode(node.parentId ?? pageId))
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
}
