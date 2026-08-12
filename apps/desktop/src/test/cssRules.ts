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
