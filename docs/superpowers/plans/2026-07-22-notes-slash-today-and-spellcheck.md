# Notes Slash Today and Spellcheck Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a Codex-style `/` command menu with a `Today` date insertion command to Notes bullet titles and disable OS spellcheck/autocorrection in Notes editors.

**Architecture:** A pure command model recognizes and applies slash queries. A portalled menu view is owned by the shared `NoteTextField`, while outline rows and zoomed page titles opt in through a boolean prop. Existing controlled input events remain the only draft mutation path.

**Tech Stack:** React 19, TypeScript, Vitest, Testing Library, Lucide React, CSS, existing Notes draft/history APIs

## Global Constraints

- Slash commands are limited to editable text bullet titles and zoomed text page titles.
- Supporting notes and image-atom text do not open the slash menu.
- `Today` inserts local `YYYY-MM-DD` and preserves text after the caret.
- Keyboard, pointer, IME, read-only, focus return, and accessibility behavior must match the approved design.
- Spellcheck, autocorrection, and automatic capitalization are disabled only inside Notes editors.
- No persistence schema, IPC, Rust, or SQLite changes.

---

### Task 1: Pure Slash Command Model

**Files:**
- Create: `src/features/notes/notesSlashCommands.ts`
- Create: `src/features/notes/notesSlashCommands.test.ts`

**Interfaces:**
- Consumes: `LocalDate` and `formatLocalDateIso` from `noteDates.ts`
- Produces: `NotesSlashCommandId`, `NotesSlashCommandDefinition`, `NotesSlashCommandQuery`, `notesSlashCommandDefinitions`, `resolveNotesSlashCommandQuery`, `filterNotesSlashCommands`, and `applyNotesSlashCommand`

- [ ] **Step 1: Write failing model tests**

```ts
expect(resolveNotesSlashCommandQuery("/tod later", 4, 4)).toEqual({
  startUtf16: 0,
  endUtf16: 4,
  query: "tod"
});
expect(resolveNotesSlashCommandQuery("Plan /tod", 9, 9)).toBeNull();
expect(filterNotesSlashCommands("TOD").map(({ id }) => id)).toEqual(["today"]);
expect(
  applyNotesSlashCommand(
    "/tod later",
    { startUtf16: 0, endUtf16: 4, query: "tod" },
    "today",
    { year: 2026, month: 7, day: 22 }
  )
).toEqual({ value: "2026-07-22 later", caretUtf16: 10 });
```

Also assert null for expanded selections, whitespace in the query, a caret
before `/`, and unmatched command prefixes.

- [ ] **Step 2: Run the model test and verify RED**

Run: `npx vitest run src/features/notes/notesSlashCommands.test.ts`

Expected: FAIL because the command model module does not exist.

- [ ] **Step 3: Implement the pure model**

```ts
export type NotesSlashCommandId = "today";

export interface NotesSlashCommandDefinition {
  readonly id: NotesSlashCommandId;
  readonly label: string;
  readonly description: string;
}

export interface NotesSlashCommandQuery {
  readonly startUtf16: 0;
  readonly endUtf16: number;
  readonly query: string;
}

export const notesSlashCommandDefinitions = [
  { id: "today", label: "Today", description: "Insert today's date" }
] as const satisfies readonly NotesSlashCommandDefinition[];
```

`resolveNotesSlashCommandQuery` accepts only a collapsed caret after a leading
slash and an ASCII-letter prefix. `filterNotesSlashCommands` performs a
case-insensitive label prefix match. `applyNotesSlashCommand` replaces exactly
the query range and obtains the date text from `formatLocalDateIso(today)`.

- [ ] **Step 4: Run the model test and verify GREEN**

Run: `npx vitest run src/features/notes/notesSlashCommands.test.ts`

Expected: all model tests pass.

- [ ] **Step 5: Commit the model**

```bash
git add src/features/notes/notesSlashCommands.ts src/features/notes/notesSlashCommands.test.ts
git commit -m "feat(notes): add slash command model"
```

---

### Task 2: Portalled Menu and Shared Text Field Integration

**Files:**
- Create: `src/features/notes/NotesSlashCommandMenu.tsx`
- Create: `src/features/notes/NotesSlashCommandMenu.test.tsx`
- Modify: `src/features/notes/NoteTextField.tsx`
- Modify: `src/features/notes/NoteTextField.test.tsx`
- Modify: `src/features/notes/notes.css`
- Modify: `src/features/notes/OutlineNodeRow.tsx`
- Modify: `src/features/notes/NotesPageHeader.tsx`

**Interfaces:**
- Consumes: Task 1 command definitions and replacement functions
- Produces: `NotesSlashCommandMenu` and `NoteTextFieldProps.slashCommands?: boolean`

- [ ] **Step 1: Write failing menu and text-field tests**

Menu tests render one option and verify `role="listbox"`, `role="option"`,
label, description, active state, pointer selection, and viewport-clamped
fixed positioning.

Text field tests use a controlled harness:

```tsx
function SlashHarness({ initial = "" }: { initial?: string }) {
  const [value, setValue] = useState(initial);
  return (
    <NoteTextField
      slashCommands
      value={value}
      today={{ year: 2026, month: 7, day: 22 }}
      aria-label="Edit node title"
      onChange={(event) => setValue(event.target.value)}
      onTagClick={vi.fn()}
    />
  );
}
```

Assert that `/` opens the menu; `/tod` filters to `Today`; Enter and pointer
selection produce `2026-07-22`; Escape dismisses; invalid text and composition
do not open; text after the caret is preserved; focus and caret return after
commit; and a field without `slashCommands` never opens the menu.

- [ ] **Step 2: Run the focused tests and verify RED**

Run:

```bash
npx vitest run src/features/notes/NotesSlashCommandMenu.test.tsx \
  src/features/notes/NoteTextField.test.tsx -t "slash command"
```

Expected: FAIL because the menu and opt-in input behavior are absent.

- [ ] **Step 3: Implement the menu view and placement**

`NotesSlashCommandMenu` receives:

```ts
interface NotesSlashCommandMenuProps {
  readonly anchor: HTMLTextAreaElement;
  readonly commands: readonly NotesSlashCommandDefinition[];
  readonly activeIndex: number;
  readonly onSelect: (id: NotesSlashCommandId) => void;
}
```

It renders into `document.body`, recomputes a fixed and viewport-clamped
position on resize and capture-phase scroll, prevents option pointer down from
blurring the textarea, and invokes `onSelect` on click.

- [ ] **Step 4: Integrate transient command state into `NoteTextField`**

Add `slashCommands?: boolean`. On non-composing input and selection changes,
derive a query with `resolveNotesSlashCommandQuery`; filter definitions; and
open only when matches exist. While open, Arrow Up/Down updates the active
index, Enter applies the selected command, and Escape closes it before the
outline key handler runs.

Apply a command with the native textarea `value` setter and a bubbling `input`
event, then restore focus and the returned caret in a microtask. Set
`aria-controls`, `aria-expanded`, `aria-haspopup="listbox"`, and
`aria-activedescendant` only while open.

Pass `slashCommands` only to the title `NoteTextField` in `OutlineNodeRow` and
`NotesPageHeader`.

- [ ] **Step 5: Add menu styling**

Create `.notes-slash-command-menu`, `.notes-slash-command-option`, label, and
description rules in `notes.css`. Reuse `var(--bg-card)`,
`var(--border-strong)`, `var(--shadow-modal)`, `var(--bg-hover)`, and existing
12.5px compact menu typography. Use an 8px maximum viewport inset and no
decorative animation.

- [ ] **Step 6: Run owning tests and verify GREEN**

Run:

```bash
npx vitest run src/features/notes/notesSlashCommands.test.ts \
  src/features/notes/NotesSlashCommandMenu.test.tsx \
  src/features/notes/NoteTextField.test.tsx
```

Expected: all tests pass without console errors.

- [ ] **Step 7: Commit the menu integration**

```bash
git add src/features/notes/NotesSlashCommandMenu.tsx \
  src/features/notes/NotesSlashCommandMenu.test.tsx \
  src/features/notes/NoteTextField.tsx \
  src/features/notes/NoteTextField.test.tsx \
  src/features/notes/notes.css \
  src/features/notes/OutlineNodeRow.tsx \
  src/features/notes/NotesPageHeader.tsx
git commit -m "feat(notes): add today slash menu"
```

---

### Task 3: Spellcheck Attributes and Workspace Proof

**Files:**
- Modify: `src/features/notes/NoteTextField.tsx`
- Modify: `src/features/notes/NoteTextField.test.tsx`
- Modify: `src/features/notes/ImageAtomEditor.tsx`
- Modify: `src/features/notes/ImageAtomEditor.test.tsx`
- Modify: `src/features/notes/NotesWorkspace.test.tsx`

**Interfaces:**
- Consumes: Task 2 `slashCommands` title integration and existing workspace draft actions
- Produces: Notes-only platform text-assistance opt-out and end-to-end slash insertion coverage

- [ ] **Step 1: Write failing spellcheck and workspace tests**

Assert every `NoteTextField` textarea and the image-atom editable host have:

```ts
expect(editor).toHaveAttribute("spellcheck", "false");
expect(editor).toHaveAttribute("autocorrect", "off");
expect(editor).toHaveAttribute("autocapitalize", "off");
```

In `NotesWorkspace.test.tsx`, type `/`, execute `Today`, and assert
`actions.updateNodeDraft` receives `2026-07-11` for both a normal outline row
and an activated zoomed page title under the existing injected today provider.

- [ ] **Step 2: Run the focused tests and verify RED**

Run:

```bash
npx vitest run src/features/notes/NoteTextField.test.tsx \
  src/features/notes/ImageAtomEditor.test.tsx \
  src/features/notes/NotesWorkspace.test.tsx -t "spellcheck|slash Today"
```

Expected: FAIL because the attributes and workspace command behavior are not
fully present.

- [ ] **Step 3: Disable platform text assistance**

Set these explicit attributes after prop spreading on the native textarea and
image-atom contenteditable host:

```tsx
spellCheck={false}
autoCorrect="off"
autoCapitalize="off"
```

Explicit placement prevents callers from accidentally re-enabling them inside
Notes while leaving non-Notes inputs unchanged.

- [ ] **Step 4: Run focused and owning tests**

Run:

```bash
npx vitest run src/features/notes/notesSlashCommands.test.ts \
  src/features/notes/NotesSlashCommandMenu.test.tsx \
  src/features/notes/NoteTextField.test.tsx \
  src/features/notes/ImageAtomEditor.test.tsx
npx vitest run src/features/notes/NotesWorkspace.test.tsx -t "slash Today|spellcheck"
```

Expected: all targeted tests pass.

- [ ] **Step 5: Run final frontend gates and desktop smoke test**

Run:

```bash
npx eslint src/features/notes/notesSlashCommands.ts \
  src/features/notes/notesSlashCommands.test.ts \
  src/features/notes/NotesSlashCommandMenu.tsx \
  src/features/notes/NotesSlashCommandMenu.test.tsx \
  src/features/notes/NoteTextField.tsx \
  src/features/notes/NoteTextField.test.tsx \
  src/features/notes/ImageAtomEditor.tsx \
  src/features/notes/ImageAtomEditor.test.tsx \
  src/features/notes/OutlineNodeRow.tsx \
  src/features/notes/NotesPageHeader.tsx \
  src/features/notes/NotesWorkspace.test.tsx
npm run build
git diff --check
```

Reload the running Tauri app, create an empty bullet, type `/tod`, select
`Today` by keyboard and pointer, verify the `YYYY-MM-DD` result, and type an
English word to confirm the macOS correction popup does not appear.

- [ ] **Step 6: Review and commit**

Review the final diff against every accepted requirement, then commit:

```bash
git add src/features/notes
git commit -m "fix(notes): disable platform text assistance"
```
