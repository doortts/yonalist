const MERMAID_ESM_URL = 'https://cdn.jsdelivr.net/npm/mermaid@11.12.1/dist/mermaid.esm.min.mjs';

function assignMissingHeadingIds(headings) {
  const usedIds = new Set([...document.querySelectorAll('[id]')].map((element) => element.id));

  headings.forEach((heading, index) => {
    if (heading.id) return;

    const baseId = `section-client-${String(index + 1).padStart(2, '0')}`;
    let id = baseId;
    let suffix = 2;
    while (usedIds.has(id)) id = `${baseId}-${suffix++}`;
    heading.id = id;
    usedIds.add(id);
  });
}

function buildTableOfContents(headings) {
  const tableOfContents = document.querySelector('#table-of-contents');
  if (!tableOfContents || headings.length === 0) return [];

  const title = document.createElement('p');
  title.textContent = '목차';
  const list = document.createElement('ol');
  list.className = 'toc-list';
  const links = [];
  let currentSection;

  for (const heading of headings) {
    const item = document.createElement('li');
    const link = document.createElement('a');
    link.href = `#${heading.id}`;
    link.textContent = heading.textContent;
    item.append(link);
    links.push({ heading, link });

    if (heading.tagName === 'H2') {
      list.append(item);
      currentSection = item;
    } else if (currentSection) {
      let nestedList = currentSection.querySelector(':scope > .toc-list');
      if (!nestedList) {
        nestedList = document.createElement('ol');
        nestedList.className = 'toc-list';
        currentSection.append(nestedList);
      }
      nestedList.append(item);
    } else {
      list.append(item);
    }
  }

  tableOfContents.replaceChildren(title, list);
  return links;
}

function highlightActiveSection(entries) {
  if (!('IntersectionObserver' in window) || entries.length === 0) return;

  const setActive = (heading) => {
    for (const entry of entries) {
      const isCurrent = entry.heading === heading;
      entry.link.classList.toggle('is-active', isCurrent);
      if (isCurrent) entry.link.setAttribute('aria-current', 'location');
      else entry.link.removeAttribute('aria-current');
    }
  };

  const observer = new IntersectionObserver((observations) => {
    const visible = observations
      .filter((observation) => observation.isIntersecting)
      .sort((left, right) => left.boundingClientRect.top - right.boundingClientRect.top);
    if (visible[0]) setActive(visible[0].target);
  }, { rootMargin: '-15% 0px -70% 0px', threshold: 0 });

  entries.forEach(({ heading }) => observer.observe(heading));
}

async function renderMermaidDiagrams() {
  const status = document.querySelector('#diagram-status');
  const diagrams = [...document.querySelectorAll('pre.mermaid')];
  if (!status || diagrams.length === 0) return;
  const darkMode = window.matchMedia?.('(prefers-color-scheme: dark)').matches;
  const themeVariables = darkMode
    ? {
      primaryColor: '#24344e',
      primaryTextColor: '#f4f7fb',
      primaryBorderColor: '#b8c3d6',
      lineColor: '#b8c3d6',
      secondaryColor: '#1b2a42',
      tertiaryColor: '#172033',
      fontFamily: 'system-ui, sans-serif',
    }
    : {
      primaryColor: '#eef3fa',
      primaryTextColor: '#172033',
      primaryBorderColor: '#5b667a',
      lineColor: '#5b667a',
      secondaryColor: '#f7f9fc',
      tertiaryColor: '#ffffff',
      fontFamily: 'system-ui, sans-serif',
    };

  const originals = diagrams.map((diagram) => ({
    diagram,
    attributes: [...diagram.attributes].map(({ name, value }) => [name, value]),
    html: diagram.innerHTML,
  }));

  try {
    const { default: mermaid } = await import(MERMAID_ESM_URL);
    mermaid.initialize({
      startOnLoad: false,
      theme: 'base',
      securityLevel: 'strict',
      themeVariables,
    });
    await mermaid.run({ nodes: diagrams });
    status.textContent = `다이어그램 ${diagrams.length}개를 렌더링했습니다.`;
  } catch {
    for (const original of originals) {
      original.diagram.replaceChildren();
      for (const attribute of [...original.diagram.attributes]) original.diagram.removeAttribute(attribute.name);
      for (const [name, value] of original.attributes) original.diagram.setAttribute(name, value);
      original.diagram.innerHTML = original.html;
    }
    status.classList.add('diagram-status--fallback');
    status.textContent = '다이어그램을 불러오지 못했습니다. 아래 Mermaid 원본을 확인하세요.';
  }
}

const headings = [...document.querySelectorAll('main h2, main h3')];
assignMissingHeadingIds(headings);
highlightActiveSection(buildTableOfContents(headings));
void renderMermaidDiagrams();
