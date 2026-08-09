import {
  ArrowDown, ArrowUp, Check, Circle, Copy, CopyPlus, CornerUpRight, ImagePlus,
  IndentDecrease, IndentIncrease, MessageSquareText, Scissors, SquareCheckBig,
  Star, Trash2, type LucideIcon
} from "lucide-react";
import type { NoteView } from "../../../packages/contracts/generated/NoteView";
import type { NotesStore } from "./notesStore";
import {
  serializeSelectedOutline, writeOutlineClipboard
} from "./outlineClipboard";
import type { SelectionKeyboardActions } from "./outlineSupport";
import type { SelectionMovePlan, SelectionMovePlans } from "./selectionMoves";

export type OutlineMenuMode = "row" | "selection";
export type OutlinePlatform = "mac" | "other";

export type OutlineMenuCommandId =
  | "addNote" | "marker" | "duplicate" | "uploadImage" | "complete" | "star"
  | "delete" | "moveTo" | "moveUp" | "moveDown" | "indent" | "outdent"
  | "copy" | "cut";

/**
 * What the row menu needs to know to draw and run one command. `plans` is
 * built for whatever the command acts on — the selected roots in selection
 * mode, the clicked node alone in row mode — so one set of eligibility rules
 * and one set of reason strings serve both.
 */
export interface OutlineMenuContext {
  readonly mode: OutlineMenuMode;
  readonly platform: OutlinePlatform;
  readonly node: NoteView;
  readonly store: NotesStore;
  readonly hasNote: boolean;
  /** Selection mode: every selected node is complete. Row mode: this node is. */
  readonly allCompleted: boolean;
  /**
   * `outlineCutRefusal` over whatever Cut would delete, or `null` when the
   * round trip is lossless. Precomputed by the caller the way `plans` is, so
   * both modes answer from the one guard.
   */
  readonly cutRefusal: string | null;
  /**
   * Whether the whole forest has loaded. Move To lists every destination in
   * the outline, so it waits on the very gate the mutating selection commands
   * already wait on rather than opening on a subset of the tree.
   */
  readonly forestComplete: boolean;
  readonly plans: SelectionMovePlans;
  readonly row: {
    readonly addNote: () => void;
    readonly duplicate: () => void;
    readonly pickImage: () => void;
  };
  readonly selection: SelectionKeyboardActions;
  /** Opens the destination chooser. Both modes hand off to the same dialog. */
  readonly openMoveTo: () => void;
}

export type OutlineMenuEligibility =
  | { readonly available: true }
  | { readonly available: false; readonly reason: string };

/** The hint the menu prints and the `aria-keyshortcuts` value beside it. */
export interface OutlineMenuBinding {
  readonly hint: Readonly<Record<OutlinePlatform, string>>;
  readonly keys: Readonly<Record<OutlinePlatform, string>>;
}

export interface OutlineMenuCommand {
  readonly id: OutlineMenuCommandId;
  readonly icon: (context: OutlineMenuContext) => LucideIcon;
  readonly label: (context: OutlineMenuContext) => string;
  readonly danger?: boolean;
  readonly binding?: OutlineMenuBinding;
  readonly eligibility: (context: OutlineMenuContext) => OutlineMenuEligibility;
  readonly execute: (context: OutlineMenuContext) => void;
}

function binding(
  macHint: string,
  otherHint: string,
  macKeys: string,
  otherKeys: string
): OutlineMenuBinding {
  return {
    hint: { mac: macHint, other: otherHint },
    keys: { mac: macKeys, other: otherKeys }
  };
}

const ALWAYS = (): OutlineMenuEligibility => ({ available: true });

/** Row mode routes a one-node plan through the same batch move as a selection. */
function runMove(context: OutlineMenuContext, plan: SelectionMovePlan): void {
  if (plan.available) void context.store.moveNodes(plan.moves);
}

/**
 * The clicked row's subtree as clipboard text: the one-root case of the very
 * serializer the multi-row selection uses, so both paths emit the same bytes.
 */
function rowSubtreeText(context: OutlineMenuContext): string | null {
  const { nodes, drafts } = context.store.getSnapshot();
  return serializeSelectedOutline(nodes, drafts, [context.node.id]);
}

/**
 * Every bullet-menu command in one place. `OutlineRowMenu` renders from this
 * table in both modes, so a label, an icon, a shortcut, or an eligibility rule
 * is written once rather than once per surface.
 */
export const OUTLINE_MENU_COMMANDS: readonly OutlineMenuCommand[] = [
  {
    id: "addNote",
    icon: () => MessageSquareText,
    // Workflowy shows one label whether or not the note already exists.
    label: () => "Add note",
    eligibility: ALWAYS,
    execute: (context) => context.row.addNote()
  },
  {
    id: "marker",
    icon: (context) =>
      context.node.marker === "todo" ? Circle : SquareCheckBig,
    label: (context) =>
      context.node.marker === "todo" ? "Change to bullet" : "To-do",
    eligibility: ALWAYS,
    execute: (context) => void context.store.setMarker(
      context.node.id,
      context.node.marker === "todo" ? "bullet" : "todo"
    )
  },
  {
    id: "duplicate",
    icon: () => CopyPlus,
    label: () => "Duplicate",
    binding: binding("⌘⇧D", "Alt+Shift+D", "Meta+Shift+D", "Alt+Shift+D"),
    eligibility: (context) => context.plans.duplicate,
    execute: (context) => context.mode === "selection"
      ? context.selection.duplicate()
      : context.row.duplicate()
  },
  {
    id: "uploadImage",
    icon: () => ImagePlus,
    label: () => "Upload image",
    eligibility: ALWAYS,
    execute: (context) => context.row.pickImage()
  },
  {
    id: "complete",
    icon: () => Check,
    label: (context) => context.allCompleted ? "Uncomplete" : "Complete",
    binding: binding("⌘↩", "Ctrl+Enter", "Meta+Enter", "Control+Enter"),
    eligibility: ALWAYS,
    execute: (context) => context.mode === "selection"
      ? context.selection.toggleComplete()
      : void context.store.setCompleted(
        context.node.id, !context.node.completed
      )
  },
  {
    id: "star",
    icon: () => Star,
    label: (context) => context.node.starred ? "Unstar" : "Star",
    eligibility: ALWAYS,
    execute: (context) => void context.store.setStarred(
      context.node.id, !context.node.starred
    )
  },
  {
    id: "delete",
    icon: () => Trash2,
    // Workflowy's label. Still a soft delete: Trash and restore are unchanged.
    label: () => "Delete",
    danger: true,
    binding: binding(
      "⌘⇧⌫", "Ctrl+Shift+Backspace",
      "Meta+Shift+Backspace", "Control+Shift+Backspace"
    ),
    eligibility: ALWAYS,
    execute: (context) => context.mode === "selection"
      ? context.selection.delete()
      : void context.store.deleteSubtree(context.node.id)
  },
  {
    id: "moveTo",
    icon: () => CornerUpRight,
    // Workflowy's own spelling, three literal dots: the item opens a chooser
    // rather than moving anything by itself.
    label: () => "Move To...",
    binding: binding("⌃⌘M", "Ctrl+Alt+M", "Control+Meta+M", "Control+Alt+M"),
    eligibility: (context) => context.forestComplete
      ? { available: true }
      : { available: false, reason: "Load the complete outline first." },
    execute: (context) => context.openMoveTo()
  },
  {
    id: "moveUp",
    icon: () => ArrowUp,
    label: () => "Move up",
    binding: binding(
      "⌃⇧↑", "Alt+Shift+↑", "Control+Shift+ArrowUp", "Alt+Shift+ArrowUp"
    ),
    eligibility: (context) => context.plans.up,
    execute: (context) => context.mode === "selection"
      ? context.selection.move("up")
      : runMove(context, context.plans.up)
  },
  {
    id: "moveDown",
    icon: () => ArrowDown,
    label: () => "Move down",
    binding: binding(
      "⌃⇧↓", "Alt+Shift+↓", "Control+Shift+ArrowDown", "Alt+Shift+ArrowDown"
    ),
    eligibility: (context) => context.plans.down,
    execute: (context) => context.mode === "selection"
      ? context.selection.move("down")
      : runMove(context, context.plans.down)
  },
  {
    id: "indent",
    icon: () => IndentIncrease,
    label: () => "Indent",
    binding: binding("Tab", "Tab", "Tab", "Tab"),
    eligibility: (context) => context.plans.indent,
    execute: (context) => context.mode === "selection"
      ? context.selection.indent()
      : runMove(context, context.plans.indent)
  },
  {
    id: "outdent",
    icon: () => IndentDecrease,
    label: () => "Outdent",
    binding: binding("⇧Tab", "Shift+Tab", "Shift+Tab", "Shift+Tab"),
    eligibility: (context) => context.plans.outdent,
    execute: (context) => context.mode === "selection"
      ? context.selection.outdent()
      : runMove(context, context.plans.outdent)
  },
  {
    id: "copy",
    icon: () => Copy,
    label: () => "Copy",
    binding: binding("⌘C", "Ctrl+C", "Meta+C", "Control+C"),
    // Copy never deletes, so a title-only serialization loses nothing that was
    // not already on screen. It stays reachable when everything else is not.
    eligibility: ALWAYS,
    execute: (context) => {
      if (context.mode === "selection") return context.selection.copy();
      const text = rowSubtreeText(context);
      if (text) void writeOutlineClipboard(text).catch(() => undefined);
    }
  },
  {
    id: "cut",
    icon: () => Scissors,
    label: () => "Cut",
    binding: binding("⌘X", "Ctrl+X", "Meta+X", "Control+X"),
    eligibility: (context) => context.cutRefusal === null
      ? { available: true }
      : { available: false, reason: context.cutRefusal },
    execute: (context) => {
      if (context.mode === "selection") return context.selection.cut();
      const text = rowSubtreeText(context);
      if (!text) return;
      // Delete only once the clipboard actually holds the subtree; a rejected
      // write must leave the row where it is rather than lose it.
      void writeOutlineClipboard(text)
        .then(() => context.store.deleteSubtree(context.node.id))
        .catch(() => undefined);
    }
  }
];

// `delete` sits last in both orders because it is the only destructive
// command here: trailing it keeps a keyboard user roving toward Indent from
// landing on it when they overshoot.
const ROW_ORDER: readonly OutlineMenuCommandId[] = [
  "addNote", "marker", "duplicate", "uploadImage", "complete", "star",
  "moveTo", "moveUp", "moveDown", "indent", "outdent", "copy", "cut", "delete"
];

// The legacy selection menu's order, minus the one command that has no
// implementation yet: Tags, which belongs before Copy.
const SELECTION_ORDER: readonly OutlineMenuCommandId[] = [
  "complete", "moveTo", "moveUp", "moveDown", "indent", "outdent", "duplicate",
  "copy", "cut", "delete"
];

export function outlineMenuCommands(
  mode: OutlineMenuMode
): readonly OutlineMenuCommand[] {
  const order = mode === "selection" ? SELECTION_ORDER : ROW_ORDER;
  return order.map((id) => {
    const command = OUTLINE_MENU_COMMANDS.find((entry) => entry.id === id);
    if (!command) throw new Error(`unknown outline menu command: ${id}`);
    return command;
  });
}
