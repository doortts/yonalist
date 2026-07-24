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
- Node: 26.4.0
- Rust: 1.97.0
- App: fresh Tauri development process with the isolated benchmark bundle ID
- Seed signature: `5000|50|5` (5,000 Notes nodes, 50 roots, five consecutive
  empty roots)
- Runtime: the app adds one reserved GitHub Notifications root, so the
  pre-change desktop run contains 5,001 active nodes. The post-change run must
  verify the same signature before comparison.
- Verified post-start signature: `5001|51|5`, with 52 sync topics, zero dirty
  nodes, and distinct Markdown names for all 50 seeded roots
- View: split open with 50 visible title rows in each pane

Each Arrow or Enter row uses 10 warmups followed by 50 measured operations.
Invalid overlapping samples were discarded and the run was repeated with a
longer interval. Every reported Arrow or Enter row contains 50 valid samples
and zero invalid samples. Each held-Backspace row contains one physical
gesture. Latencies are measured from the physical keydown.

Percentiles use the nearest-rank rule: sort the valid values ascending and
select index `ceil(sampleCount * percentile) - 1`, without interpolation.

### Commands

The fixture was seeded and the app launched with:

```bash
YONALIST_SPLIT_INPUT_BENCH_VAULT=/tmp/yonalist-split-input-bench.sNiKPD/vault \
YONALIST_SPLIT_INPUT_BENCH_NOTES_ROOT="/Users/doortts/Library/Application Support/com.doortts.yonalist.split-input-benchmark/notes" \
cargo test --manifest-path src-tauri/Cargo.toml \
  notes::performance::seed_split_input_benchmark_vault \
  -- --ignored --exact --nocapture

npm run tauri:dev -- \
  --config src-tauri/tauri.split-input-benchmark.conf.json
```

The measured process ID was `23012`. The controller used the following exact
workload commands; the first numeric argument after the PID is the macOS key
code for the pane-focus shortcut:

```bash
# Arrow: 5 alternating pairs warm up 10 inputs; 25 pairs measure 50.
osascript /tmp/yonalist-split-input-bench.sNiKPD/measure_arrow.scpt \
  23012 18 5 25 0.12
osascript /tmp/yonalist-split-input-bench.sNiKPD/measure_arrow.scpt \
  23012 19 5 25 0.35

# Clean Enter: mode, warmups, measurements, settlement wait, Undo wait.
osascript /tmp/yonalist-split-input-bench.sNiKPD/measure_enter.scpt \
  23012 35 clean 10 50 0.5 0.4
osascript /tmp/yonalist-split-input-bench.sNiKPD/measure_enter.scpt \
  23012 31 clean 10 50 0.9 0.6

# Enter immediately after a one-character title edit.
osascript /tmp/yonalist-split-input-bench.sNiKPD/measure_enter.scpt \
  23012 35 dirty 10 50 0.9 0.6
osascript /tmp/yonalist-split-input-bench.sNiKPD/measure_enter.scpt \
  23012 31 dirty 10 50 0.9 0.6

# One held Backspace: 1,500 ms hold, 350 ms initial delay, 50 ms repeats.
/tmp/yonalist-split-input-bench.sNiKPD/hold_backspace 23012 1500 50
```

The controller parsed the selected collector JSON with
`summarize_samples.mjs`. Raw arrays were not retained in the repository; the
table below records the valid count and every aggregate emitted by that
script. The post-change run will use the same collector, nearest-rank method,
and workload parameters.

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

These runs were not included in the table.

## After

Pending implementation.

## Improvement

Pending implementation.

## Functional verification

Pending implementation.
