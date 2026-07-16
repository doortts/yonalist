# Notes Unicode 17 Runtime Parity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Notes tag and date-boundary classification use pinned Unicode 17 data instead of the host JavaScript engine's Unicode version.

**Architecture:** Add one small Notes category helper backed by three precompiled Unicode 17 regular expressions. Route both tag tokenization and date word-boundary checks through it, leaving normalization, case folding, and whitespace behavior unchanged.

**Tech Stack:** TypeScript 6, Vite 8, Vitest 4, `@unicode/unicode-17.0.0`, Rust shared fixtures

## Global Constraints

- Preserve the existing Unicode 17 tag contract and shared fixture schema.
- Use only Unicode 17 `Letter`, `Number`, and `Mark` build data.
- Do not change tag normalization, case folding, Rust tokenization, or whitespace rules.
- Keep the package as a development dependency because Vite bundles its build input.
- Work directly on `main`, as explicitly requested by the user.

---

### Task 1: Pin Notes Unicode categories across frontend runtimes

**Files:**
- Create: `src/features/notes/noteUnicodeCategories.ts`
- Create: `src/types/unicode-17.d.ts`
- Modify: `src/features/notes/noteTokens.ts:56-91`
- Modify: `src/features/notes/noteDates.ts:63-66,263-265`
- Modify: `src/features/notes/noteDates.test.ts` in `findNoteDateMatches`
- Modify: `package.json`
- Modify: `package-lock.json`

**Interfaces:**
- Consumes: the default `RegExp` exports from `@unicode/unicode-17.0.0/General_Category/{Letter,Number,Mark}/regex.js`
- Produces: `isUnicodeLetterOrNumber(character: string): boolean`, `isUnicodeMark(character: string): boolean`, and `isUnicodeWordCharacter(character: string): boolean`

- [ ] **Step 1: Add a public-behavior regression test for Unicode 17 date boundaries**

Add this test inside `describe("findNoteDateMatches", ...)` in `src/features/notes/noteDates.test.ts`:

```ts
it("uses Unicode 17 word boundaries independently of the host runtime", () => {
  for (const source of ["꟎today", "a᫏today"]) {
    expect(findNoteDateMatches(source, { today })).toEqual([]);
  }

  expect(
    findNoteDateMatches("!today 😀tomorrow", { today }).map(
      (match) => match.raw
    )
  ).toEqual(["today", "tomorrow"]);
});
```

- [ ] **Step 2: Run the two affected tests and confirm RED**

Run:

```bash
npx vitest run src/features/notes/noteSearchQuery.test.ts src/features/notes/noteDates.test.ts
```

Expected: FAIL. The shared tokenizer fixture omits `#꟎` and truncates `#a᫏`; the new date test incorrectly finds `today` inside both Unicode 17 words.

- [ ] **Step 3: Install pinned Unicode 17 build data**

Run:

```bash
npm install --save-dev @unicode/unicode-17.0.0@1.6.17
```

Expected: `package.json` and `package-lock.json` add exactly `@unicode/unicode-17.0.0` under development dependencies with no unrelated package upgrades.

- [ ] **Step 4: Declare the three exact generated regex modules**

Create `src/types/unicode-17.d.ts`:

```ts
declare module "@unicode/unicode-17.0.0/General_Category/Letter/regex.js" {
  const unicodeLetter: RegExp;
  export default unicodeLetter;
}

declare module "@unicode/unicode-17.0.0/General_Category/Number/regex.js" {
  const unicodeNumber: RegExp;
  export default unicodeNumber;
}

declare module "@unicode/unicode-17.0.0/General_Category/Mark/regex.js" {
  const unicodeMark: RegExp;
  export default unicodeMark;
}
```

- [ ] **Step 5: Add the shared Notes Unicode-category helper**

Create `src/features/notes/noteUnicodeCategories.ts`:

```ts
import unicodeLetter from "@unicode/unicode-17.0.0/General_Category/Letter/regex.js";
import unicodeMark from "@unicode/unicode-17.0.0/General_Category/Mark/regex.js";
import unicodeNumber from "@unicode/unicode-17.0.0/General_Category/Number/regex.js";

export function isUnicodeLetterOrNumber(character: string): boolean {
  return unicodeLetter.test(character) || unicodeNumber.test(character);
}

export function isUnicodeMark(character: string): boolean {
  return unicodeMark.test(character);
}

export function isUnicodeWordCharacter(character: string): boolean {
  return character === "_" || isUnicodeLetterOrNumber(character) || isUnicodeMark(character);
}
```

- [ ] **Step 6: Route tag tokenization through the pinned helper**

At the top of `src/features/notes/noteTokens.ts`, import:

```ts
import {
  isUnicodeLetterOrNumber,
  isUnicodeMark
} from "./noteUnicodeCategories";
```

Delete the `unicodeLetterOrNumber` and `unicodeMark` regular-expression constants. Replace the two checks with:

```ts
function isTagBodyStartCharacter(character: string): boolean {
  return character === "_" || character === "-" || isUnicodeLetterOrNumber(character);
}

function isTagBodyContinuationCharacter(character: string): boolean {
  return isTagBodyStartCharacter(character) || isUnicodeMark(character);
}
```

- [ ] **Step 7: Route date boundaries through the same helper**

At the top of `src/features/notes/noteDates.ts`, import:

```ts
import { isUnicodeWordCharacter } from "./noteUnicodeCategories";
```

Delete `unicodeWordCharacter` and the local `isWordCharacter()` function. Replace
its three call sites in `hasStartBoundary()`, `hasEndBoundary()`, and
`hasNumericEndBoundary()` with `isUnicodeWordCharacter(...)`. Do not change
`unicodeWhitespace` or `isWhitespace()`.

- [ ] **Step 8: Run focused frontend and Rust tests and confirm GREEN**

Run:

```bash
npx vitest run src/features/notes/noteSearchQuery.test.ts src/features/notes/noteDates.test.ts
cargo test --manifest-path src-tauri/Cargo.toml notes_tag_tokenizer_matches_shared_typescript_fixtures -- --nocapture
```

Expected: both frontend files pass; the Rust shared-fixture test runs one test and passes.

- [ ] **Step 9: Run full static and production verification**

Run:

```bash
npm test
npm run lint
npm run build
git diff --check
```

Expected: all commands exit 0. The formerly failing shared tokenizer fixture passes on the current Node runtime, and the Vite production build resolves and bundles the pinned category regex modules.

- [ ] **Step 10: Commit the parity fix**

```bash
git add package.json package-lock.json \
  src/types/unicode-17.d.ts \
  src/features/notes/noteUnicodeCategories.ts \
  src/features/notes/noteTokens.ts \
  src/features/notes/noteDates.ts \
  src/features/notes/noteDates.test.ts
git commit -m "fix(notes): pin Unicode 17 text categories"
```
