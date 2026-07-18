import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { JSDOM } from 'jsdom';

import { validateLocalReferences } from './sync-design-links.mjs';

const designDirectoryUrl = new URL('../docs/yonalist-sync-design/', import.meta.url);
const designPageUrl = new URL('index.html', designDirectoryUrl);
const designSourceUrl = new URL('design.md', designDirectoryUrl);
const designStylesUrl = new URL('styles.css', designDirectoryUrl);

test('published design page has local href and src targets that exist', async () => {
  await assert.doesNotReject(validateLocalReferences(fileURLToPath(designPageUrl)));
});

test('validates a percent-encoded fragment against the referenced HTML document', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'yonalist-sync-links-'));
  const indexPath = join(directory, 'index.html');
  const targetPath = join(directory, 'target.html');

  try {
    await writeFile(indexPath, '<a href="./target.html#%ED%95%9C%EA%B8%80-%EB%AA%A9%ED%91%9C">대상</a>', 'utf8');
    await writeFile(targetPath, '<h2 id="한글-목표">대상 문서</h2>', 'utf8');
    await assert.doesNotReject(validateLocalReferences(indexPath));

    await writeFile(targetPath, '<h2 id="다른-목표">다른 문서</h2>', 'utf8');
    await assert.rejects(validateLocalReferences(indexPath), /fragment must exist/);
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
});

test('canonical design states the current implementation boundaries', async () => {
  const source = await readFile(designSourceUrl, 'utf8');

  for (const phrase of [
    '실제 네트워크 미구현',
    '첨부파일 복제 미구현',
    '이슈 projection 미구현',
    '협력적 철회',
  ]) {
    assert.ok(source.includes(phrase), `canonical design must state: ${phrase}`);
  }
});

test('canonical design fixes owner protection and transfer rules at the approved-design level', async () => {
  const source = await readFile(designSourceUrl, 'utf8');

  assert.match(source, /\*\*상위 설계 확정\*\*[\s\S]*admin은 owner를 revoke할 수 없다/);
  assert.match(source, /member\.role\.changed[^\n]*owner 역할을 부여할 수 없다/);
  assert.match(source, /현재 owner가 서명한 `owner\.transferred` atom으로만/);
});

test('published page contains exactly ten captioned and accessible diagrams', async () => {
  const html = await readFile(designPageUrl, 'utf8');
  const document = new JSDOM(html).window.document;
  const figures = [...document.querySelectorAll('figure.diagram')];

  assert.equal(figures.length, 10);
  assert.equal(document.querySelectorAll('figure.diagram > figcaption').length, 10);
  assert.equal(document.querySelectorAll('figure.diagram > pre.mermaid[role="img"][aria-label]').length, 10);
  assert.equal(new Set(figures.map((figure) => figure.id)).size, 10);

  for (const figure of figures) {
    const caption = figure.querySelector(':scope > figcaption');
    const diagram = figure.querySelector(':scope > pre.mermaid');
    assert.ok(caption?.textContent.match(/[가-힣]/), 'each visible caption must be Korean');
    assert.equal(figure.getAttribute('aria-labelledby'), caption.id);
    assert.equal(diagram.getAttribute('aria-describedby'), caption.id);
    assert.match(diagram.getAttribute('aria-label'), /[가-힣]/);
  }
});

test('preview command serves the repository root and documents the design page path', async () => {
  const [packageSource, readme] = await Promise.all([
    readFile(new URL('../package.json', import.meta.url), 'utf8'),
    readFile(new URL('../README.md', import.meta.url), 'utf8'),
  ]);
  const packageJson = JSON.parse(packageSource);

  assert.equal(packageJson.scripts['docs:sync-design:serve'], 'vite . --host 127.0.0.1');
  assert.match(readme, /npm run docs:sync-design:serve/);
  assert.match(readme, /http:\/\/127\.0\.0\.1:5173\/docs\/yonalist-sync-design\//);
});

test('published page has one Markdown H1 followed by a valid heading hierarchy', async () => {
  const html = await readFile(designPageUrl, 'utf8');
  const document = new JSDOM(html).window.document;
  const headings = [...document.querySelectorAll('h1, h2, h3, h4, h5, h6')];

  assert.equal(document.querySelectorAll('h1').length, 1, 'the Markdown title must be the sole H1');
  assert.equal(headings[0]?.tagName, 'H1', 'the document outline must begin at H1');

  for (let index = 1; index < headings.length; index += 1) {
    const previousLevel = Number(headings[index - 1].tagName.slice(1));
    const level = Number(headings[index].tagName.slice(1));
    assert.ok(level <= previousLevel + 1, `heading level must not jump: ${headings[index].outerHTML}`);
  }

  const mastheadTitle = document.querySelector('.masthead__title');
  const scopeTitle = document.querySelector('.scope-legend__title');
  assert.equal(mastheadTitle?.tagName, 'P');
  assert.equal(mastheadTitle?.getAttribute('aria-hidden'), 'true');
  assert.equal(scopeTitle?.tagName, 'P');
  assert.equal(scopeTitle?.getAttribute('aria-hidden'), 'true');
});

test('canonical design separates relationship atoms from body-derived reference edges', async () => {
  const [source, html] = await Promise.all([
    readFile(designSourceUrl, 'utf8'),
    readFile(designPageUrl, 'utf8'),
  ]);
  const pageText = new JSDOM(html).window.document.body.textContent;
  const issueUri = 'yonalist://<project-id>/issue/<issue-id>';
  const commentUri = 'yonalist://<project-id>/comment/<comment-id>';

  assert.match(source, /issue\.relationship\.added/);
  assert.match(source, /issue\.relationship\.removed/);
  assert.match(source, /명시적인 primary atom/);
  assert.match(source, /primary atom이 아닌 파생 reference edge/);
  assert.ok(source.includes('| 영역 | atom 또는 표현 예 | 수렴 규칙 | 현재 상태 |'));
  assert.ok(!source.includes('| 영역 | 상위 설계의 atom 예 | 수렴 규칙 | 현재 상태 |'));
  assert.match(source, /^yonalist:\/\/<project-id>\/issue\/<issue-id>$/m);
  assert.match(source, /^yonalist:\/\/<project-id>\/comment\/<comment-id>$/m);
  assert.ok(pageText.includes(issueUri), `generated page must contain ${issueUri}`);
  assert.ok(pageText.includes(commentUri), `generated page must contain ${commentUri}`);

  for (const artifact of [source, html]) {
    assert.ok(!artifact.includes('yonalist://project/issue-or-comment/id'));
  }
});

test('canonical repository diagram describes catalog as local location and presentation settings', async () => {
  const source = await readFile(designSourceUrl, 'utf8');

  assert.match(source, /CAT\["catalog\.cbor\\n로컬 저장소 위치·표시 설정"\]/);
  assert.ok(!source.includes('catalog.cbor\\n로컬 장치 목록'));
});

test('stylesheet disables smooth scrolling when reduced motion is requested', async () => {
  const stylesheet = await readFile(designStylesUrl, 'utf8');

  assert.match(
    stylesheet,
    /@media\s*\(prefers-reduced-motion:\s*reduce\)\s*\{[\s\S]*?html\s*\{[\s\S]*?scroll-behavior:\s*auto;/,
  );
});
