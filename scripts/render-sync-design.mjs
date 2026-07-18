import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import MarkdownIt from 'markdown-it';

const DEFAULT_SOURCE_PATH = 'docs/yonalist-sync-design/design.md';
const DEFAULT_OUTPUT_PATH = 'docs/yonalist-sync-design/index.html';
const DEFAULT_STYLESHEET_HREF = './styles.css';
const DEFAULT_SCRIPT_SRC = './page.js';
const DEFAULT_SOURCE_HREF = './design.md';
const DOCUMENT_SURFACE = new URL('https://local.invalid/document/');
const STATUS_TOKEN_CLASSES = new Map([
  ['현재 구현', 'implemented'],
  ['상위 설계 확정', 'approved'],
  ['후속 구현', 'future'],
]);

function diagramLabel(line) {
  const match = /^\s*(?:>\s*)*<!--\s*diagram:\s*(.*?)\s*-->\s*$/.exec(line);
  return match?.[1] || null;
}

function prepareMarkdown(source) {
  const lines = source.split(/\r?\n/);
  const markdownIt = new MarkdownIt({ html: false, linkify: true, typographer: false });
  const labels = [];
  const labelLines = new Set();

  for (const token of markdownIt.parse(source, {})) {
    if (token.type !== 'fence' || token.info.trim().split(/\s+/)[0].toLowerCase() !== 'mermaid') continue;

    const fenceLine = token.map?.[0];
    const label = fenceLine > 0 ? diagramLabel(lines[fenceLine - 1]) : null;
    if (!label) {
      throw new Error('Each Mermaid fence requires an immediately preceding <!-- diagram: ... --> label.');
    }

    labels.push(label);
    labelLines.add(fenceLine - 1);
  }

  return {
    labels,
    markdown: lines.map((line, index) => (
      labelLines.has(index) ? line.replace(/<!--\s*diagram:\s*.*?\s*-->/, '') : line
    )).join('\n'),
  };
}

function escapeHtml(value) {
  return value.replace(/[&<>"']/g, (character) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  })[character]);
}

function renderStatusTokens(html) {
  return html.replace(
    /<strong>(현재 구현|상위 설계 확정|후속 구현)(:?)<\/strong>/g,
    (match, label, punctuation) => (
      `<span class="status status--${STATUS_TOKEN_CLASSES.get(label)}">${label}</span>${punctuation}`
    ),
  );
}

function installStableHeadingIds(markdownIt) {
  markdownIt.core.ruler.after('inline', 'stable_heading_ids', (state) => {
    const firstIds = new Map();
    const occurrences = new Map();
    let headingOrdinal = 0;

    for (let index = 0; index < state.tokens.length; index += 1) {
      const token = state.tokens[index];
      if (token.type !== 'heading_open' || token.attrGet('id')) continue;

      headingOrdinal += 1;
      const heading = state.tokens[index + 1]?.content ?? '';
      const key = heading.normalize('NFKC').trim().replace(/\s+/g, ' ').toLowerCase();
      const baseId = firstIds.get(key) ?? `section-${String(headingOrdinal).padStart(2, '0')}`;
      const occurrence = (occurrences.get(key) ?? 0) + 1;
      firstIds.set(key, baseId);
      occurrences.set(key, occurrence);
      token.attrSet('id', occurrence === 1 ? baseId : `${baseId}-${occurrence}`);
    }
  });
}

function renderMarkdown(source) {
  const { labels, markdown } = prepareMarkdown(source);
  const markdownIt = new MarkdownIt({ html: false, linkify: true, typographer: false });
  installStableHeadingIds(markdownIt);
  const defaultFence = markdownIt.renderer.rules.fence;

  markdownIt.renderer.rules.fence = (tokens, index, options, environment, renderer) => {
    const token = tokens[index];
    const language = token.info.trim().split(/\s+/)[0].toLowerCase();

    if (language !== 'mermaid') {
      return defaultFence(tokens, index, options, environment, renderer);
    }

    const label = labels.shift();
    return `<pre class="mermaid" role="img" aria-label="다이어그램: ${escapeHtml(label)}">${escapeHtml(token.content)}</pre>\n`;
  };

  return renderStatusTokens(markdownIt.render(markdown));
}

function assertRelativePath(name, value) {
  let resolvedPath;
  try {
    resolvedPath = new URL(value, DOCUMENT_SURFACE);
  } catch {
    resolvedPath = null;
  }

  if (
    typeof value !== 'string'
    || value.length === 0
    || value !== value.trim()
    || /[\p{Cc}\\]/u.test(value)
    || value.startsWith('/')
    || /^[a-z][a-z\d+.-]*:/i.test(value)
    || resolvedPath?.origin !== DOCUMENT_SURFACE.origin
    || !resolvedPath?.pathname.startsWith(DOCUMENT_SURFACE.pathname)
  ) {
    throw new Error(`${name} must be a relative path.`);
  }
}

function renderPageShell({ content, stylesheetHref, scriptSrc, sourceHref }) {
  return `<!doctype html>
<html lang="ko">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Yonalist 분산 동기화 설계</title>
  <link rel="stylesheet" href="${escapeHtml(stylesheetHref)}">
</head>
<body>
  <a class="skip-link" href="#design-content">본문으로 건너뛰기</a>
  <header class="masthead">
    <p class="masthead__eyebrow">Yonalist</p>
    <p class="masthead__title" aria-hidden="true">분산 동기화 설계</p>
    <p>독립 실행형 동기화 코어의 설계 문서</p>
  </header>
  <aside class="scope-legend" aria-label="문서 범례">
    <p class="scope-legend__title" aria-hidden="true">범위</p>
    <p>로컬 저장소, 피어 동기화, 복구 동작을 설명합니다.</p>
  </aside>
  <nav id="table-of-contents" aria-label="문서 목차"></nav>
  <main id="design-content" tabindex="-1">
    <p id="diagram-status" class="diagram-status" role="status" aria-live="polite"></p>
${content}  </main>
  <footer class="source-link">
    <a href="${escapeHtml(sourceHref)}">Markdown 원본 보기</a>
  </footer>
  <script type="module" src="${escapeHtml(scriptSrc)}"></script>
</body>
</html>
`;
}

export async function renderDesignPage({
  sourcePath,
  outputPath,
  stylesheetHref = DEFAULT_STYLESHEET_HREF,
  scriptSrc = DEFAULT_SCRIPT_SRC,
  sourceHref = DEFAULT_SOURCE_HREF,
}, { renameFile = rename } = {}) {
  assertRelativePath('stylesheetHref', stylesheetHref);
  assertRelativePath('scriptSrc', scriptSrc);
  assertRelativePath('sourceHref', sourceHref);

  const source = await readFile(sourcePath, 'utf8');
  const content = renderMarkdown(source);
  const html = renderPageShell({ content, stylesheetHref, scriptSrc, sourceHref });
  const outputDirectory = dirname(outputPath);
  const temporaryPath = join(outputDirectory, `.${basename(outputPath)}.${randomUUID()}.tmp`);

  await mkdir(outputDirectory, { recursive: true });
  try {
    await writeFile(temporaryPath, html, 'utf8');
    await renameFile(temporaryPath, outputPath);
  } catch (error) {
    await unlink(temporaryPath).catch(() => {});
    throw error;
  }
}

async function renderDefaultDesignPage() {
  await renderDesignPage({
    sourcePath: DEFAULT_SOURCE_PATH,
    outputPath: DEFAULT_OUTPUT_PATH,
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  renderDefaultDesignPage().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
