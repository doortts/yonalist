import { readFileSync } from "node:fs";

/**
 * A `var(--x)` whose token nobody declares resolves to nothing, so the property
 * is dropped — and a dropped `background` is not a visible error, it is a panel
 * you can read the notes through. That is how the sync-folder card shipped
 * transparent: it asked for `--surface-1`, which never existed.
 *
 * A token with a fallback is fine and deliberate: those are the ones JavaScript
 * sets at runtime for pane widths and scrollbar offsets, and the fallback is what
 * they look like before it does.
 */
it("declares every style token it uses without a fallback", () => {
  // Relative to the package root, which is where vitest runs.
  const css = readFileSync("src/styles.css", "utf8");
  const declared = new Set(
    [...css.matchAll(/^\s*(--[a-z0-9-]+)\s*:/gm)].map((match) => match[1])
  );
  // `var(--x)` and `var(--x )` only — a comma means a fallback follows.
  const undeclared = [
    ...new Set(
      [...css.matchAll(/var\((--[a-z0-9-]+)\s*\)/g)]
        .map((match) => match[1])
        .filter((token) => !declared.has(token))
    )
  ];

  expect(undeclared).toEqual([]);
});
