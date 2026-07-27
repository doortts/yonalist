import { readFileSync } from "node:fs";
import postcss, { type Root } from "postcss";
import { describe, expect, it } from "vitest";

const styles = readFileSync("src/styles.css", "utf8");
const baseThemeStyles = readFileSync("src/themes/base-ui-pure.css", "utf8");
const notesStyles = readFileSync("src/features/notes/notes.css", "utf8");
const stylesRoot = postcss.parse(styles);
const baseThemeRoot = postcss.parse(baseThemeStyles);
const notesRoot = postcss.parse(notesStyles);

function rule(root: Root, selector: string): string {
  let declarations = "";
  root.walkRules((candidate) => {
    if (candidate.selectors.includes(selector)) {
      declarations += `${candidate.nodes
        .map((node) => node.toString())
        .join("\n")}\n`;
    }
  });
  return declarations;
}

function topLevelRule(root: Root, selector: string): string {
  let declarations = "";
  root.walkRules((candidate) => {
    if (candidate.parent === root && candidate.selectors.includes(selector)) {
      declarations += `${candidate.nodes
        .map((node) => node.toString())
        .join("\n")}\n`;
    }
  });
  return declarations;
}

function mediaRule(root: Root, params: string): string {
  let content = "";
  root.walkAtRules("media", (candidate) => {
    if (candidate.params === params) {
      content += candidate.toString();
    }
  });
  return content;
}

describe("surviving application styles", () => {
  it("keeps the status bar transparent", () => {
    const statusbar = rule(stylesRoot, ".app-statusbar");
    expect(statusbar).toContain("background: transparent");
    expect(statusbar).not.toContain("border-top");
  });

  it("keeps the unified navigation pane framed as an application pane", () => {
    const navigationPane = rule(stylesRoot, ".yonalist-navigation-pane");
    expect(navigationPane).toContain("background: var(--bg-list)");
    expect(navigationPane).toContain("border: 1px solid var(--border)");
    expect(navigationPane).toContain("border-radius: var(--radius-lg)");
  });

  it("keeps the Notes detail minimum while allowing Settings detail to shrink", () => {
    const notesShell = topLevelRule(stylesRoot, ".app-shell");
    const settingsShell = topLevelRule(
      stylesRoot,
      '.app-shell[data-has-middle-pane="true"]'
    );

    expect(notesShell).toContain("var(--sidebar-width, 336px)");
    expect(notesShell).toContain("minmax(520px, 1fr)");
    expect(notesShell).not.toContain("var(--list-width, 340px)");
    expect(settingsShell).toContain("var(--list-width, 340px)");
    expect(settingsShell).toContain("minmax(280px, 1fr)");
    expect(settingsShell).not.toContain("minmax(520px, 1fr)");
  });

  it("keeps Notes horizontal at tablet widths and stacks Settings detail below its middle pane", () => {
    const tablet = mediaRule(stylesRoot, "(max-width: 980px)");

    expect(tablet).toMatch(
      /\.app-shell\s*\{[^}]*grid-template-rows:\s*minmax\(0, 1fr\) auto;/s
    );
    expect(tablet).toMatch(
      /\.app-shell\[data-has-middle-pane="true"\]\s*\{[^}]*grid-template-rows:\s*minmax\(0, 42%\) minmax\(0, 1fr\) auto;/s
    );
  });

  it("stacks both Notes and Settings in DOM order on narrow screens", () => {
    const narrow = mediaRule(stylesRoot, "(max-width: 720px)");

    expect(narrow).toMatch(
      /\.app-shell,\s*\.app-shell\[data-has-middle-pane="true"\]\s*\{[^}]*grid-template-rows:\s*none;/s
    );
  });

  it("resets responsive rows and pins Detail when maximized", () => {
    const maximizedShell = rule(
      stylesRoot,
      '.app-shell[data-detail-maximized="true"]'
    );
    const maximizedDetail = rule(
      stylesRoot,
      '.app-shell[data-detail-maximized="true"] > .detail-pane'
    );
    const maximizedStatusbar = rule(
      stylesRoot,
      '.app-shell[data-detail-maximized="true"] > .app-statusbar'
    );

    expect(styles.lastIndexOf('.app-shell[data-detail-maximized="true"]')).toBeGreaterThan(
      styles.indexOf("@media (max-width: 720px)")
    );
    expect(maximizedShell).toContain("grid-template-rows: minmax(0, 1fr) auto");
    expect(maximizedDetail).toContain("grid-row: 1");
    expect(maximizedDetail).toContain("grid-column: -2 / -1");
    expect(maximizedStatusbar).toContain("grid-row: 2");
  });

  it("keeps Settings scrollable inside its pane", () => {
    const settings = rule(stylesRoot, ".settings-body");
    expect(settings).toContain("min-height: 0");
    expect(settings).toContain("overflow: auto");
  });

  it("keeps Markdown content width and wrapping", () => {
    const markdown = rule(stylesRoot, ".markdown-body");
    expect(markdown).toContain("max-width: 980px");
    expect(markdown).toContain("overflow-wrap: break-word");
  });

  it("keeps the Notes outline geometry", () => {
    const outline = rule(notesRoot, ".notes-outline");
    expect(outline).toContain("--notes-outline-indent: 36px");
    expect(outline).toContain("flex-direction: column");
    expect(outline).toContain("min-height: 100%");
  });

  it("keeps shared base-theme category, chip, and offline treatments", () => {
    expect(
      rule(
        baseThemeRoot,
        ':root[data-theme="base-light"] .category-item.active'
      )
    ).toContain("background: var(--bg-active)");
    expect(
      rule(baseThemeRoot, ':root[data-theme="base-light"] .chip')
    ).toContain("border: 1px solid var(--border)");
    expect(
      rule(baseThemeRoot, ':root[data-theme="base-light"] .offline-badge')
    ).toContain("border-radius: var(--radius-sm)");
  });

  it("does not ship selectors for producerless Inbox UI", () => {
    const producerlessClassNames = new Set([
      "item-state-tab",
      "item-card",
      "label-chip",
      "state-badge",
      "item-label",
      "comment-association",
      "item-sync-pending",
      "outbox-checkbox",
      "login-shell",
      "login-card",
      "login-card-header",
      "login-copy",
      "login-skip",
      "login-error",
      "detail-header",
      "detail-title-row",
      "detail-header-actions",
      "favorite-button",
      "detail-actions",
      "state-open",
      "state-closed",
      "state-merged",
      "state-draft",
      "chip-status",
      "detail-connection",
      "content-panel",
      "author-row",
      "conversation",
      "opening-post",
      "opening-post-header",
      "opening-post-body",
      "entry-avatar-slot",
      "inline-reply-composer",
      "reactions",
      "reaction",
      "reaction-emoji",
      "composer-preview-toggle",
      "composer-actions",
      "composer-buttons",
      "secondary-danger-button",
      "composer-close-split",
      "composer-close-main",
      "composer-close-trigger",
      "composer-close-single",
      "composer-close-menu",
      "composer-close-menu-item",
      "composer-close-check",
      "composer-close-option-icon",
      "composer-close-menu-discussion",
      "composer-close-option-copy",
      "composer-close-duplicate-arrow",
      "detail-empty",
      "empty-copy",
      "issue-create-page",
      "issue-create-header",
      "issue-create-body",
      "issue-body-field",
      "issue-create-actions",
      "project-visibility-search",
      "project-visibility-list",
      "project-visibility-group",
      "project-owner-row",
      "project-group-toggle",
      "project-owner-count",
      "project-owner-check",
      "project-repo-check",
      "project-repo-source",
      "notification-row",
      "notification-lead",
      "notification-reason",
      "reason-mention",
      "reason-comment",
      "reason-author",
      "reason-team",
      "notification-main",
      "notification-title",
      "notification-number",
      "notification-subtitle",
      "notification-unread-dot",
      "notification-hide",
      "loading-dots",
      "detail-error",
      "notification-comments",
      "chip-state-open",
      "chip-state-closed",
      "chip-state-merged",
      "chip-state-draft",
      "nav-badge",
      "statusbar-metrics",
      "nav-section-heading",
      "nav-section-icon-button",
      "nav-owner-group",
      "nav-owner",
      "nav-note",
      "list-refresh",
      "list-note",
      "list-error",
      "search-row",
      "small-bookmark",
      "list-empty",
      "modal-actions",
      "detail-maximize-toggle"
    ]);
    const producerlessSelectors = new Set([".nav-item strong"]);
    const residue: string[] = [];
    for (const [stylesheet, root] of [
      ["src/styles.css", stylesRoot],
      ["src/themes/base-ui-pure.css", baseThemeRoot]
    ] as const) {
      root.walkRules((candidate) => {
        for (const selector of candidate.selectors) {
          const classNames = Array.from(
            selector.matchAll(/\.([A-Za-z0-9_-]+)/g),
            (match) => match[1]
          );
          if (
            classNames.some((className) => producerlessClassNames.has(className)) ||
            producerlessSelectors.has(selector)
          ) {
            residue.push(`${stylesheet}: ${selector}`);
          }
        }
      });
    }

    expect(residue).toEqual([]);
    expect(
      stylesRoot.nodes.some(
        (node) => node.type === "atrule" && node.name === "keyframes" &&
          node.params === "skeleton-shimmer"
      )
    ).toBe(false);
  });
});
