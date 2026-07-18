import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import test from 'node:test';

import { renderDesignPage } from './render-sync-design.mjs';

const koreanFixture = `# 분산 동기화 설계

여러 기기에서 노트를 안전하게 동기화합니다.

<!-- diagram: 두 피어 사이의 동기화 흐름 -->
\`\`\`mermaid
flowchart LR
  A[로컬 노트] --> B[동기화]
\`\`\`
`;

async function withTemporaryDirectory(run) {
  const directory = await mkdtemp(join(tmpdir(), 'yonalist-sync-design-'));

  try {
    await run(directory);
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
}

test('renders a deterministic Korean design page with accessible Mermaid', async () => {
  await withTemporaryDirectory(async (directory) => {
    const sourcePath = join(directory, 'design.md');
    const firstOutputPath = join(directory, 'first.html');
    const secondOutputPath = join(directory, 'second.html');
    await writeFile(sourcePath, koreanFixture, 'utf8');

    const rendererOptions = {
      stylesheetHref: './fixture.css',
      scriptSrc: './fixture.js',
      sourceHref: './source.md',
    };
    await renderDesignPage({
      sourcePath,
      outputPath: firstOutputPath,
      ...rendererOptions,
    });
    await renderDesignPage({
      sourcePath,
      outputPath: secondOutputPath,
      ...rendererOptions,
    });

    const html = await readFile(firstOutputPath, 'utf8');
    const secondHtml = await readFile(secondOutputPath, 'utf8');

    assert.match(html, /<html lang="ko">/);
    assert.match(html, /<main id="design-content"/);
    assert.match(html, /<figure class="diagram"/);
    assert.match(html, /<pre class="mermaid"/);
    assert.match(html, /aria-label="다이어그램:/);
    assert.match(html, /<figcaption[^>]*>그림 1\. 두 피어 사이의 동기화 흐름<\/figcaption>/);
    assert.match(html, /href="\.\/fixture\.css"/);
    assert.match(html, /src="\.\/fixture\.js"/);
    assert.match(html, /href="\.\/source\.md"/);
    assert.doesNotMatch(html, /\/Users\//);
    assert.equal(html, secondHtml);
  });
});

test('renders a local-only page shell with a skip link and diagram status', async () => {
  await withTemporaryDirectory(async (directory) => {
    const sourcePath = join(directory, 'design.md');
    const outputPath = join(directory, 'output.html');
    await writeFile(sourcePath, koreanFixture, 'utf8');

    await renderDesignPage({ sourcePath, outputPath });
    const html = await readFile(outputPath, 'utf8');
    const shellPaths = [...html.matchAll(/\b(?:href|src)="([^"]+)"/g)].map((match) => match[1]);

    assert.match(html, /<a class="skip-link" href="#design-content">본문으로 건너뛰기<\/a>/);
    assert.match(html, /id="diagram-status"[^>]*aria-live="polite"/);
    assert.deepEqual(shellPaths, ['./styles.css', '#design-content', './design.md', './page.js']);
    assert.doesNotMatch(html, /<script(?![^>]*\bsrc=)[^>]*>/i);
    assert.doesNotMatch(html, /(?:file:|\/Users\/|[A-Za-z]:\\)/i);
  });
});

test('marks Korean design-status labels with durable presentation classes', async () => {
  await withTemporaryDirectory(async (directory) => {
    const sourcePath = join(directory, 'design.md');
    const outputPath = join(directory, 'output.html');
    await writeFile(
      sourcePath,
      '**현재 구현**\n\n**상위 설계 확정**\n\n**후속 구현**\n',
      'utf8',
    );

    await renderDesignPage({ sourcePath, outputPath });
    const html = await readFile(outputPath, 'utf8');

    assert.match(html, /<span class="status status--implemented">현재 구현<\/span>/);
    assert.match(html, /<span class="status status--approved">상위 설계 확정<\/span>/);
    assert.match(html, /<span class="status status--future">후속 구현<\/span>/);
  });
});

test('marks scope-legend status labels when the bold label includes a colon', async () => {
  await withTemporaryDirectory(async (directory) => {
    const sourcePath = join(directory, 'design.md');
    const outputPath = join(directory, 'output.html');
    await writeFile(
      sourcePath,
      '- **현재 구현:** 검증됨\n- **상위 설계 확정:** 승인됨\n- **후속 구현:** 예정됨\n',
      'utf8',
    );

    await renderDesignPage({ sourcePath, outputPath });
    const html = await readFile(outputPath, 'utf8');

    assert.match(html, /<span class="status status--implemented">현재 구현<\/span>: 검증됨/);
    assert.match(html, /<span class="status status--approved">상위 설계 확정<\/span>: 승인됨/);
    assert.match(html, /<span class="status status--future">후속 구현<\/span>: 예정됨/);
  });
});

test('assigns content-derived deterministic ASCII IDs to Korean headings', async () => {
  await withTemporaryDirectory(async (directory) => {
    const sourcePath = join(directory, 'headings.md');
    const outputPath = join(directory, 'output.html');
    await writeFile(sourcePath, '# 시스템 설계\n\n## 동기화 흐름\n\n### 세부 단계\n', 'utf8');

    await renderDesignPage({ sourcePath, outputPath });
    const html = await readFile(outputPath, 'utf8');

    const headingIds = [...html.matchAll(/<h[1-3] id="([^"]+)">/g)].map((match) => match[1]);
    assert.equal(headingIds.length, 3);
    assert.equal(new Set(headingIds).size, 3);
    headingIds.forEach((id) => assert.match(id, /^section-[a-f0-9]{12}$/));
  });
});

test('keeps a heading ID stable when an unrelated heading is inserted earlier', async () => {
  await withTemporaryDirectory(async (directory) => {
    const sourcePath = join(directory, 'headings.md');
    const outputPath = join(directory, 'output.html');
    await writeFile(sourcePath, '## 대상 제목\n', 'utf8');
    await renderDesignPage({ sourcePath, outputPath });
    const firstHtml = await readFile(outputPath, 'utf8');
    const firstId = /<h2 id="([^"]+)">대상 제목<\/h2>/.exec(firstHtml)?.[1];

    await writeFile(sourcePath, '## 앞에 추가한 제목\n\n## 대상 제목\n', 'utf8');
    await renderDesignPage({ sourcePath, outputPath });
    const secondHtml = await readFile(outputPath, 'utf8');
    const secondId = /<h2 id="([^"]+)">대상 제목<\/h2>/.exec(secondHtml)?.[1];

    assert.ok(firstId);
    assert.equal(secondId, firstId);
  });
});

test('gives duplicate Korean headings deterministic suffixes without changing the base ID', async () => {
  await withTemporaryDirectory(async (directory) => {
    const sourcePath = join(directory, 'duplicate-headings.md');
    const outputPath = join(directory, 'output.html');
    await writeFile(sourcePath, '## 반복 제목\n\n## 다른 제목\n\n## 반복 제목\n', 'utf8');

    await renderDesignPage({ sourcePath, outputPath });
    const html = await readFile(outputPath, 'utf8');

    const firstId = /<h2 id="([^"]+)">반복 제목<\/h2>/.exec(html)?.[1];
    assert.match(firstId, /^section-[a-f0-9]{12}$/);
    assert.match(html, new RegExp(`<h2 id="${firstId}-2">반복 제목<\\/h2>`));
  });
});

test('renders one visible caption and one text alternative for every Mermaid diagram', async () => {
  await withTemporaryDirectory(async (directory) => {
    const sourcePath = join(directory, 'diagrams.md');
    const outputPath = join(directory, 'output.html');
    await writeFile(sourcePath, `${koreanFixture}\n${koreanFixture.replace('# 분산 동기화 설계\n\n', '').replace('두 피어 사이의 동기화 흐름', '오프라인 변경의 게시 흐름')}`, 'utf8');

    await renderDesignPage({ sourcePath, outputPath });
    const html = await readFile(outputPath, 'utf8');
    const figures = [...html.matchAll(/<figure class="diagram" id="([^"]+)" aria-labelledby="([^"]+)">/g)];
    const captions = [...html.matchAll(/<figcaption id="([^"]+)">(그림 \d+\. [^<]+)<\/figcaption>/g)];
    const alternatives = [...html.matchAll(/<pre class="mermaid" role="img" aria-label="다이어그램: ([^"]+)" aria-describedby="([^"]+)">/g)];

    assert.equal(figures.length, 2);
    assert.equal(captions.length, 2);
    assert.equal(alternatives.length, 2);
    assert.equal(new Set(figures.map((match) => match[1])).size, 2);
    assert.equal(new Set(captions.map((match) => match[1])).size, 2);
    for (let index = 0; index < 2; index += 1) {
      assert.equal(figures[index][2], captions[index][1]);
      assert.equal(alternatives[index][2], captions[index][1]);
      assert.match(captions[index][2], /[가-힣]/);
      assert.match(alternatives[index][1], /[가-힣]/);
    }
  });
});

test('rejects Mermaid without its immediately preceding accessible label', async () => {
  await withTemporaryDirectory(async (directory) => {
    const sourcePath = join(directory, 'missing-label.md');
    const outputPath = join(directory, 'output.html');
    await writeFile(sourcePath, '```mermaid\nflowchart LR\n  A --> B\n```\n', 'utf8');

    await assert.rejects(
      renderDesignPage({ sourcePath, outputPath }),
      /immediately preceding.*diagram/i,
    );
  });
});

test('requires and consumes accessible labels for blockquoted Mermaid fences', async () => {
  await withTemporaryDirectory(async (directory) => {
    const labeledSourcePath = join(directory, 'blockquoted.md');
    const unlabeledSourcePath = join(directory, 'blockquoted-missing-label.md');
    const outputPath = join(directory, 'output.html');
    await writeFile(
      labeledSourcePath,
      '> <!-- diagram: 인용된 동기화 흐름 -->\n> ```mermaid\n> flowchart LR\n>   A --> B\n> ```\n',
      'utf8',
    );
    await writeFile(
      unlabeledSourcePath,
      '> ```mermaid\n> flowchart LR\n>   A --> B\n> ```\n',
      'utf8',
    );

    await renderDesignPage({ sourcePath: labeledSourcePath, outputPath });
    const html = await readFile(outputPath, 'utf8');

    assert.match(html, /aria-label="다이어그램: 인용된 동기화 흐름"/);
    assert.doesNotMatch(html, /&lt;!-- diagram:/);
    await assert.rejects(
      renderDesignPage({ sourcePath: unlabeledSourcePath, outputPath }),
      /immediately preceding.*diagram/i,
    );
  });
});

test('escapes configurable resource paths in HTML attributes', async () => {
  await withTemporaryDirectory(async (directory) => {
    const sourcePath = join(directory, 'design.md');
    const outputPath = join(directory, 'output.html');
    await writeFile(sourcePath, '# 안전한 경로\n', 'utf8');

    await renderDesignPage({
      sourcePath,
      outputPath,
      stylesheetHref: './styles" onload="alert(1)',
      scriptSrc: './page" onerror="alert(1)',
      sourceHref: './design" onclick="alert(1)',
    });

    const html = await readFile(outputPath, 'utf8');
    assert.doesNotMatch(html, /" on(?:load|error|click)=/);
    assert.match(html, /&quot; onload=&quot;alert\(1\)/);
    assert.match(html, /&quot; onerror=&quot;alert\(1\)/);
    assert.match(html, /&quot; onclick=&quot;alert\(1\)/);
  });
});

test('preserves local relative resource paths', async () => {
  await withTemporaryDirectory(async (directory) => {
    const sourcePath = join(directory, 'design.md');
    await writeFile(sourcePath, '# 상대 경로\n', 'utf8');

    for (const [index, stylesheetHref] of [
      './styles.css',
      'styles.css',
      'assets/themes/styles.css',
    ].entries()) {
      const outputPath = join(directory, `output-${index}.html`);
      await renderDesignPage({ sourcePath, outputPath, stylesheetHref });
      const html = await readFile(outputPath, 'utf8');
      assert.ok(html.includes(`href="${stylesheetHref}"`));
    }
  });
});

test('rejects resource paths that browsers can resolve outside the document surface', async (t) => {
  const unsafePaths = [
    ['leading whitespace', ' https://example.invalid/a.css'],
    ['trailing whitespace', './styles.css '],
    ['control whitespace', './sty\nles.css'],
    ['absolute URL', 'https://example.invalid/a.css'],
    ['scheme-relative URL', '//example.invalid/a.css'],
    ['root-relative URL', '/a.css'],
    ['backslash path', String.raw`assets\styles.css`],
    ['UNC path', String.raw`\\example.invalid\a.css`],
    ['Windows drive path with backslashes', String.raw`C:\assets\a.css`],
    ['Windows drive path with slashes', 'C:/assets/a.css'],
    ['parent traversal', '../a.css'],
    ['encoded parent traversal', '%2e%2e/a.css'],
  ];

  await withTemporaryDirectory(async (directory) => {
    const sourcePath = join(directory, 'design.md');
    await writeFile(sourcePath, '# 안전한 경로\n', 'utf8');

    for (const [index, [description, stylesheetHref]] of unsafePaths.entries()) {
      await t.test(description, async () => {
        await assert.rejects(
          renderDesignPage({
            sourcePath,
            outputPath: join(directory, `unsafe-${index}.html`),
            stylesheetHref,
          }),
          /stylesheetHref must be a relative path/,
        );
      });
    }
  });
});

test('preserves an existing output and removes its temporary file when publication fails', async () => {
  await withTemporaryDirectory(async (directory) => {
    const sourcePath = join(directory, 'design.md');
    const outputPath = join(directory, 'output.html');
    const originalOutput = Buffer.from([0x00, 0x59, 0x6f, 0x6e, 0x61, 0xff]);
    let temporaryPath;
    await writeFile(sourcePath, '# 원자적 게시\n', 'utf8');
    await writeFile(outputPath, originalOutput);

    await assert.rejects(
      renderDesignPage(
        { sourcePath, outputPath },
        {
          renameFile: async (from, to) => {
            temporaryPath = from;
            assert.equal(to, outputPath);
            await stat(from);
            throw new Error('deterministic publication failure');
          },
        },
      ),
      /deterministic publication failure/,
    );

    assert.deepEqual(await readFile(outputPath), originalOutput);
    assert.equal(dirname(temporaryPath), directory);
    assert.match(basename(temporaryPath), /^\.output\.html\.[^.]+\.tmp$/);
    await assert.rejects(stat(temporaryPath), { code: 'ENOENT' });
  });
});
