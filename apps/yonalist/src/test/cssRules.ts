import { expect } from "vitest";

/**
 * The bodies of every at-rule opened by exactly this prelude line, dedented one
 * level so `rule` can read the rules nested inside them.
 */
export function atRule(css: string, prelude: string): string {
  let body = "";
  let inside = false;
  for (const line of css.split("\n")) {
    if (inside) {
      if (line === "}") inside = false;
      else body += `${line.slice(2)}\n`;
    } else if (line === `${prelude} {`) {
      inside = true;
    }
  }
  if (body === "") throw new Error(`missing at-rule: ${prelude}`);
  return body;
}

/** The declarations of every top-level rule opened by exactly this selector line. */
export function rule(css: string, selector: string): string {
  let declarations = "";
  let inside = false;
  for (const line of css.split("\n")) {
    if (inside) {
      if (line === "}") inside = false;
      else declarations += `${line.trim()}\n`;
    } else if (line === `${selector} {`) {
      inside = true;
    }
  }
  if (declarations === "") throw new Error(`missing rule: ${selector}`);
  return declarations;
}

// The WKWebView the app ships in parses only the prefixed property --
// CSS.supports('user-select', 'none') is false there, and a bare declaration is
// dropped whole. The pair is the contract: the prefix for the engine the app
// runs on, the bare property for the engines that no longer take the prefix.
// The bare line is matched anchored because it is a substring of the prefixed
// one, and one line must not pass for both.
export function expectsSelection(
  declarations: string,
  value: "none" | "text"
) {
  expect(declarations).toContain(`-webkit-user-select: ${value};`);
  expect(declarations).toMatch(new RegExp(`^user-select: ${value};$`, "m"));
}
