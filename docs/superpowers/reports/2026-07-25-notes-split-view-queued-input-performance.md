# Notes Split View Queued Input Performance

## Environment

- Date: 2026-07-25
- Production base: `788ace7995116aa5f6c843263a96a0bfee3aa592`
- Frozen benchmark source: `fd3f69b` (`test(notes): capture split input baseline`)
- Measurement worktree: the production base plus the benchmark-only diff that
  became `fd3f69b`. After the run, `rustfmt` changed one line wrap and this
  report was written; no executable behavior changed before that commit.
- Hardware: Apple M1 Pro, 10 cores, 32 GB
- OS: macOS 15.7.1
- App: fresh Tauri development process with the isolated benchmark bundle ID
- Seed signature: `5000|50|5` (5,000 Notes nodes, 50 roots, five consecutive
  empty roots)
- Runtime: the app adds one reserved GitHub Notifications root, so the
  pre-change desktop run contains 5,001 active nodes. The post-change run must
  verify the same signature before comparison.
- Verified post-start signature: `5001|51|5`, with 52 sync topics, zero dirty
  nodes, and distinct Markdown names for all 50 seeded roots
- View: split open with 50 visible title rows in each pane
- Post-change measurements and the native-close permission repair were each
  checked in a freshly rebuilt process.

Each Arrow, Enter, and held-Backspace row uses 10 warmups followed by 50
measured operations.
Invalid overlapping samples were discarded and the run was repeated with a
longer interval. Every reported Arrow or Enter row contains 50 valid samples
and zero invalid samples. The pre-change held-Backspace row contains one
physical gesture because the frozen baseline captured the reported failure
before the repeated workload was added. Latencies are measured from the
physical keydown.

Percentiles use the nearest-rank rule: sort the valid values ascending and
select index `ceil(sampleCount * percentile) - 1`, without interpolation.

### Commands

The fixture was seeded and the app launched with:

```bash
BENCHMARK_ROOT="/path/to/isolated-benchmark-root"
BENCHMARK_NOTES_ROOT="/path/to/isolated-app-support-notes-root"
YONALIST_SPLIT_INPUT_BENCH_VAULT="$BENCHMARK_ROOT/vault" \
YONALIST_SPLIT_INPUT_BENCH_NOTES_ROOT="$BENCHMARK_NOTES_ROOT" \
cargo test --manifest-path src-tauri/Cargo.toml \
  notes::performance::seed_split_input_benchmark_vault \
  -- --ignored --exact --nocapture

npm run tauri:dev -- \
  --config src-tauri/tauri.split-input-benchmark.conf.json
```

The controller used the following exact workloads. `BENCHMARK_PROCESS`
identifies the freshly built benchmark app; the next numeric argument in the
Arrow and Enter commands is the macOS key code for the pane-focus shortcut:

```bash
# Arrow: 5 alternating pairs warm up 10 inputs; 25 pairs measure 50.
osascript "$BENCHMARK_ROOT/measure_arrow.scpt" \
  "$BENCHMARK_PROCESS" 18 5 25 0.12
osascript "$BENCHMARK_ROOT/measure_arrow.scpt" \
  "$BENCHMARK_PROCESS" 19 5 25 0.35

# Clean Enter: mode, warmups, measurements, settlement wait, Undo wait.
osascript "$BENCHMARK_ROOT/measure_enter.scpt" \
  "$BENCHMARK_PROCESS" 35 clean 10 50 0.5 0.4
osascript "$BENCHMARK_ROOT/measure_enter.scpt" \
  "$BENCHMARK_PROCESS" 31 clean 10 50 0.9 0.6

# Enter immediately after a one-character title edit.
osascript "$BENCHMARK_ROOT/measure_enter.scpt" \
  "$BENCHMARK_PROCESS" 35 dirty 10 50 0.9 0.6
osascript "$BENCHMARK_ROOT/measure_enter.scpt" \
  "$BENCHMARK_PROCESS" 31 dirty 10 50 0.9 0.6

# Held Backspace: 10 warmups, 50 measurements, 1,500 ms hold,
# 350 ms initial delay, 50 ms repeats, 2.2 s backlog check, then Undo.
"$BENCHMARK_ROOT/measure_backspace.sh" \
  "$BENCHMARK_PROCESS" primary 10 50 1500 50 2.2 0.8
"$BENCHMARK_ROOT/measure_backspace.sh" \
  "$BENCHMARK_PROCESS" secondary 10 50 1500 50 2.2 0.8

# Held Enter smoke: one initial keydown plus four 75 ms repeats after the
# normal 350 ms repeat delay, sent through the HID event path.
"$BENCHMARK_ROOT/hold_enter" \
  "$BENCHMARK_PROCESS" 650 75
```

The controller parsed the selected collector JSON with
`summarize_samples.mjs` or `summarize_post_samples.mjs`. Raw arrays were not
retained in the repository; the tables below record the valid count and every
relevant aggregate emitted by those scripts.

## Before

| Operation | Pane | Warmup / valid / invalid | Visible p50 / p95 | Authoritative p50 / p95 | Active commits p50 / p95 | Inactive commits p50 / p95 |
| --- | --- | ---: | ---: | ---: | ---: | ---: |
| Arrow | Primary | 10 / 50 / 0 | 25 / 33 ms | N/A | 4 / 4 | 2 / 2 |
| Arrow | Secondary | 10 / 50 / 0 | 73 / 81 ms | N/A | 5 / 5 | 2 / 2 |
| Enter, clean title | Primary | 10 / 50 / 0 | 31 / 39 ms | 300 / 415 ms | 12 / 15 | 6 / 9 |
| Enter, clean title | Secondary | 10 / 50 / 0 | 32 / 37 ms | 246 / 284 ms | 9 / 10 | 9 / 10 |
| Enter, pending title edit | Primary | 10 / 50 / 0 | 31 / 41 ms | 437 / 494 ms | 14 / 15 | 8 / 9 |
| Enter, pending title edit | Secondary | 10 / 50 / 0 | 30 / 40 ms | 434 / 508 ms | 12 / 12 | 12 / 12 |

### Held Backspace before

A trusted 1.5-second Backspace gesture sent an initial keydown, then repeat
keydowns every 50 ms after the normal 350 ms repeat delay.

| Pane | Result |
| --- | --- |
| Primary | Removed only one of five empty bullets. Visible at 466 ms; keyup and authoritative settlement at 1,582 ms. Primary/secondary pane commits: 6/5. One Undo restored the deleted bullet. |
| Secondary | Did not complete the gesture lifecycle. The first visible change was recorded at 5,145 ms, with 16 active-pane and 17 inactive-pane commits; keyup and authoritative settlement were missing. One Undo left all five empty bullets present. |

The baseline therefore reproduces both reported faults: OS repeat events do
not continue removing eligible empty bullets, and the secondary pane can stay
busy for several seconds.

### Excluded calibration runs

- Secondary Arrow at a 120 ms interval: 48/50 samples overlapped.
- Secondary clean Enter at a 500 ms settlement interval: 14/48 captured
  samples overlapped and two keydowns were missed.
- Early long Enter runs used numeric focus shortcuts and exposed an Undo focus
  race; the final runs used pane-specific shortcuts and verified or delayed
  focus before every sample.
- The first held-Enter helper posted directly to the process, and only the
  initial keydown reached the DOM. It was excluded and rerun through the HID
  event path, which delivered the initial event and all four repeats.

These runs were not included in the table.

## After

The post-change Arrow and Enter run reused the frozen Vault, physical key
emitter, intervals, collector, and percentile calculation. Its verified
runtime signature was again `5001|51|5`. Every Arrow and Enter row contains 50
valid samples, zero invalid overlaps, zero late operations after two seconds,
and zero backlog at two seconds. The held-Backspace controller used the same
collector and restored the fixture with Undo between samples.

| Operation | Pane | Warmup / valid / invalid | Visible p50 / p95 | Authoritative p50 / p95 | Active commits p50 / p95 (max) | Inactive commits p50 / p95 (max) |
| --- | --- | ---: | ---: | ---: | ---: | ---: |
| Arrow | Primary | 10 / 50 / 0 | 3 / 3 ms | N/A | 3 / 3 (3) | 1 / 1 (1) |
| Arrow | Secondary | 10 / 50 / 0 | 5 / 6 ms | N/A | 4 / 4 (4) | 1 / 1 (1) |
| Enter, clean title | Primary | 10 / 50 / 0 | 26 / 36 ms | 136 / 150 ms | 14 / 16 (16) | 7 / 9 (10) |
| Enter, clean title | Secondary | 10 / 50 / 0 | 28 / 38 ms | 140 / 156 ms | 11 / 11 (11) | 7 / 7 (7) |
| Enter, pending title edit | Primary | 10 / 50 / 0 | 23 / 27 ms | 231 / 255 ms | 15 / 16 (16) | 8 / 10 (11) |
| Enter, pending title edit | Secondary | 10 / 50 / 0 | 25 / 29 ms | 231 / 242 ms | 12 / 13 (13) | 8 / 9 (9) |

The Arrow rows come from the retained inactive-pane identity source. The four
Enter rows were rerun after the final synchronous provisional-render change;
each contains 50 valid samples from a freshly rebuilt process. The final
source therefore has a complete aggregate for every blocking Enter workload.

The persistence distribution is not a tens-of-milliseconds result. Clean
Enter authoritative settlement measured 136–156 ms at p50/p95, while dirty
Enter measured 231–255 ms. These values include the serialized draft,
structural, SQLite, reconciliation, and observation path under the 5,001-node
desktop workload. They support asynchronously queueing normal input with a
strict drain on Vault switch and close, but do not support assuming that the
queue normally empties within only a few tens of milliseconds.

## Improvement

| Operation | Pane | Visible p95 before → after | Change | Authoritative p95 before → after | Change |
| --- | --- | ---: | ---: | ---: | ---: |
| Arrow | Primary | 33 → 3 ms | 90.9% faster | N/A | N/A |
| Arrow | Secondary | 81 → 6 ms | 92.6% faster | N/A | N/A |
| Enter, clean title | Primary | 39 → 36 ms | 7.7% faster | 415 → 150 ms | 63.9% faster |
| Enter, clean title | Secondary | 37 → 38 ms | 2.7% slower | 284 → 156 ms | 45.1% faster |
| Enter, pending title edit | Primary | 41 → 27 ms | 34.1% faster | 494 → 255 ms | 48.4% faster |
| Enter, pending title edit | Secondary | 40 → 29 ms | 27.5% faster | 508 → 242 ms | 52.4% faster |

The fixed acceptance gates use visible p95:

| Gate | Primary | Secondary | Verdict |
| --- | ---: | ---: | --- |
| Arrow ≤ 32 ms | 3 ms | 6 ms | PASS / PASS |
| Clean Enter ≤ 35 ms | 36 ms | 38 ms | **FAIL** / **FAIL** |
| Dirty Enter ≤ 35 ms | 27 ms | 29 ms | PASS / PASS |

Arrow latency is decisively fixed in both panes. Enter persistence settlement
improved by 45–64%, and dirty Enter now clears the visible gate in both panes.
Clean Enter still misses by 1 ms in the primary pane and 3 ms in the secondary
pane; secondary clean Enter is 1 ms slower than the frozen baseline. The
result is therefore a measured partial performance improvement, not a claim
that every split-view performance target is complete.

The held-Backspace baseline has only one gesture per pane, so a before/after
percentile change would be misleading. The direct comparison is behavioral:
the primary pane previously removed one empty row and the secondary pane did
not complete its lifecycle; after the change, both panes completed 50/50
gestures with 3 ms visible p95, one-step Undo, and no two-second backlog.

### Diagnostic A/B work

Only evidence-backed changes remain in the final source.

- An explicit row-export memo bridge produced no render-count reduction and
  was reverted.
- Splitting volatile shell props measured 38/50 ms versus 38/49 ms for the
  comparison run and was reverted.
- Stable drag-and-drop items plus omitting provisional `useSortable` work
  reduced an instrumented unchanged-sibling hook count from three to zero, but
  did not improve the real desktop workload. With the candidate, secondary
  clean Enter measured 37/49 ms visible and 134/158 ms authoritative; the
  same-process run after reverting it measured 39/51 ms and 136/159 ms. The 2 ms
  difference was noise-sized, so all 141 candidate lines were removed.
- Reusing one frozen empty optimistic-insertion array removed avoidable
  inactive-pane prop identity changes and passed its Profiler RED/GREEN test,
  so that narrow change remains.
- Restoring the historical active-first context boundary kept Arrow at 3/6 ms
  but worsened secondary clean Enter to 36/57 ms p50/p95, versus the retained
  candidate's 49 ms p95. Its five-file owning set passed 101/101, but the
  blocking desktop result failed, so the candidate was completely reverted.
- A bounded phase probe then separated provisional preparation, queue
  admission, first focus, and the draft barrier. Preparation and queue
  admission finished within 0–3 ms; first focus arrived at 34–46 ms, and the
  draft barrier did not arrive until 69–79 ms. This ruled out the write queue
  and draft barrier as causes of the visible delay.
- The retained fix commits the provisional React update before the preparation
  callback and queue work continue. Its RED/GREEN row test checks
  that the new row is rendered and focused before preparation is reported.
  The first owning run caught a dropped-command focus regression because the
  provisional row had replaced the original recovery target; preserving the
  pre-insertion focus fixed that existing recovery test. The two owning files
  then passed 314/314.
- Focusing the provisional row with browser scrolling suppressed measured
  29/51 ms p50/p95 in a 10-sample secondary clean check, worse than the
  retained path, and was reverted with its test condition.

The retained optimizations suppress the full-workspace loading transition
only for optimistic keyboard insertion and ensure that its provisional row
is committed synchronously. Ordinary structural work still shows loading, a
rejected prepared insertion still reaches `error`, and clean or dirty
provisional insertion remains `ready`.

## Functional verification

### Held Backspace and one-step Undo

Both panes began from the exact `5001|5001|51|5` fixture. Each pane ran 10
warmups followed by 50 measured gestures. Every gesture held Backspace for
1,500 ms, with the normal 350 ms initial delay and repeat events every 50 ms,
waited through the two-second backlog window, and used one application Undo
to restore the fixture before the next gesture.

| Pane | Warmup / valid / invalid | First visible p50 / p95 | Keyup p50 / p95 | Authoritative p50 / p95 | Undo restored p50 / p95 |
| --- | ---: | ---: | ---: | ---: | ---: |
| Primary | 10 / 50 / 0 | 2 / 3 ms | 1,585 / 1,601 ms | 1,772 / 1,794 ms | 4,340 / 4,372 ms |
| Secondary | 10 / 50 / 0 | 2 / 3 ms | 1,587 / 1,601 ms | 1,771 / 1,797 ms | 4,354 / 4,382 ms |

| Pane | Active commits p50 / p95 (max) | Inactive commits p50 / p95 (max) | Late work / backlog / incomplete windows |
| --- | ---: | ---: | ---: |
| Primary | 43 / 45 (46) | 57 / 60 (62) | 0 / 0 / 0 |
| Secondary | 32 / 33 (33) | 41 / 45 (45) | 0 / 0 / 0 |

All four phases—first visible transition, keyup, authoritative settlement,
and Undo restoration—were present in all 50 samples in both panes. The final
database signature was again `5001|5001|51|5`. A separately inspected gesture
showed `active=4996`, five deleted rows in one deletion batch, zero remaining
empty roots, and the preceding title shortened from `Benchmark node 0044` to
`Benchm`. One Undo restored `active=5001`, `deleted=0`, 51 active roots, all
five empty roots, and the complete preceding title.

The 3 ms visible p95 clears the 35 ms transition gate in both panes. The
1.77–1.80 second authoritative timing is measured from the initial keydown and
therefore includes the 1.5-second physical hold. No gesture produced work
after the two-second post-keyup observation point.

### Held Enter desktop smoke

A final-source 650 ms HID gesture sent one initial Enter followed by four
repeat events at 75 ms intervals after the normal 350 ms delay. The collector
recorded five Enter operations in the primary pane, all with both visible and
authoritative phases. The four repeat samples overlap because they belong to
one physical hold, so this smoke check does not report percentiles. The raw
elapsed ranges were 30–75 ms for the visible phase and 161–412 ms for
authoritative settlement; only the initial sample was non-overlapping.

SQLite grew from 5,001 to 5,006 active nodes and blank titles from five to
ten. A second gesture inspected before opening the collector confirmed that
focus remained on the final blank row. Five application Undo operations
restored the exact `5001|5001|51|5` fixture after each check.

### Keyboard repeat audit

| Input | Repeat policy | Repeated-event behavior |
| --- | --- | --- |
| Plain text Backspace | Native repeat | Left to the native editor |
| Eligible empty-row Backspace | App repeat | Continues the held gesture and removes eligible rows |
| ArrowUp / ArrowDown | App repeat | Continues moving focus |
| Cross-row ArrowLeft / ArrowRight | App repeat | Continues crossing row boundaries |
| Plain Enter | App repeat | Continues splitting/inserting |
| Shift+Enter | One-shot | Repeated event ignored |
| Completion toggle (Command/Ctrl+Enter) | One-shot | Repeated event ignored |
| Tab / Shift+Tab | One-shot | Repeated event consumed without another move |
| Move shortcut | One-shot | Repeated event consumed without another move |
| Duplicate shortcut | One-shot | Repeated event ignored |
| Delete shortcut | One-shot | Repeated event ignored |
| Zoom shortcuts | One-shot | Repeated event consumed |
| Undo / Redo | One-shot | Repeated event consumed without traversing another history entry |
| F6 | One-shot | The outline capture layer ignores repeat; the initial event moves focus |
| Image Alt+Arrow structural navigation | One-shot | Repeated event ignored |

The table-driven resolver test covers every row through Zoom, with separate
cases for move, duplicate, completion toggle, and delete. A workspace
integration test covers F6 at its actual capture layer. Undo and Redo have
dedicated repeated-event resolver cases, and the image Alt+Arrow case has its
own resolver regression test. Held Enter additionally has workspace
integration coverage for provisional-row chaining, command order, focus,
shared history epoch with distinct entries, settlement order, and same-source
de-duplication.

The held-Enter failure came from the provisional-row guard rejecting every
`repeat` event even though authoritative rows accepted plain Enter repeats.
Removing only that predicate lets a repeat split the newly projected row;
composition and every modifier combination remain rejected, and the existing
same-row in-flight guard still prevents one source row from issuing the same
command twice.

### Strict Vault drain and native close

The desktop gap from Task 5 was completed through the real Settings and native
window paths:

1. The app changed from the original benchmark root to
   `$BENCHMARK_ROOT/switch-vault`. A distinct Notes DB was created and the new
   Vault received its `.yonalist` lock and initial Markdown files.
2. In that Vault, node `489dc0d5-7ccc-4d23-80fe-289963eb0143` was changed to
   `TASK9_SWITCH_PENDING_MARKER`, then Settings navigation and a switch back to
   the original root began immediately. After the switch, the old DB retained
   that exact title with `updated_at=2026-07-25T10:24:52.788Z`; the original
   root then became active with all 5,001 nodes.
3. Automated switch tests now hold the current Vault lease until both the
   workspace queue and sync exporter finish. A rejected sync-export flush
   releases the lease, keeps the old Vault active, and shows the retry status;
   a deferred flush prevents the new Vault from initializing until it
   resolves.
4. The first native-close walkthrough exposed a real final-step failure:
   drafts drained and `TASK9_CLOSE_PENDING_MARKER` was durable, but Tauri
   rejected `window.destroy` because the main capability lacked
   `core:window:allow-destroy`. A focused capability test reproduced the
   missing permission, then the minimal permission was added to the source and
   generated capability manifests.
5. A fresh rebuilt app changed node
   `10000000-0000-4000-8000-000000000000` to
   `TASK9_CLOSE_PERMISSION_MARKER_20260725` and requested Cmd-W 50 ms later.
   The freshly rebuilt window was destroyed. SQLite retained the exact marker
   with
   `updated_at=2026-07-25T10:35:51.230Z`.

The failure/retry branches were not forced in the desktop Vault because doing
so would require destructive fault injection. The composed registry,
coordinator, switch, sync-failure, destroy-failure, and retry automated tests
remain the evidence for that boundary.

### Remaining risks

- Clean Enter still misses the fixed visible p95 gate by 1 ms in the primary
  pane and 3 ms in the secondary pane. The remaining time is the commit and
  layout cost of mounting the full provisional editor row; the write queue and
  draft barrier occur later. Further work would need a deliberately lighter
  provisional row rather than another speculative memo or drag-and-drop
  refactor.
- Even after the visible transition, Enter produces 7–10 inactive-pane commits
  at p95 and Arrow produces one. Those commits did not create a two-second
  backlog, but they remain the clearest measured reconciliation cost.
- The held-Backspace commit counts are high because the provisional gesture is
  intentionally visible throughout a 1.5-second hold. The important terminal
  properties—one batch, keyup stop, zero backlog, and one Undo—passed.
- Desktop failure/retry behavior is covered by automated integration rather
  than destructive live fault injection.

## Focused verification

The final Task 9 frontend command covered the repeat resolver, focus,
Backspace gesture, draft engine, coordinator, pane/workspace integration,
strict close and Vault drain, row memo status, desktop capability, and browser
and Tauri stores:

```text
Test Files  13 passed (13)
Tests       854 passed (854)
Duration    37.48s
```

The run retained three existing jsdom
`Not implemented: navigation to another Document` warnings.

The held-Enter regression command was RED before the guard change: the
provisional resolver and chained workspace case failed while same-source
de-duplication passed. Removing only the provisional `repeat` rejection made
all three pass. The complete `outlineKeyboard.test.ts` and
`NotesWorkspace.test.tsx` files then passed 423/423.

After the final desktop run, the focused repeat-policy, F6 capture,
provisional held-Enter chain, and same-source de-duplication selection passed
16/16. `git diff --check` also passed, and the isolated database finished at
`5001|5001|0 deleted|51 active roots|5 empty roots`.

After independent review, targeted regression runs also passed the two Vault
sync-export barrier cases, all 140 keyboard resolver cases, the repeated
history event path in page fields, and the repeated history event path on a
focused bullet.

The capability regression test was RED before the permission change (one
failure, one pass) and GREEN afterward (two passes). A combined focused run
also exposed an order-dependent test race in the held-Backspace Undo
assertion: the isolated test passed 20/20, while the full
`NotesWorkspace.test.tsx` file failed 3/3 because it checked both panes after
the Undo call but before the authoritative workspace publication rendered.
The assertion now waits for all five rows in both panes without weakening the
subsequent exact focus, selection, and title checks. The full file then passed
3/3, and the 854-test command above passed without an order-dependent rerun.

Targeted native verification passed:

```text
cargo test --manifest-path src-tauri/Cargo.toml backspace_gesture
9 passed; 0 failed

cargo test --manifest-path src-tauri/Cargo.toml mutation_delta
7 passed; 0 failed
```

The final diff contains no benchmark probe source, temporary Vault file, or
rejected A/B candidate. The generated capability schema contains the same
`core:window:allow-destroy` permission as the source capability. The final
integration pass consists of the complete frontend test, lint, and production
build commands; the complete Tauri test and formatting checks; and a final
whitespace-error check before commit.
