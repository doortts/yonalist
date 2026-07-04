declare module "markdown-it-emoji" {
  import type MarkdownIt from "markdown-it";

  export const full: (md: MarkdownIt, options?: unknown) => void;
  export const light: (md: MarkdownIt, options?: unknown) => void;
  export const bare: (md: MarkdownIt, options?: unknown) => void;
}
