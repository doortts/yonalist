import type { MarkdownStyle } from "../appSettings";
import { MarkdownBody } from "./MarkdownBody";

interface MarkdownStyleComparisonProps {
  value: MarkdownStyle;
  onChange: (style: MarkdownStyle) => void;
}

const markdownSample = `# Release checklist

GitHub-flavored Markdown should feel familiar inside this app: **bold text**, _emphasis_, ~~removed text~~, and [a link](https://github.com).

> A quote keeps a muted border and compact spacing.

- [x] Render task lists
- [ ] Review table and code styles
- Nested item with \`inline code\`

| Area | GitHub | Yona |
| --- | --- | --- |
| Body | 14px / 1.5 | 14.3px / looser lines |
| Code | Muted block | Bordered inline code |

\`\`\`ts
type IssueState = "open" | "closed";
const synced = true;
\`\`\`
`;

const styleOptions: Array<{
  value: MarkdownStyle;
  label: string;
  description: string;
}> = [
  {
    value: "github",
    label: "GitHub",
    description: "14px issue/comment body text, compact headings, muted code blocks."
  },
  {
    value: "yona",
    label: "Yona",
    description: "14.3px body text, looser paragraph rhythm, bordered inline code."
  }
];

export function MarkdownStyleComparison({
  value,
  onChange
}: MarkdownStyleComparisonProps) {
  return (
    <section className="settings-section markdown-style-section">
      <div className="settings-section-title">
        <h3>Markdown rendering</h3>
      </div>
      <div
        className="theme-options markdown-style-options"
        role="radiogroup"
        aria-label="Markdown style"
      >
        {styleOptions.map((option) => (
          <label
            key={option.value}
            className={
              value === option.value ? "theme-option active" : "theme-option"
            }
          >
            <input
              type="radio"
              name="markdown-style"
              aria-label={`${option.label} markdown style`}
              value={option.value}
              checked={value === option.value}
              onChange={() => onChange(option.value)}
            />
            <span>
              {option.label}
              <em>{option.description}</em>
            </span>
          </label>
        ))}
      </div>

      <div className="markdown-comparison-grid" aria-label="Markdown rendering samples">
        <article className="markdown-comparison-panel">
          <header>
            <h4>GitHub sample</h4>
            <p>Primer-like spacing, 14px issue/comment body text, GitHub table/code colors.</p>
          </header>
          <MarkdownBody body={markdownSample} variant="github" />
        </article>
        <article className="markdown-comparison-panel">
          <header>
            <h4>Yona sample</h4>
            <p>14.3px body text, more relaxed list spacing, older Yona code styling.</p>
          </header>
          <MarkdownBody body={markdownSample} variant="yona" />
        </article>
      </div>
    </section>
  );
}
