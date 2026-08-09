import {
  useLayoutEffect, useRef, useState, type CSSProperties, type RefObject
} from "react";
import type { NoteView } from "../../../packages/contracts/generated/NoteView";
import type { NotesStore } from "./notesStore";
import {
  outlineMenuCommands, type OutlineMenuContext, type OutlineMenuMode
} from "./outlineMenuCommands";
import {
  outlinePlatform, RowMenuItem, type SelectionKeyboardActions
} from "./outlineSupport";
import {
  buildSelectionMovePlans, type SelectionMovePlans
} from "./selectionMoves";

/**
 * The slice of `OutlineRowRuntime` the menu reads. Declared structurally
 * rather than imported from `OutlineRow`, which lazy-loads this module: a
 * type-only import back would still be a module cycle to the architecture gate.
 */
interface OutlineMenuRuntime {
  readonly state: {
    readonly visibleNodes: readonly NoteView[];
    readonly pageId: string;
    readonly selectionPlans: SelectionMovePlans;
    readonly allSelectedCompleted: boolean;
    readonly selectionActions: SelectionKeyboardActions;
  };
}
import {
  MENU_BLOCK_INSET, menuPlacement, outlineMenuBounds, useMenuDismiss
} from "./useMenuDismiss";

/**
 * The per-row action menu. It is only ever reached by clicking a row's
 * trigger, so it loads on demand and stays out of the editable first-paint
 * bundle — the same arrangement the slash-command menu already uses.
 *
 * `mode` decides what the items act on. In `selection` mode every item runs
 * against the whole live selection and the eligibility comes from the plans
 * the pane already built; in `row` mode the same commands are scoped to the
 * clicked node, whose plans are the one-root case of the very same rules.
 */
export function OutlineRowMenu({
  node, store, hasNote, mode, runtime, triggerRef, onClose, onAddNote,
  onDuplicate, onPickImage
}: {
  readonly node: NoteView;
  readonly store: NotesStore;
  readonly hasNote: boolean;
  readonly mode: OutlineMenuMode;
  readonly runtime: OutlineMenuRuntime;
  readonly triggerRef: RefObject<HTMLButtonElement | null>;
  readonly onClose: () => void;
  readonly onAddNote: () => void;
  readonly onDuplicate: () => void;
  readonly onPickImage: () => void;
}) {
  const menuRef = useRef<HTMLDivElement>(null);
  const onKeyDown = useMenuDismiss(true, menuRef, triggerRef, onClose);
  const [placement, setPlacement] = useState({
    insetBlockStart: MENU_BLOCK_INSET,
    insetInlineStart: 0
  });
  // Measured once, at the default placement: the row unmounts when it scrolls
  // out of the virtualized window, which closes the menu anyway.
  useLayoutEffect(() => {
    const menu = menuRef.current;
    if (menu) {
      setPlacement(menuPlacement(
        menu.getBoundingClientRect(),
        outlineMenuBounds(menu)
      ));
    }
  }, []);
  const state = runtime.state;
  const platform = outlinePlatform();
  const context: OutlineMenuContext = {
    mode,
    platform,
    node,
    store,
    hasNote,
    allCompleted: mode === "selection"
      ? state.allSelectedCompleted
      : node.completed,
    plans: mode === "selection"
      ? state.selectionPlans
      : buildSelectionMovePlans(
        store.getSnapshot().nodes,
        state.visibleNodes.map((visible) => visible.id),
        [node.id],
        state.pageId
      ),
    row: {
      addNote: onAddNote,
      duplicate: onDuplicate,
      pickImage: onPickImage
    },
    selection: state.selectionActions
  };
  return (
    <div
      ref={menuRef}
      className="notes-bullet-menu"
      role="menu"
      aria-label={mode === "selection" ? "Selection actions" : "Row actions"}
      data-shortcut-hints="true"
      style={{
        "--available-height": "420px",
        position: "absolute",
        ...placement
      } as CSSProperties}
      onKeyDown={onKeyDown}
    >
      {outlineMenuCommands(mode).map((command) => {
        const Icon = command.icon(context);
        const eligibility = command.eligibility(context);
        return (
          <RowMenuItem
            key={command.id}
            icon={<Icon size={14} aria-hidden="true" />}
            label={command.label(context)}
            shortcut={command.binding?.hint[platform]}
            keyshortcuts={command.binding?.keys[platform]}
            danger={command.danger}
            disabled={!eligibility.available}
            reason={eligibility.available ? undefined : eligibility.reason}
            onClick={() => {
              onClose();
              command.execute(context);
            }}
          />
        );
      })}
    </div>
  );
}
