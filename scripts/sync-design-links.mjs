import { readFile, stat } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { JSDOM } from 'jsdom';

export async function validateLocalReferences(pagePath) {
  const pageUrl = pathToFileURL(pagePath);
  const html = await readFile(pageUrl, 'utf8');
  const document = new JSDOM(html).window.document;
  const resourceAttributes = [...document.querySelectorAll('[href], [src]')]
    .flatMap((element) => ['href', 'src']
      .filter((attribute) => element.hasAttribute(attribute))
      .map((attribute) => ({ attribute, value: element.getAttribute(attribute) })));

  for (const { attribute, value } of resourceAttributes) {
    if (!value) throw new Error(`${attribute} must not be empty`);
    const targetUrl = new URL(value, pageUrl);
    if (targetUrl.protocol !== 'file:') continue;

    const targetPath = fileURLToPath(targetUrl);
    try {
      await stat(targetPath);
    } catch {
      throw new Error(`${attribute} target must exist: ${value}`);
    }

    if (!targetUrl.hash) continue;
    const targetHtml = await readFile(targetPath, 'utf8');
    const targetDocument = new JSDOM(targetHtml).window.document;
    let targetId;
    try {
      targetId = decodeURIComponent(targetUrl.hash.slice(1));
    } catch {
      throw new Error(`${attribute} fragment must be percent-decodable: ${value}`);
    }
    if (!targetDocument.getElementById(targetId)) {
      throw new Error(`${attribute} fragment must exist: ${value}`);
    }
  }
}
