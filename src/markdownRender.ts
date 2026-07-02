import DOMPurify from "dompurify";
import MarkdownIt from "markdown-it";

const markdown = new MarkdownIt({
  html: false,
  linkify: true,
  breaks: true
});

export function renderMarkdown(body: string): { __html: string } {
  return { __html: DOMPurify.sanitize(markdown.render(body)) };
}
