import YAML from "yaml";

export interface ParsedMarkdownDocument<TFrontMatter> {
  frontMatter: TFrontMatter;
  body: string;
}

const FRONT_MATTER_OPEN = "---\n";
const FRONT_MATTER_CLOSE = "\n---";

export function parseMarkdownDocument<TFrontMatter = Record<string, unknown>>(
  markdown: string
): ParsedMarkdownDocument<TFrontMatter> {
  if (!markdown.startsWith(FRONT_MATTER_OPEN)) {
    return {
      frontMatter: {} as TFrontMatter,
      body: markdown
    };
  }

  const closeIndex = markdown.indexOf(FRONT_MATTER_CLOSE, FRONT_MATTER_OPEN.length);
  if (closeIndex === -1) {
    throw new Error("Markdown document is missing a closing front matter fence.");
  }

  const yaml = markdown.slice(FRONT_MATTER_OPEN.length, closeIndex);
  const bodyStart = closeIndex + FRONT_MATTER_CLOSE.length;
  const body = markdown.slice(bodyStart).replace(/^\n/, "");

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
