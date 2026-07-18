import assert from 'node:assert/strict';
import { readFile, stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { JSDOM } from 'jsdom';

const designDirectoryUrl = new URL('../docs/yonalist-sync-design/', import.meta.url);
const designPageUrl = new URL('index.html', designDirectoryUrl);
const designSourceUrl = new URL('design.md', designDirectoryUrl);

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
