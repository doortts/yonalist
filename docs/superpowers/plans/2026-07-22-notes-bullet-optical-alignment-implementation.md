# Notes Bullet Optical Alignment Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Keep Notes bullet visuals centered on the stable title line box.

**Architecture:** Preserve the existing 28px button hit target and row grid. Use the existing flex centering without a content-dependent vertical transform.

**Tech Stack:** React, TypeScript, CSS, Vitest

## Global Constraints

- Do not change row height, title typography, grid columns, or the bullet hit target.
- Keep the dot and its hover/collapsed/focus indicator concentric and unshifted.
- Limit production changes to `src/features/notes/notes.css`.

---

### Task 1: Lock and implement optical bullet alignment

**Files:**
- Modify: `src/features/notes/NotesWorkspace.test.tsx`
- Modify: `src/features/notes/notes.css`

**Interfaces:**
- Consumes: existing `.notes-node-bullet::before` and `.notes-node-bullet-dot` selectors
- Produces: a stable no-vertical-transform visual alignment contract

- [x] **Step 1: Write the failing regression assertion**

Add assertions that neither bullet visual selector contains `translateY(...)`.

- [x] **Step 2: Verify the focused test fails**

Run: `npm test -- src/features/notes/NotesWorkspace.test.tsx`

Expected: FAIL because both selectors still have the overcorrecting transform.

- [x] **Step 3: Implement the minimal CSS change**

Remove `transform: translateY(-3px)` from `.notes-node-bullet::before` and
`.notes-node-bullet-dot`, leaving the button box and row geometry unchanged.

- [x] **Step 4: Verify the focused test passes**

Run: `npm test -- src/features/notes/NotesWorkspace.test.tsx`

Expected: PASS.

- [x] **Step 5: Run the frontend gates once**

Run `npm test`, `npm run lint`, `npm run build`, and `git diff --check`.

Expected: all commands exit successfully.
