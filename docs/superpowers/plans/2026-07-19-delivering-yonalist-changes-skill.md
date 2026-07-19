# Delivering Yonalist Changes Skill Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (- [ ]) syntax for tracking.

**Goal:** Add a repository-scoped Codex skill that makes Yonalist change work faster and more reliable by enforcing scoped contracts, thin vertical slices, fresh desktop evidence, and proportionate verification.

**Architecture:** Store the discoverable skill under the official repository location .agents/skills, and add a minimal root AGENTS.md rule that requires the workflow for change tasks. Keep the first version instruction-only; validate its structure with the official skill validator and its behavior with the same pressured scenarios used for the baseline.

**Tech Stack:** Markdown, YAML, Codex AGENTS.md, Codex repository skills, Python skill validation utility

## Global Constraints

- Store all new files in /Users/cpm4/repos/yonalist; do not install or link anything under the user's home directory.
- Use .agents/skills/delivering-yonalist-changes as the repository skill directory.
- Keep AGENTS.md short and route detailed workflow instructions to the skill.
- Add no dependencies, hooks, helper scripts, or command wrappers.
- Preserve unrelated user changes and work on the current main checkout.

---

### Task 1: Create the repository skill and routing rule

**Files:**

- Create: .agents/skills/delivering-yonalist-changes/SKILL.md
- Create: .agents/skills/delivering-yonalist-changes/agents/openai.yaml
- Create: AGENTS.md

**Interfaces:**

- Consumes: Codex repository skill discovery from $REPO_ROOT/.agents/skills
- Produces: the delivering-yonalist-changes skill and a mandatory repository routing rule

- [ ] **Step 1: Scaffold the skill with the official creator**

Run:

~~~bash
python3 /Users/cpm4/.codex/skills/.system/skill-creator/scripts/init_skill.py \
  delivering-yonalist-changes \
  --path .agents/skills \
  --interface 'display_name=Deliver Yonalist Changes' \
  --interface 'short_description=Ship Yonalist changes with focused tests and fresh desktop proof' \
  --interface 'default_prompt=Use $delivering-yonalist-changes to plan and execute this Yonalist change with a scoped contract, thin vertical slice, and proportionate verification.'
~~~

Expected: the command creates SKILL.md and agents/openai.yaml without a scripts, references, or assets directory.

- [ ] **Step 2: Replace the generated SKILL.md with the approved workflow**

Write:

~~~~markdown
---
name: delivering-yonalist-changes
description: Use when planning or implementing a Yonalist feature, bug fix, behavior change, refactor, or user-visible verification, especially Notes, contenteditable, drag-and-drop, clipboard or image handling, Undo/Redo, React-Tauri IPC, Rust, SQLite, or macOS runtime work.
---

# Delivering Yonalist Changes

## Core rule

The fastest valid path is a thin production slice with fresh runtime evidence.
Do not substitute repeated full gates for early boundary proof.

## 1. Freeze the contract

Before editing, record:

| Field | Required content |
| --- | --- |
| Goal | One observable outcome |
| Acceptance | User-visible rows that can pass or fail |
| Non-goals | Explicit exclusions |
| Boundaries | React, IPC, Rust, SQLite, filesystem, macOS as applicable |
| Manual proof | Shortest real user path |

Infer safe defaults and ask only when a choice materially changes the result.
If scope or a storage/history decision changes, update the contract before
continuing. Split independently testable subsystems.

## 2. Inspect the baseline

- Check branch, git status, current diff, and the smallest owning tests.
- Preserve user changes and record pre-existing failures or warnings.
- For desktop work, define how to prove the bundle and process are fresh and
  how to isolate test Vault data.

## 3. Prove one vertical slice

Write a focused failing test, implement one production path through every
affected boundary, and run its owning test. At IPC or persistence boundaries,
test real payload shapes and serialization instead of relying only on mocks.

Verify the first slice early in a freshly built/restarted Tauri app. On the
first unexplained runtime failure, inspect Web Inspector or logs. After two
failed fixes for the same symptom, stop patching and gather new evidence.

## 4. Expand one acceptance row at a time

During the edit loop, run only the focused or owning-module tests. Keep worker
tasks and file ownership disjoint. GPT-5.6 Sol owns design, adversarial review,
rework decisions, final desktop proof, and the complete gate; use GPT-5.6
Terra for bounded implementation or targeted tests only when delegation is
authorized.

## 5. Verify proportionately

Use this order:

1. focused regression test;
2. owning frontend or Rust module tests;
3. fresh desktop smoke test for user-visible or runtime-boundary changes;
4. relevant final gates once: npm test, npm run lint, npm run build,
   cargo test --manifest-path src-tauri/Cargo.toml, formatting, and
   git diff --check.

Do not repeatedly run the full suite inside the edit loop. Do not rerun a
known flaky test merely to manufacture a pass. Isolate and report it. Do not
claim a clean gate when only a pre-existing warning baseline is known.

## 6. Finish with evidence

Review the final diff, restore temporary test data, and commit when requested.
Report acceptance rows exercised, exact commands and results, desktop proof,
baseline failures, remaining risks, and the commit hash.

## User request template

~~~text
목표:
완료 조건:
비대상:
영향 범위/플랫폼:
데이터·Undo/Redo 결정:
직접 확인할 사용자 시나리오:
커밋 여부:
~~~

## Stop signs

- Scope grows but the contract does not change.
- Mocks pass while a changed desktop boundary remains unproven.
- A running app is trusted without confirming a fresh bundle and process.
- Full or flaky tests are rerun to seek a favorable result.
- Multiple agents duplicate final gates or touch overlapping files.
~~~~

- [ ] **Step 3: Add the repository routing rule**

Write AGENTS.md:

~~~markdown
# Yonalist agent guidance

Before planning or implementing any feature, bug fix, behavior change,
refactor, or user-visible verification in this repository, read and apply
.agents/skills/delivering-yonalist-changes/SKILL.md.

Keep this file concise. When a repeated project-specific failure reveals a
workflow gap, update the repository skill rather than duplicating detailed
instructions here. Read-only explanations and status reports may skip the
delivery workflow unless they lead into a change.
~~~

- [ ] **Step 4: Verify the generated interface metadata**

Ensure .agents/skills/delivering-yonalist-changes/agents/openai.yaml is:

~~~yaml
interface:
  display_name: "Deliver Yonalist Changes"
  short_description: "Ship Yonalist changes with focused tests and fresh desktop proof"
  default_prompt: "Use $delivering-yonalist-changes to plan and execute this Yonalist change with a scoped contract, thin vertical slice, and proportionate verification."
~~~

- [ ] **Step 5: Run structural validation**

Run:

~~~bash
uv run --with pyyaml python \
  /Users/cpm4/.codex/skills/.system/skill-creator/scripts/quick_validate.py \
  .agents/skills/delivering-yonalist-changes
~~~

Expected: the validator reports a valid skill.

- [ ] **Step 6: Check repository hygiene and commit**

Run:

~~~bash
git diff --check
git status --short
git add AGENTS.md .agents/skills/delivering-yonalist-changes
git commit -m "chore: add Yonalist delivery skill"
~~~

Expected: only the routing rule and skill files are included in this commit.

### Task 2: Pressure-test and harden the workflow

**Files:**

- Modify if a loophole is found: .agents/skills/delivering-yonalist-changes/SKILL.md
- Modify if metadata no longer matches triggers: .agents/skills/delivering-yonalist-changes/agents/openai.yaml

**Interfaces:**

- Consumes: the three recorded no-skill baseline scenarios in the approved design
- Produces: evidence that fresh agents choose scoped, proportionate, runtime-backed execution

- [ ] **Step 1: Run fresh agents against the same three scenarios**

Dispatch separate GPT-5.6 Terra agents without mentioning the expected answer:

~~~text
Scenario A: a nearly complete cross-layer image editor change under a 25-minute
deadline, with passing mock tests and a history of stale bundles.

Scenario B: a request that grew from image-delete Undo into navigation,
multi-image clipboard, notes, and an in-memory history decision.

Scenario C: a one-line drag insertion UI fix with a passing focused test, a
slow complete suite, known flaky Copy/drag tests, pre-existing Clippy warnings,
and an uncertain running bundle.
~~~

Expected:

- A requires a fresh Tauri proof and omits unrelated regression breadth.
- B refreshes the work contract and splits independent acceptance slices before continuing implementation.
- C runs the focused test and fresh UI proof, reserves complete relevant gates for one final run, and does not retry flaky tests to create a pass.

- [ ] **Step 2: Refactor only for observed loopholes**

If an agent rationalizes a failure, quote that rationale in working notes and
add the smallest explicit counter to SKILL.md. Do not add general prose for a
hypothetical problem.

- [ ] **Step 3: Re-run failed scenarios and structural validation**

Run the exact failed scenario again with a fresh agent, then:

~~~bash
uv run --with pyyaml python \
  /Users/cpm4/.codex/skills/.system/skill-creator/scripts/quick_validate.py \
  .agents/skills/delivering-yonalist-changes
git diff --check
~~~

Expected: the fresh agent follows the contract and the validator passes.

- [ ] **Step 4: Commit hardening changes if required**

~~~bash
git add .agents/skills/delivering-yonalist-changes
git commit -m "docs: harden Yonalist delivery workflow"
~~~

Skip this commit when pressure testing requires no file changes.
