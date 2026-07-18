import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
    assert.match(html, /<pre class="mermaid"/);
    assert.match(html, /aria-label="다이어그램:/);
    assert.match(html, /href="\.\/fixture\.css"/);
    assert.match(html, /src="\.\/fixture\.js"/);
    assert.match(html, /href="\.\/source\.md"/);
    assert.doesNotMatch(html, /\/Users\//);
    assert.equal(html, secondHtml);
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
