import assert from 'node:assert/strict';
import { readFile, stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { JSDOM } from 'jsdom';

const designDirectoryUrl = new URL('../docs/yonalist-sync-design/', import.meta.url);
const designPageUrl = new URL('index.html', designDirectoryUrl);
const designSourceUrl = new URL('design.md', designDirectoryUrl);
const designStylesUrl = new URL('styles.css', designDirectoryUrl);

test('published design page has local href and src targets that exist', async () => {
  const html = await readFile(designPageUrl, 'utf8');
  const document = new JSDOM(html).window.document;
  const resourceAttributes = [...document.querySelectorAll('[href], [src]')]
    .flatMap((element) => ['href', 'src']
      .filter((attribute) => element.hasAttribute(attribute))
      .map((attribute) => ({ attribute, value: element.getAttribute(attribute) })));

  for (const { attribute, value } of resourceAttributes) {
    assert.ok(value, `${attribute} must not be empty`);
    const target = new URL(value, designPageUrl);
    if (target.protocol !== 'file:') continue;

    await assert.doesNotReject(
      stat(fileURLToPath(target)),
      `${attribute} target must exist: ${value}`,
    );

    if (target.hash) {
      const targetId = decodeURIComponent(target.hash.slice(1));
      assert.ok(document.getElementById(targetId), `${attribute} fragment must exist: ${value}`);
    }
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
