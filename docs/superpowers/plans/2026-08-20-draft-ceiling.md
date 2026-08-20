# A typing run cannot postpone the database forever

## Why

`StoreDrafts.setTitle`/`setNote` hold each keystroke as a draft and commit it
300ms after the typing pauses (`storeDrafts.ts:76,114`, `DRAFT_DEBOUNCE_MS` in
`storeSupport.ts:69`). Every keystroke cancels the previous timer and starts a
new one — a pure trailing debounce with no ceiling. Someone typing steadily,
never pausing 300ms, postpones the SQLite commit for the whole run, so the
crash-loss window is not 300ms: it is the length of the typing run. Blur,
arrow keys and ⌘-commands flush explicitly, but a process crash or an OS kill
mid-sentence takes the sentence.

The backend already solves this exact shape for exports: `Debounce` in
`notes-sync` fires on idle **or** at a ceiling since the first unsaved change,
whichever comes first. The drafts get the same rule, scaled to keystrokes.

## Contract

| Field | Content |
| --- | --- |
| Goal | While the user types without pausing, the draft still reaches SQLite at a bounded interval, so a crash loses at most the ceiling's worth of keystrokes. |
| Acceptance | A1: continuous `setTitle` calls (gaps under 300ms) trigger a commit no later than `DRAFT_CEILING_MS` after the first uncommitted keystroke, and again each ceiling window while typing continues. A2: the same for `setNote`. A3: a pause still commits after 300ms exactly as today, and a run shorter than the ceiling commits once, not twice. A4: a ceiling-fired commit does not split the undo step — the run's history group is the same one the pause-fired commit would use. |
| Non-goals | No change to the backend export debounce. No change to flush-on-blur/command paths. No configurability. |
| Boundaries | Frontend only: `apps/desktop/src/store/storeDrafts.ts`, `storeSupport.ts` (the new constant), and `storeDrafts.test.ts`. |
| Manual proof | N/A — timing behavior, locked by fake-timer tests. |

## Item (one commit)

`DRAFT_CEILING_MS = 3_000` beside `DRAFT_DEBOUNCE_MS` in `storeSupport.ts`.
Three seconds mirrors the backend's idle window: at most one sentence of
steady typing is ever exposed to a crash, and a commit every three seconds is
far below any rate SQLite would feel.

In `StoreDrafts`, track when each key's pending run began: a
`Map<string, number>` (`firstPending`), set on the first `setTitle`/`setNote`
after a flush, cleared by `flushTitle`/`flushNote`/`cancel*`. In
`setTitle`/`setNote`, after storing the draft: if `now - firstPending >=
DRAFT_CEILING_MS`, skip the timer and flush right away (same
fire-and-forget `void this.flushTitle(id).catch(() => undefined)` shape the
timer uses, and for the same reason — nobody awaits a debounce); otherwise
schedule the 300ms timer as today.

History grouping needs no new code, only the assertion (A4): a ceiling flush
commits with the run's existing group (`text:${id}` / the backspace group),
and the group fence moves only on a long pause, so the commits coalesce into
one undo step exactly as a pause-fired commit would.

Test with the file's existing fake-timer scaffolding: type every 100ms for
ten seconds and count `execute` calls (at least one by 3s, roughly one per
ceiling window, not one per keystroke); a single burst then silence commits
once at 300ms; undo grouping across a ceiling-fired commit stays one step.
Red first: the A1 test fails against today's code because `execute` is never
called while the keystrokes keep coming.

## Gates

Frontend-only: owning test in the loop; `npm test`, `npm run lint`,
`npm run build`, `git diff --check` once at the end.
