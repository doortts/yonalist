export interface TextareaCaretLines {
  readonly first: boolean;
  readonly last: boolean;
}

const mirrors = new WeakMap<Document, HTMLDivElement>();
const copiedProperties = [
  "borderBlockEndWidth",
  "borderBlockStartWidth",
  "borderInlineEndWidth",
  "borderInlineStartWidth",
  "boxSizing",
  "fontFamily",
  "fontFeatureSettings",
  "fontKerning",
  "fontSize",
  "fontStretch",
  "fontStyle",
  "fontVariant",
  "fontWeight",
  "letterSpacing",
  "lineHeight",
  "overflowWrap",
  "paddingBlockEnd",
  "paddingBlockStart",
  "paddingInlineEnd",
  "paddingInlineStart",
  "tabSize",
  "textIndent",
  "textTransform",
  "wordBreak",
  "wordSpacing"
] as const;

export function classifyCaretLines(
  caretTop: number,
  firstTop: number,
  lastTop: number
): TextareaCaretLines {
  const tolerance = 0.5;
  return {
    first: Math.abs(caretTop - firstTop) <= tolerance,
    last: Math.abs(caretTop - lastTop) <= tolerance
  };
}

function fallback(textarea: HTMLTextAreaElement): TextareaCaretLines {
  const before = textarea.value.slice(0, textarea.selectionStart);
  const after = textarea.value.slice(textarea.selectionEnd);
  return {
    first: !before.includes("\n"),
    last: !after.includes("\n")
  };
}

function marker(document: Document): HTMLSpanElement {
  const span = document.createElement("span");
  span.textContent = "\u200b";
  span.style.cssText = "display:inline-block;width:0;padding:0;margin:0;";
  return span;
}

function mirrorFor(document: Document): HTMLDivElement {
  const current = mirrors.get(document);
  if (current) return current;
  const mirror = document.createElement("div");
  mirror.setAttribute("aria-hidden", "true");
  mirror.style.cssText = [
    "position:fixed",
    "inset:auto auto auto -100000px",
    "visibility:hidden",
    "pointer-events:none",
    "white-space:pre-wrap",
    "overflow:hidden"
  ].join(";");
  document.body.append(mirror);
  mirrors.set(document, mirror);
  return mirror;
}

export function measureTextareaCaretLines(
  textarea: HTMLTextAreaElement
): TextareaCaretLines {
  if (
    !textarea.isConnected ||
    textarea.clientWidth <= 0 ||
    textarea.selectionStart !== textarea.selectionEnd
  ) {
    return fallback(textarea);
  }

  const document = textarea.ownerDocument;
  const view = document.defaultView;
  if (!view) return fallback(textarea);
  const styles = view.getComputedStyle(textarea);
  const mirror = mirrorFor(document);
  for (const property of copiedProperties) {
    mirror.style[property] = styles[property];
  }
  mirror.style.width = `${textarea.clientWidth}px`;
  mirror.replaceChildren();

  const first = marker(document);
  const caret = marker(document);
  const last = marker(document);
  const offset = textarea.selectionStart;
  mirror.append(
    first,
    document.createTextNode(textarea.value.slice(0, offset)),
    caret,
    document.createTextNode(textarea.value.slice(offset)),
    last
  );
  return classifyCaretLines(caret.offsetTop, first.offsetTop, last.offsetTop);
}
