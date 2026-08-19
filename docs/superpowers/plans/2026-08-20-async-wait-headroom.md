# Async wait headroom for the desktop test suite

## Problem

`src/appShortcuts.test.tsx > leaving the settings screen > puts the caret
back in the row it was taken from` failed in 2 of 4 full-suite runs on
2026-08-20 with `Unable to find role="navigation" and name "Settings
sections"`, yet passes 18/18 in isolation. The failure also reproduces at
baseline 78e26c81, so the CSS-only commits it landed with are innocent.

## Root cause (measured)

The failure is not order-dependence and not the settings chunk. Evidence:

- 9 idle full-suite runs: green. 3 runs under 12 `yes` CPU burners: green.
  4 runs with shuffled file order: green. So neither file order nor cheap
  CPU load reproduces it.
- Two full suites run concurrently (20 forks on 10 cores, double jsdom
  memory pressure — the realistic shape of this machine while several
  Claude sessions build and test at once): 2 of 3 rounds failed, on
  `src/image/imageStructuralIntegration.test.tsx > selects the image from
  its caret and copies the bytes themselves` — a different file, the same
  failure class. One idle run also showed aggregate test wall time doubling
  (`tests 121.94s` vs the usual ~58s) purely from the suite's own 10-fork
  self-contention.

So the defect is suite-wide, not in the named test: every `findBy*` /
`waitFor` in the 90-file suite rides Testing Library's default
`asyncUtilTimeout` of 1000 ms, a wall-clock budget. When co-running
workloads starve a fork for about a second, whichever test happens to be
inside such a wait fails; which test that is varies per run, which is what
made it look order-dependent. The earlier warm-up of the settings chunk
(a14dd5f9) attacked chunk-compile cost and therefore could not cure it.

## Fix

Give every async wait headroom instead of patching one victim test.

| Knob | From | To | Where |
| --- | --- | --- | --- |
| `asyncUtilTimeout` | 1000 ms (default) | 10_000 ms | `apps/desktop/src/test/setup.ts` |
| Vitest `testTimeout` | 5000 ms (default) | 30_000 ms | `apps/desktop/vite.config.ts` |

`configure` comes from `@testing-library/dom`, not `@testing-library/react`:
the react package re-exports the same singleton, but importing it in the
shared setup file loads react-dom into all 90 test files when only 38 use
it — measured at ~3 s of idle wall time (17.9 s → 20.7 s). The dom package
is already the react package's peer dependency (`^10.0.0`, installed
10.4.1) and merely undeclared, so declaring it in the root
`devDependencies` is a correction, not a new dependency.

Both are ceilings, not sleeps: passing waits still return on the next
50 ms poll, so green-run duration is unchanged. `testTimeout` must rise
with `asyncUtilTimeout`, otherwise a test whose several waits each
legitimately stretch under load trades a readable "unable to find role"
failure (with DOM dump) for an opaque 5 s test-timeout kill. 10 s / 30 s
keeps that ordering: a single starved wait always reports as itself.

## Acceptance

| # | Row | Proof |
| --- | --- | --- |
| 1 | Red first: the failure class reproduces before the change | Two concurrent full suites, 3 rounds: at least one round fails on an RTL async wait (recorded verbatim: rounds 1 and 3, `imageStructuralIntegration.test.tsx`, `Unable to find …` / waitFor timeout) |
| 2 | Green after: same concurrent-suite experiment passes 3/3 rounds | Same command, after the two-knob change |
| 3 | Idle full suite still green and not slower | `npm test` wall time within noise of the ~15 s baseline |

## Non-goals

- No change to `appShortcuts.test.tsx` itself; its existing chunk warm-up
  stays.
- No per-test `{ timeout }` overrides — the point is retiring the 1 s
  default everywhere at once.
- No change to fork count / `maxWorkers`: throttling the suite would slow
  every green run to protect against a load pattern the timeout headroom
  already absorbs.
- The pre-existing unhandled rejection from `notesStore.test.ts`
  (`receipt.changedNodes` on an `execute` mock returning `undefined`) is a
  separate defect, handled outside this change.

## Items

One item. Two lines of configuration prove or fail together; splitting
them would manufacture a commit whose test cannot go red on its own.

| Item | Change | Test that proves it |
| --- | --- | --- |
| 1 | `configure({ asyncUtilTimeout: 10_000 })` in `src/test/setup.ts` (import from `@testing-library/dom`); `testTimeout: 30_000` in `vite.config.ts` test block; `@testing-library/dom` declared in root `devDependencies` | Acceptance rows 1–3 (red = pre-change concurrent failure log, green = post-change 3/3 concurrent rounds + idle run) |

## Boundaries

Frontend test infrastructure only, plus one root `devDependencies` line.
No production code, no Rust, no IPC, no persistence. Final gates per
`delivering-yonalist-changes`:
frontend-only row (`npm test`, `npm run lint`, `npm run build`,
`git diff --check`); Cargo gates explicitly skipped.
