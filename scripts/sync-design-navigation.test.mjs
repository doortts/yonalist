import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { JSDOM } from 'jsdom';

class FakeIntersectionObserver {
  static instance;

  constructor(callback) {
    this.callback = callback;
    this.observed = [];
    FakeIntersectionObserver.instance = this;
  }

  observe(element) {
    this.observed.push(element);
  }

  emit(...observations) {
    this.callback(observations);
  }
}

function currentLinks(document) {
  return [...document.querySelectorAll('#table-of-contents [aria-current="location"]')];
}

test('keeps native TOC navigation active across hashes, clicks, and scrolling', async () => {
  const dom = new JSDOM(`<!doctype html>
    <nav id="table-of-contents"></nav>
    <main>
      <p id="diagram-status"></p>
      <h2 id="alpha">알파</h2>
      <h2 id="beta">베타</h2>
    </main>`, { url: 'https://local.invalid/design/#beta' });
  const previousWindow = globalThis.window;
  const previousDocument = globalThis.document;
  const previousObserver = globalThis.IntersectionObserver;

  globalThis.window = dom.window;
  globalThis.document = dom.window.document;
  globalThis.IntersectionObserver = FakeIntersectionObserver;
  dom.window.IntersectionObserver = FakeIntersectionObserver;

  try {
    const pageUrl = new URL('../docs/yonalist-sync-design/page.js', import.meta.url);
    pageUrl.searchParams.set('test', String(Date.now()));
    await import(pageUrl.href);

    const links = [...dom.window.document.querySelectorAll('#table-of-contents a')];
    assert.equal(links.length, 2);
    assert.deepEqual(currentLinks(dom.window.document), [links[1]], 'initial fragment is selected');

    FakeIntersectionObserver.instance.emit({
      target: dom.window.document.querySelector('#alpha'),
      isIntersecting: true,
      boundingClientRect: { top: 0 },
    });
    assert.deepEqual(
      currentLinks(dom.window.document),
      [links[1]],
      'a stale observer callback does not override the hash selection',
    );

    dom.window.dispatchEvent(new dom.window.WheelEvent('wheel'));
    FakeIntersectionObserver.instance.emit({
      target: dom.window.document.querySelector('#alpha'),
      isIntersecting: true,
      boundingClientRect: { top: 0 },
    });
    assert.deepEqual(currentLinks(dom.window.document), [links[0]], 'normal scrolling resumes observation');

    dom.window.history.replaceState(null, '', '#beta');
    dom.window.dispatchEvent(new dom.window.HashChangeEvent('hashchange'));
    assert.deepEqual(currentLinks(dom.window.document), [links[1]], 'hashchange selects its target');

    const click = new dom.window.MouseEvent('click', { bubbles: true, cancelable: true });
    links[0].dispatchEvent(click);
    assert.equal(click.defaultPrevented, false, 'TOC links keep native fragment navigation');
    assert.deepEqual(currentLinks(dom.window.document), [links[0]], 'click selection is immediate and unique');

    dom.window.history.replaceState(null, '', '#does-not-exist');
    assert.doesNotThrow(() => dom.window.dispatchEvent(new dom.window.HashChangeEvent('hashchange')));
    assert.ok(currentLinks(dom.window.document).length <= 1);

    dom.window.history.replaceState(null, '', '/design/');
    assert.doesNotThrow(() => dom.window.dispatchEvent(new dom.window.HashChangeEvent('hashchange')));
  } finally {
    globalThis.window = previousWindow;
    globalThis.document = previousDocument;
    globalThis.IntersectionObserver = previousObserver;
    dom.window.close();
  }
});

test('uses the neutral Mermaid theme and resets status colors for print', async () => {
  const [pageScript, stylesheet] = await Promise.all([
    readFile(new URL('../docs/yonalist-sync-design/page.js', import.meta.url), 'utf8'),
    readFile(new URL('../docs/yonalist-sync-design/styles.css', import.meta.url), 'utf8'),
  ]);

  assert.match(pageScript, /theme:\s*'neutral'/);
  assert.doesNotMatch(pageScript, /theme:\s*'base'/);
  assert.match(pageScript, /import\(\/\* @vite-ignore \*\/ MERMAID_ESM_URL\)/);

  const printRules = stylesheet.slice(stylesheet.indexOf('@media print'));
  for (const variable of [
    '--implemented-ink',
    '--implemented-bg',
    '--implemented-border',
    '--approved-ink',
    '--approved-bg',
    '--approved-border',
    '--future-ink',
    '--future-bg',
    '--future-border',
  ]) {
    assert.match(printRules, new RegExp(`${variable}:\\s*#[0-9a-f]{3,6}`, 'i'));
  }
});

test('preserves captions and accessible relationships after Mermaid success and failure', async () => {
  const pageUrl = new URL('../docs/yonalist-sync-design/page.js', import.meta.url);
  pageUrl.searchParams.set('diagram-api-test', String(Date.now()));
  const { renderMermaidDiagrams } = await import(pageUrl.href);
  const createDom = () => new JSDOM(`<!doctype html>
    <p id="diagram-status"></p>
    <figure class="diagram" id="diagram-one" aria-labelledby="diagram-caption-one">
      <pre class="mermaid" role="img" aria-label="다이어그램: 동기화 흐름" aria-describedby="diagram-caption-one">flowchart LR\nA--&gt;B</pre>
      <figcaption id="diagram-caption-one">그림 1. 동기화 흐름</figcaption>
    </figure>`, { url: 'https://local.invalid/design/' });

  for (const outcome of ['success', 'failure']) {
    const dom = createDom();
    const previousWindow = globalThis.window;
    const previousDocument = globalThis.document;
    globalThis.window = dom.window;
    globalThis.document = dom.window.document;

    try {
      await renderMermaidDiagrams({
        loadMermaid: async () => {
          if (outcome === 'failure') throw new Error('offline');
          return {
            default: {
              initialize() {},
              async run({ nodes }) {
                nodes[0].removeAttribute('role');
                nodes[0].removeAttribute('aria-label');
                nodes[0].removeAttribute('aria-describedby');
                nodes[0].innerHTML = '<svg aria-hidden="true"></svg>';
              },
            },
          };
        },
      });

      const figure = dom.window.document.querySelector('figure.diagram');
      const diagram = figure.querySelector('pre.mermaid');
      const caption = figure.querySelector('figcaption');
      assert.equal(caption.textContent, '그림 1. 동기화 흐름');
      assert.equal(figure.getAttribute('aria-labelledby'), caption.id);
      assert.equal(diagram.getAttribute('role'), 'img');
      assert.equal(diagram.getAttribute('aria-label'), '다이어그램: 동기화 흐름');
      assert.equal(diagram.getAttribute('aria-describedby'), caption.id);
    } finally {
      globalThis.window = previousWindow;
      globalThis.document = previousDocument;
      dom.window.close();
    }
  }
});
