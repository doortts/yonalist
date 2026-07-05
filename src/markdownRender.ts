import DOMPurify from "dompurify";
// Core build only: the full highlight.js bundle registers all 192 languages
// (~45KB gzipped) at import time. Register just the languages that actually
// show up in GitHub conversations; anything else falls back to escaped text.
import hljs from "highlight.js/lib/core";
import bash from "highlight.js/lib/languages/bash";
import c from "highlight.js/lib/languages/c";
import cpp from "highlight.js/lib/languages/cpp";
import csharp from "highlight.js/lib/languages/csharp";
import css from "highlight.js/lib/languages/css";
import diff from "highlight.js/lib/languages/diff";
import go from "highlight.js/lib/languages/go";
import java from "highlight.js/lib/languages/java";
import javascript from "highlight.js/lib/languages/javascript";
import json from "highlight.js/lib/languages/json";
import kotlin from "highlight.js/lib/languages/kotlin";
import markdownLang from "highlight.js/lib/languages/markdown";
import python from "highlight.js/lib/languages/python";
import ruby from "highlight.js/lib/languages/ruby";
import rust from "highlight.js/lib/languages/rust";
import shell from "highlight.js/lib/languages/shell";
import sql from "highlight.js/lib/languages/sql";
import swift from "highlight.js/lib/languages/swift";
import typescript from "highlight.js/lib/languages/typescript";
import xml from "highlight.js/lib/languages/xml";
import yaml from "highlight.js/lib/languages/yaml";
import MarkdownIt from "markdown-it";
import { full as emojiPlugin } from "markdown-it-emoji";
import taskLists from "markdown-it-task-lists";

hljs.registerLanguage("bash", bash);
hljs.registerLanguage("c", c);
hljs.registerLanguage("cpp", cpp);
hljs.registerLanguage("csharp", csharp);
hljs.registerLanguage("css", css);
hljs.registerLanguage("diff", diff);
hljs.registerLanguage("go", go);
hljs.registerLanguage("java", java);
hljs.registerLanguage("javascript", javascript);
hljs.registerLanguage("json", json);
hljs.registerLanguage("kotlin", kotlin);
hljs.registerLanguage("markdown", markdownLang);
hljs.registerLanguage("python", python);
hljs.registerLanguage("ruby", ruby);
hljs.registerLanguage("rust", rust);
hljs.registerLanguage("shell", shell);
hljs.registerLanguage("sql", sql);
hljs.registerLanguage("swift", swift);
hljs.registerLanguage("typescript", typescript);
hljs.registerLanguage("xml", xml);
hljs.registerLanguage("yaml", yaml);

const LANGUAGE_ALIASES: Record<string, string> = {
  golang: "go"
};

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function highlightLanguage(info: string): string {
  const requested = info.trim().split(/\s+/)[0]?.toLowerCase() ?? "";
  const language = LANGUAGE_ALIASES[requested] ?? requested;
  return language && hljs.getLanguage(language) ? language : "";
}

function stripScriptTags(body: string): string {
  return body
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "")
    .replace(/<script\b[^>]*\/?>/gi, "");
}

const markdown = new MarkdownIt({
  html: true,
  linkify: true,
  breaks: true,
  highlight(code: string, lang: string): string {
    const language = highlightLanguage(lang);
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
  ADD_ATTR: ["checked", "disabled", "type", "width", "height", "loading"]
};

export function renderMarkdown(body: string): { __html: string } {
  return {
    __html: DOMPurify.sanitize(
      markdown.render(stripScriptTags(body)),
      SANITIZE_CONFIG
    )
  };
}
