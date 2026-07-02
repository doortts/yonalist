import YAML from "yaml";

export interface ParsedMarkdownDocument<TFrontMatter> {
  frontMatter: TFrontMatter;
  body: string;
}

const FRONT_MATTER_OPEN = "---\n";
// The closing fence must be a line containing exactly `---`, so a `---`
// embedded inside a YAML value never terminates the front matter early.
const FRONT_MATTER_CLOSE_PATTERN = /\n---(?:\r?\n|$)/;

export function parseMarkdownDocument<TFrontMatter = Record<string, unknown>>(
  markdown: string
): ParsedMarkdownDocument<TFrontMatter> {
  if (!markdown.startsWith(FRONT_MATTER_OPEN)) {
    return {
      frontMatter: {} as TFrontMatter,
      body: markdown
    };
  }

  const close = FRONT_MATTER_CLOSE_PATTERN.exec(
    markdown.slice(FRONT_MATTER_OPEN.length - 1)
  );
  if (!close) {
    throw new Error("Markdown document is missing a closing front matter fence.");
  }

  const closeIndex = FRONT_MATTER_OPEN.length - 1 + close.index;
  const yaml = markdown.slice(FRONT_MATTER_OPEN.length, closeIndex);
  const body = markdown.slice(closeIndex + close[0].length);

  return {
    frontMatter: (YAML.parse(yaml) ?? {}) as TFrontMatter,
    body
  };
}

export function serializeMarkdownDocument<TFrontMatter>(
  frontMatter: TFrontMatter,
  body: string
): string {
  const yaml = YAML.stringify(frontMatter).trimEnd();
  return `${FRONT_MATTER_OPEN}${yaml}\n---\n${body}`;
}
