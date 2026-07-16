# Notes Theme Editor Alignment Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Keep Soft Paper's Avenir Next font while preventing Notes text from shifting when editing starts.

**Architecture:** Theme typography owns two CSS alignment variables. Notes consumes those variables; a focused CSS contract test requires custom-font themes to calibrate them.

**Tech Stack:** CSS custom properties, Vitest

## Global Constraints

- Keep Soft Paper's Avenir Next font.
- Do not change React behavior, persistence, selection logic, or dependencies.
- Preserve the current offsets for themes using the shared font stack.

---

### Task 1: Theme-aware Notes editing offsets

**Files:**
- Modify: `src/styles.css:6-142`
- Modify: `src/features/notes/notes.css:867-873`
- Test: `src/features/notes/NotesWorkspace.test.tsx:6710-6718`

**Interfaces:**
- Consumes: theme `font-family` declarations and the existing Notes textarea selectors.
- Produces: `--notes-text-edit-offset` and `--notes-node-title-edit-offset` CSS variables.

- [x] **Step 1: Write the failing CSS contract test**

Replace the fixed-offset assertions with variable-consumption assertions, assert
the shared defaults, assert Soft Paper's zero offsets, and require every named
theme block containing `font-family` to contain both offset variables.

- [x] **Step 2: Run the focused test to verify RED**

Run: `npm test -- src/features/notes/NotesWorkspace.test.tsx -t "uses stable Workflowy row geometry"`

Expected: FAIL because the CSS variables do not exist and Notes still uses fixed pixel translations.

- [x] **Step 3: Implement the minimum CSS change**

Add shared defaults to `:root`, add zero-offset overrides beside Soft Paper's
font declaration, and replace the fixed translations with `var(...)` references.

- [x] **Step 4: Verify GREEN and project checks**

Run:

```bash
npm test -- src/features/notes/NotesWorkspace.test.tsx -t "uses stable Workflowy row geometry"
npm test
npm run lint
npm run build
git diff --check
```

Expected: every command exits 0.
