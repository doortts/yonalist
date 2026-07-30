# Monaco whole-outline spike report

This report records the branch-only experiment on
`codex/monaco-outline-spike`. The control is `c693979` on
`codex/yonalist-v2-core`.

## Question

Would replacing the entire bullet page with one Monaco editor preserve the
current Yonalist design and behavior while making outline editing feel more
like a native editor?

The experiment deliberately uses one Monaco model and editor per pane. It
does not create one editor per bullet. Rust, SQLite, IPC, optimistic
mutations, and the product Undo/Redo history remain unchanged.

Open the two variants with:

- React control: `/`
- Monaco experiment: `/?outline=monaco`

## Implemented evidence

- One line-to-node projection preserves stable node identity, draft text,
  depth, and image-line read-only state.
- Projection reconciliation applies one minimal character range instead of
  replacing the whole model.
- Same-line drafts and IME composition continue through `NotesStore`.
- Enter splits at the literal selection. A held-key gesture keeps splitting
  the newest tail rather than racing an old cursor.
- Backspace at column one merges into the preceding eligible bullet; empty
  bullets are removed through the existing grouped mutation path.
- Arrow movement remains native Monaco movement.
- Tab and Shift+Tab route to the existing indent/outdent commands.
- Ctrl/Cmd+Z and Shift+Ctrl/Cmd+Z route to Yonalist interaction history, not
  Monaco's private undo stack.
- Both split panes can own independent editors when the existing split state
  is already open.
- The query-free React path remains the default.

Fresh browser verification on 2026-07-30 covered eight consecutive Enter
events, eight consecutive Backspace events, a middle-of-line split and
merge, Tab/Shift+Tab, and structural Undo. The final fixture returned to its
single original bullet. This is a smoke test, not the specification's required
20-event, Korean IME, split-focus, or frame/memory acceptance run.

## Fast sample

The deterministic 5,000-node test was run five times on the active Windows
development machine. It measures TypeScript projection and minimal-diff
planning, not Monaco paint, IPC, SQLite, or process startup.

| Operation | Five-sample median | Approximate per operation |
|---|---:|---:|
| Build 5,000-line projection | 1.79ms | n/a |
| 200 single-line updates | 137.45ms | 0.69ms |
| 100 middle insertions | 58.06ms | 0.58ms |

Every sampled update produced one bounded edit. No update replaced the full
5,000-line model. This supports only the projection/diff implementation; it
does not measure or validate Monaco model application, paint, scroll, memory,
or cold-editable performance.

## Bundle comparison

Production Vite builds:

| Asset | React control | Monaco experiment |
|---|---:|---:|
| Query-free initial JS | 295.93KB raw / 89.99KB gzip | 296.44KB raw / 90.15KB gzip |
| Monaco lazy JS | none | 2,517.30KB raw / 646.17KB gzip |
| Monaco CSS | none | 74.22KB raw / 11.68KB gzip |
| Editor worker | none | 281.29KB raw |

The complete statically reachable editable graph is 92,197 bytes gzip, 37
bytes over its 90KiB budget, even before Monaco is selected. Selecting Monaco
then adds a much larger parse and memory cost. `monaco-editor@0.53.0` was
chosen because the newer evaluated package introduced a vulnerable nested
dependency; the final dependency graph reports zero audit findings.

## Differences from the current app

| Area | Current React outline | Monaco spike |
|---|---|---|
| Rendering | One subscribed row component per visible node | One virtualized editor/model per pane |
| Text input | Native textarea per bullet | One hidden Monaco textarea and line model |
| Visual DOM | Product-owned and golden-image friendly | Monaco-owned line DOM with injected bullet decorations |
| Images | Full image display, edit, clipboard, and drop | Read-only filename line |
| Multi-selection | Range selection and batch actions | Not implemented |
| Drag/drop | Row and cross-pane block moves | Not implemented |
| Split opening/zoom hit target | Product bullet interaction | Existing open split renders, but Monaco line hit targets are not yet ported |
| Clipboard/slash/note fields | Product behavior | Not implemented |
| Accessibility | Product labels and row semantics | Monaco code-editor semantics; parity not established |
| Bundle/startup | Small custom editor path | Large lazy editor runtime and worker |

The shell, spacing, type scale, and colors can be made visually close.
Pixel-identical behavior is not guaranteed because selection, caret,
composition, wrapping, accessibility DOM, and injected decorations are
controlled by Monaco. Images and product row controls would still require
overlay widgets, which would reintroduce a parallel layout system.

## Decision

Do not replace the production outline with Monaco yet.

The spike validates only the narrow projection hypothesis: a 5,000-line
projection can be built quickly and reconciled with bounded text edits. It
does not yet validate Monaco renderer performance or the product hypothesis.
Full Yonalist parity requires rebuilding images, selection, drag/drop, zoom,
clipboard, notes, and accessibility around Monaco, while paying roughly 646KB
gzip plus a worker when the editor is opened.

The useful parts to carry back are:

1. keep one ordered line projection with stable node identity;
2. reconcile structure with one bounded edit;
3. keep structural gestures outside React row rendering;
4. virtualize the current product-owned row surface before adopting a general
   code editor runtime.

This branch should remain an experimental reference until a large real
fixture demonstrates that current row virtualization cannot meet the input
latency target.
