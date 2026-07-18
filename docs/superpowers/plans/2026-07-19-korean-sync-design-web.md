# Korean Distributed Sync Design Web Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Publish a repository-local Korean system design page whose canonical source is Markdown and whose rendered static HTML explains the implemented standalone synchronization core, the approved issue-tracker domain design, and the still-unimplemented product layers with ten useful technical diagrams.

**Architecture:** `docs/yonalist-sync-design/design.md` is the single content source. A dependency-free project script around the already-installed `markdown-it` package transforms that Markdown into `docs/yonalist-sync-design/index.html`, preserves Mermaid fences as renderable diagram blocks, and injects a local stylesheet plus a small Mermaid bootstrap module. The page is local-only and is not deployed; its source remains readable even when the Mermaid CDN is unavailable.

**Tech Stack:** Markdown, Mermaid syntax, `markdown-it` 14, Node.js ESM, semantic HTML, responsive CSS, Node built-in test runner, Vite static serving.

## Global Constraints

- Keep branch `codex/standalone-sync-core` isolated; do not merge, push, or publish.
- Write the design narrative, captions, legends, navigation, and accessibility text in Korean.
- Distinguish three states everywhere: `현재 구현`, `상위 설계 확정`, and `후속 구현`.
- Never claim that issue projection, attachment byte replication, real networking, bundle exchange, relay/web projection, conflict UI, offline lease, or project-level encryption are implemented.
- Represent the current core accurately: opaque signed atoms, bare SHA-256 Git, control-first pull, session reauthorization, accepted-only quarantine promotion, durable publication, cooperative revocation, bounded Git processes, and app-only writing.
- Use ten Mermaid diagrams only where relationships or sequences are clearer visually; every diagram requires a Korean caption and text alternative.
- Add no production runtime dependency and no `.openai/hosting.json`; the artifact stays local to the repository.
- Generated HTML must be deterministic and must not contain machine-specific absolute paths or timestamps.

---

### Task 1: Deterministic Markdown renderer and contract tests

**Files:**
- Create: `scripts/render-sync-design.mjs`
- Create: `scripts/render-sync-design.test.mjs`

**Interfaces:**
- Consumes: a Markdown source path, an HTML output path, and relative stylesheet/script paths.
- Produces: `renderDesignPage({ sourcePath, outputPath }) -> Promise<void>` and a command-line renderer using the repository's fixed design paths.

- [ ] **Step 1: Write renderer contract tests**

Use `node:test`, `node:assert/strict`, `node:fs/promises`, and a temporary directory. Assert that a Korean fixture renders:

```js
assert.match(html, /<html lang="ko">/);
assert.match(html, /<main id="design-content"/);
assert.match(html, /<pre class="mermaid"/);
assert.match(html, /aria-label="다이어그램:/);
assert.doesNotMatch(html, /\/Users\//);
```

Add a determinism assertion by rendering the same fixture twice and comparing exact bytes. Add a failure assertion for a Mermaid fence without the required immediately preceding `<!-- diagram: ... -->` accessible label.

- [ ] **Step 2: Run the test and verify RED**

Run:

```bash
node --test scripts/render-sync-design.test.mjs
```

Expected: FAIL because `render-sync-design.mjs` does not exist.

- [ ] **Step 3: Implement the minimal renderer**

Implement an ESM module that:

1. Uses `MarkdownIt({ html: false, linkify: true, typographer: false })`.
2. Overrides the `fence` rule only for `mermaid` and emits `<pre class="mermaid" role="img" aria-label="…">` with escaped Mermaid source.
3. Requires a diagram label comment immediately before each Mermaid fence and removes that comment from visible output.
4. Wraps rendered content in a fixed Korean semantic page shell with skip link, masthead, scope legend, generated table-of-contents container, main content, source link, local CSS, and local module script.
5. Writes through a sibling temporary file and renames it over the output so an interrupted generation does not leave partial HTML.
6. Exports `renderDesignPage` and runs the fixed repository paths only when invoked directly.

- [ ] **Step 4: Run the renderer tests and verify GREEN**

Run:

```bash
node --test scripts/render-sync-design.test.mjs
```

Expected: all renderer contract tests pass.

- [ ] **Step 5: Commit Task 1**

```bash
git add scripts/render-sync-design.mjs scripts/render-sync-design.test.mjs
git commit -m "docs(sync): add deterministic design renderer"
```

### Task 2: Korean canonical design narrative and ten diagrams

**Files:**
- Create: `docs/yonalist-sync-design/design.md`

**Interfaces:**
- Consumes: the approved distributed issue-tracker spec, hardening plan, public crate contract, README limits, and final test evidence.
- Produces: one Korean canonical design source containing stable heading IDs, implementation-status callouts, references, and ten labeled Mermaid fences.

- [ ] **Step 1: Write the document skeleton and status vocabulary**

Start with:

```markdown
# Yonalist 분산 이슈 트래커 시스템 설계

> 이 문서는 목표 제품 아키텍처와 현재 `yonalist-sync` 코어의 구현 범위를 함께 설명한다.

- **현재 구현:** 코드와 자동화 테스트로 검증됨
- **상위 설계 확정:** 제품 설계는 승인됐지만 아직 코어 위에 구현되지 않음
- **후속 구현:** transport, projection, attachment, relay/web, UI 작업이 필요함
```

Use sections for executive summary, goals/non-goals, architecture, storage, atom model, local write, sync, quarantine, membership/revocation, issue domain, conflict resolution, attachments, project list, optional relay/read-only web, security boundaries, resource limits, test evidence, and roadmap.

- [ ] **Step 2: Add ten technical diagrams**

Add these labeled Mermaid diagrams, each with a Korean caption and nearby prose that does not merely repeat the diagram:

1. Complete topology: peer apps, optional relay, read-only projector, and no central authority.
2. Layer boundaries: UI/domain atoms/sync core/Git and attachment sidecar/projections.
3. Repository anatomy: control/data refs, immutable trees, private locks, quarantine.
4. Offline local write sequence: command, policy, signature, deterministic commit, ref CAS, projection.
5. Allowed control-first pull sequence with session-bound reauthorization.
6. Pack containment pipeline from untrusted bytes to durable refs.
7. Removal-only revocation and fail-closed private access lock.
8. Causal DAG/frontier convergence across two devices.
9. Body/state conflict classification and explicit merge atom UX.
10. Implemented-versus-roadmap dependency map.

- [ ] **Step 3: Add exact implemented limits and evidence**

Document the default ceilings exactly: 16 MiB compressed pack, 128 refs, 1,024 commits, 8,192 objects, 1,024 tree entries, 1,024 atoms per head, 4 MiB blob, 64 MiB expanded content, and 4 MiB metadata. State that the final deterministic scale gate passed 100 peers/500 events once in 233.01 seconds, but is not a real internet benchmark.

- [ ] **Step 4: Run content consistency scans**

Run:

```bash
rg -n "TBD|TODO|구현 완료된 이슈|실제 P2P 구현|E2E 암호화 제공" docs/yonalist-sync-design/design.md
rg -c '^```mermaid$' docs/yonalist-sync-design/design.md
```

Expected: no placeholder/overclaim matches; Mermaid count is exactly `10`.

- [ ] **Step 5: Commit Task 2**

```bash
git add docs/yonalist-sync-design/design.md
git commit -m "docs(sync): write Korean distributed design"
```

### Task 3: Responsive web presentation and Mermaid bootstrap

**Files:**
- Create: `docs/yonalist-sync-design/styles.css`
- Create: `docs/yonalist-sync-design/page.js`
- Generate: `docs/yonalist-sync-design/index.html`

**Interfaces:**
- Consumes: renderer shell IDs/classes and the headings/diagram blocks generated from `design.md`.
- Produces: a responsive, keyboard-accessible static document page with a generated table of contents, active-section indication, graceful Mermaid failure fallback, and print styles.

- [ ] **Step 1: Add page behavior tests to the renderer suite**

Extend `scripts/render-sync-design.test.mjs` to assert the shell references only relative assets, contains the skip link and `aria-live` diagram status, and includes neither inline executable JavaScript nor absolute local paths.

- [ ] **Step 2: Run tests and verify RED**

Run:

```bash
node --test scripts/render-sync-design.test.mjs
```

Expected: FAIL until the stylesheet/script references and complete shell contract exist.

- [ ] **Step 3: Implement the page presentation**

Create CSS with:

- system Korean typography, 72-character reading measure, and responsive two-column desktop layout;
- sticky table of contents on wide screens and normal flow below 900 px;
- visually distinct but accessible implemented/approved/future status tokens;
- unframed diagrams with subtle section dividers, dark-mode tokens via `prefers-color-scheme`, and print styles;
- visible focus states and no horizontal clipping at 320 px.

Create `page.js` that:

- builds nested navigation from `main h2, main h3` and supplies deterministic IDs when absent;
- highlights the current section with `IntersectionObserver` without blocking navigation;
- imports pinned Mermaid ESM from jsDelivr, uses a neutral theme matching the page, and renders all diagram blocks;
- on import/render failure, leaves the Mermaid source visible and reports a concise Korean fallback message.

- [ ] **Step 4: Generate and structurally verify HTML**

Run:

```bash
node scripts/render-sync-design.mjs
node --test scripts/render-sync-design.test.mjs
rg -c '<pre class="mermaid"' docs/yonalist-sync-design/index.html
```

Expected: generator and tests pass; generated HTML contains exactly ten Mermaid blocks.

- [ ] **Step 5: Commit Task 3**

```bash
git add docs/yonalist-sync-design/styles.css docs/yonalist-sync-design/page.js docs/yonalist-sync-design/index.html scripts/render-sync-design.test.mjs scripts/render-sync-design.mjs
git commit -m "docs(sync): render visual design webpage"
```

### Task 4: Repository integration and final documentation gate

**Files:**
- Modify: `package.json`
- Modify: `README.md`
- Regenerate: `docs/yonalist-sync-design/index.html`

**Interfaces:**
- Consumes: renderer and static design directory from Tasks 1–3.
- Produces: discoverable npm commands and a README link without changing application runtime behavior.

- [ ] **Step 1: Add exact package scripts**

Add:

```json
"docs:sync-design": "node scripts/render-sync-design.mjs",
"docs:sync-design:test": "node --test scripts/render-sync-design.test.mjs",
"docs:sync-design:serve": "vite docs/yonalist-sync-design --host 127.0.0.1"
```

- [ ] **Step 2: Link the design page from README**

Under `Standalone distributed sync lab`, add a short Korean-design link to `docs/yonalist-sync-design/index.html` and identify `design.md` as its canonical source.

- [ ] **Step 3: Run the full documentation gate**

Run:

```bash
npm run docs:sync-design
npm run docs:sync-design:test
git diff --check
git status --short
```

Expected: renderer/tests/diff checks pass; only intended documentation, script, README, and package changes are present before commit.

- [ ] **Step 4: Check links and scope language**

Run a Node test that parses local `href`/`src` values from `index.html` and confirms every local target exists. Confirm each of the phrases `실제 네트워크 미구현`, `첨부파일 복제 미구현`, `이슈 projection 미구현`, and `협력적 철회` is present in the canonical Markdown.

- [ ] **Step 5: Commit Task 4**

```bash
git add README.md package.json scripts/render-sync-design.mjs scripts/render-sync-design.test.mjs docs/yonalist-sync-design
git commit -m "docs(sync): publish Korean visual design page"
```

### Task 5: Independent accuracy and presentation review

**Files:**
- Review: `docs/yonalist-sync-design/design.md`
- Review: `docs/yonalist-sync-design/index.html`
- Review: `docs/yonalist-sync-design/styles.css`
- Review: `docs/yonalist-sync-design/page.js`
- Review: `scripts/render-sync-design.mjs`
- Review: `README.md`

**Interfaces:**
- Consumes: completed document page and all implementation evidence.
- Produces: an approved accuracy report with no Critical or Important findings, or a focused correction commit followed by re-review.

- [ ] **Step 1: Run a fresh technical-accuracy review**

Compare every implemented claim with public API, tests, README limits, and hardening behavior. Reject any statement that presents target domain design as implemented.

- [ ] **Step 2: Run a fresh visual/document review**

Check heading hierarchy, Korean terminology consistency, diagram readability, diagram/prose correspondence, dark/print behavior by source inspection, keyboard navigation, accessible labels, narrow-screen CSS, and graceful Mermaid failure.

- [ ] **Step 3: Correct and regenerate if needed**

Apply only findings, rerun renderer/tests, regenerate `index.html`, and commit focused corrections. Repeat review until there are no Critical or Important findings.

- [ ] **Step 4: Run final verification**

```bash
npm run docs:sync-design
npm run docs:sync-design:test
npm run build
git diff --check
git status --short
```

Expected: all commands pass and the isolated worktree is clean after the final documentation commit.
