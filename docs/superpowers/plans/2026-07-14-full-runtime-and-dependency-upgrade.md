<!-- reconciliation: auditedHead=ec8a9ff3d016449255992adf70e128ea5e222e9a status=complete -->
> **증거 대조 상태 (2026-07-19): 완료.** commit·artifact 근거는 [감사 ledger](../reports/2026-07-19-historical-plan-ledger.json)에 기록했다.

# Full Runtime And Dependency Upgrade Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Upgrade Yonalist to Rust 1.97 and current stable Cargo and npm dependencies, then merge the verified result into `main`.

**Architecture:** Upgrade version-coupled packages together: Rust/CI first, Tauri's Rust and npm packages as one unit, remaining Cargo packages, then the React/Vite/TypeScript toolchain. Compile and test after each unit so source migrations remain attributable to one dependency family.

**Tech Stack:** Rust 1.97, Cargo, Tauri 2, React, TypeScript, Vite, Vitest, ESLint, npm.

## Global Constraints

- Use a linked worktree and a dedicated upgrade branch; do not include active-checkout changes.
- Keep all Tauri packages in a compatible 2.x family across Cargo and npm manifests.
- Keep React and React DOM on the same release family.
- Preserve existing Cargo feature selections unless an upstream API removes them.
- Do not change Notes schema, stored user data, or product behavior.
- Run `git diff --check` before every commit and merge only a verified branch into `main`.

---

### Task 1: Create an Isolated Upgrade Baseline

**Files:**
- Create: `.worktrees/full-runtime-dependency-upgrade` (linked worktree)
- Modify: none in the active checkout

**Interfaces:**
- Consumes: committed `main` at `249114b` or later
- Produces: branch `codex/full-runtime-dependency-upgrade` with a clean baseline

- [x] **Step 1: Create the upgrade worktree from `main`**

Run:

```bash
git worktree add .worktrees/full-runtime-dependency-upgrade -b codex/full-runtime-dependency-upgrade main
```

Expected: a new linked checkout exists and `git status --short` is empty there.

- [x] **Step 2: Install the locked JavaScript dependencies**

Run:

```bash
npm ci
```

Expected: `node_modules` matches `package-lock.json` without package changes.

- [x] **Step 3: Establish the baseline build state**

Run:

```bash
npm run build
cargo check --manifest-path src-tauri/Cargo.toml --no-default-features
```

Expected: both commands pass before changing versions.

### Task 2: Upgrade Rust and Tauri as One Compatibility Unit

**Files:**
- Modify: `rust-toolchain.toml`
- Modify: `src-tauri/Cargo.toml`
- Modify: `src-tauri/Cargo.lock`
- Modify: `package.json`
- Modify: `package-lock.json`
- Modify: `.github/workflows/ci.yml`
- Test: `scripts/tauri.test.ts`

**Interfaces:**
- Consumes: Tauri's Rust crates and `@tauri-apps/*` npm packages
- Produces: one current compatible Tauri 2.x family and Rust 1.97 project toolchain

- [x] **Step 1: Make the toolchain contract fail for the old Rust pin**

Change the expectation in `scripts/tauri.test.ts` before the manifest:

```ts
expect(toolchain).toContain('channel = "1.97.0"');
```

Run:

```bash
npm test -- scripts/tauri.test.ts
```

Expected: FAIL because `rust-toolchain.toml` still specifies `1.88.0`.

- [x] **Step 2: Pin Rust and CI to 1.97**

Set these values:

```toml
[toolchain]
channel = "1.97.0"
profile = "minimal"
```

```toml
rust-version = "1.97"
```

```yaml
- uses: dtolnay/rust-toolchain@1.97.0
```

- [x] **Step 3: Update the Tauri family atomically**

Update the direct Tauri crate entries in `src-tauri/Cargo.toml` and the direct
`@tauri-apps/api`, `@tauri-apps/cli`, dialog, and notification entries in
`package.json` to their current compatible releases. Regenerate both lockfiles
with `cargo update` and `npm install`.

Run:

```bash
npm test -- scripts/tauri.test.ts
cargo check --manifest-path src-tauri/Cargo.toml --no-default-features
npm run tauri -- --version
```

Expected: all commands pass on Rust 1.97 and report the upgraded Tauri CLI.

- [x] **Step 4: Commit the toolchain and Tauri unit**

```bash
git add rust-toolchain.toml src-tauri/Cargo.toml src-tauri/Cargo.lock package.json package-lock.json .github/workflows/ci.yml scripts/tauri.test.ts
git commit -m "chore: upgrade Rust and Tauri runtime"
```

### Task 3: Upgrade Cargo Dependencies and Repair Native Call Sites

**Files:**
- Modify: `src-tauri/Cargo.toml`
- Modify: `src-tauri/Cargo.lock`
- Modify when compiler diagnostics require it: `src-tauri/src/lib.rs`, `src-tauri/src/notes/export.rs`, `src-tauri/src/notes/commands.rs`
- Test: affected native module tests in `src-tauri/src/lib.rs` and `src-tauri/src/notes/export.rs`

**Interfaces:**
- Consumes: current stable direct Cargo releases and existing `features = [...]` selections
- Produces: a compiling native application with updated Cargo lockfile

- [x] **Step 1: Record latest direct Cargo releases without editing source**

Run:

```bash
cargo search tauri --limit 1
cargo search printpdf --limit 1
cargo search rusqlite --limit 1
cargo search image --limit 1
```

Expected: current crate releases are visible before editing the matching manifest entries.

- [x] **Step 2: Update direct Cargo versions and regenerate the lockfile**

Preserve each existing feature list while replacing version requirements in
`src-tauri/Cargo.toml`, then run:

```bash
cargo update --manifest-path src-tauri/Cargo.toml
cargo check --manifest-path src-tauri/Cargo.toml --no-default-features
```

Expected: compiler diagnostics identify only upstream API migration call sites.

- [x] **Step 3: Add a failing focused native test for each behavioral migration**

For every compiler-driven API migration that changes output behavior, add or
adjust the closest existing `#[test]` in the owning module, run it first, and
observe the expected failure before changing production code.

Run:

```bash
cargo test --manifest-path src-tauri/Cargo.toml notes::export::tests
```

Expected: updated export contracts pass without changing PDF, attachment, or
Notes persistence semantics.

- [x] **Step 4: Commit the native dependency unit**

```bash
git add src-tauri/Cargo.toml src-tauri/Cargo.lock src-tauri/src/lib.rs src-tauri/src/notes/export.rs src-tauri/src/notes/commands.rs
git commit -m "chore: upgrade Cargo dependencies"
```

### Task 4: Upgrade npm Dependencies and Repair Web Tooling Call Sites

**Files:**
- Modify: `package.json`
- Modify: `package-lock.json`
- Modify when diagnostics require it: `vite.config.ts`, `eslint.config.*`, `src/main.tsx`, and affected `*.test.tsx` files
- Test: existing affected frontend test files plus `scripts/tauri.test.ts`

**Interfaces:**
- Consumes: current stable React/React DOM, Vite, TypeScript, Vitest, ESLint,
  jsdom, Lucide, and Tauri npm packages
- Produces: a typechecked, linted, and tested frontend with current lockfile

- [x] **Step 1: Update manifest ranges and lockfile**

Run:

```bash
npx npm-check-updates --upgrade
npm install
npm outdated --json
```

Expected: `package.json` and `package-lock.json` carry current direct releases;
the final command has no direct dependency entries.

- [x] **Step 2: Run typecheck and write a failing focused regression test when behavior changes**

Run:

```bash
npx tsc --noEmit
npm test -- scripts/tauri.test.ts
```

Expected: any React, TypeScript, Vite, or test-library API errors are explicit.
For an observable migration, update the closest owning test first and see it
fail before changing source.

- [x] **Step 3: Make the smallest compatibility repairs**

Keep React rendering behavior and Tauri invoke contracts unchanged. Modify only
the source or configuration lines identified by current compiler, linter, or
test diagnostics.

- [x] **Step 4: Verify the frontend unit**

Run:

```bash
npm run lint
npm run build
npm test -- scripts/tauri.test.ts
```

Expected: lint, production build, and Tauri command-runner contract pass.

- [x] **Step 5: Commit the npm dependency unit**

```bash
git add package.json package-lock.json vite.config.ts eslint.config.* src/main.tsx src
git commit -m "chore: upgrade npm dependencies"
```

### Task 5: Verify the Complete Upgrade and Merge to Main

**Files:**
- Modify: no new product files unless verification exposes a compatibility defect
- Verify: all manifests, lockfiles, CI workflow, native code, and frontend tests

**Interfaces:**
- Consumes: commits from Tasks 2-4
- Produces: a verified `main` containing the full dependency upgrade

- [x] **Step 1: Run the complete verification matrix**

```bash
npm ci
npm run lint
npm test
npm run build
cargo test --manifest-path src-tauri/Cargo.toml
```

Expected: all commands exit successfully. If the environment imposes a test
time limit, record the limit and separately rerun every interrupted test file.

- [x] **Step 2: Start the desktop development application**

```bash
npm run tauri:dev
```

Expected: Vite becomes ready and the native binary reaches `Running` without a
Rust, TypeScript, or frontend build error.

- [x] **Step 3: Review and commit any final compatibility fix**

```bash
git diff --check
git status --short
git commit -am "fix: complete dependency upgrade"
```

Expected: only upgrade-related files are committed.

- [x] **Step 4: Merge the verified branch into main**

```bash
git switch main
git merge --ff-only codex/full-runtime-dependency-upgrade
```

Expected: `main` contains every verified upgrade commit and no active-checkout
changes were staged or overwritten.
