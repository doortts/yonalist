import DOMPurify from "dompurify";
import hljs from "highlight.js";
import MarkdownIt from "markdown-it";
import { full as emojiPlugin } from "markdown-it-emoji";
import taskLists from "markdown-it-task-lists";

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

const markdown = new MarkdownIt({
  html: false,
  linkify: true,
  breaks: true,
  highlight(code: string, lang: string): string {
    const language = lang && hljs.getLanguage(lang) ? lang : "";
    const highlighted = language
      ? hljs.highlight(code, { language }).value
      : escapeHtml(code);
    const languageClass = language ? ` language-${language}` : "";
    return `<pre class="hljs"><code class="hljs${languageClass}">${highlighted}</code></pre>`;
  }
});

// markdown-it enables GFM tables and strikethrough by default; add task list
// checkboxes and :emoji: shortcodes to match GitHub-flavored markdown.
markdown.use(taskLists, { enabled: true, label: true });
markdown.use(emojiPlugin);

// Keep the task-list checkbox attributes and highlight/label classes through
// sanitization.
const SANITIZE_CONFIG = {
  ADD_ATTR: ["checked", "disabled", "type"]
};

export function renderMarkdown(body: string): { __html: string } {
  return { __html: DOMPurify.sanitize(markdown.render(body), SANITIZE_CONFIG) };
}
