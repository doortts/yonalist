# Task 4 report — repository integration and documentation gate

## Result

- Commit: `docs(sync): publish Korean visual design page` (current branch head)
- Added the `docs:sync-design`, `docs:sync-design:test`, and
  `docs:sync-design:serve` npm commands without adding dependencies or changing
  the lockfile.
- Added a concise README link to the Korean design page and its canonical
  Markdown source.
- Regenerated `docs/yonalist-sync-design/index.html` from `design.md`.
- Added `scripts/sync-design-contract.test.mjs`, which parses the published
  HTML, checks every local `href`/`src` target and fragment, and asserts the
  canonical scope-boundary phrases.

## Verification

```text
npm run docs:sync-design                 passed
npm run docs:sync-design:test            passed (28 tests)
git diff --check                         passed
node package.json parse                  passed
generated HTML sanity check              passed
git status --short                       clean after commit
```

## Files

- `README.md`
- `package.json`
- `docs/yonalist-sync-design/design.md`
- `docs/yonalist-sync-design/index.html`
- `scripts/sync-design-contract.test.mjs`

## Concerns

None. The preview command is intentionally local-only and does not introduce
hosting or deployment configuration.
