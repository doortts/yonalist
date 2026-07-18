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
  if (entries.length === 0) return;

  let hashSelectionLocked = false;
  let activeHeading;

  const setActive = (heading) => {
    activeHeading = heading;
    for (const entry of entries) {
      const isCurrent = entry.heading === heading;
      entry.link.classList.toggle('is-active', isCurrent);
      if (isCurrent) entry.link.setAttribute('aria-current', 'location');
      else entry.link.removeAttribute('aria-current');
    }
  };

  const selectHashTarget = () => {
    const selected = entries.find(({ link }) => link.hash === window.location.hash);
    if (!selected) {
      hashSelectionLocked = false;
      return;
    }

    setActive(selected.heading);
    hashSelectionLocked = true;
  };

  for (const entry of entries) {
    entry.link.addEventListener('click', (event) => {
      const modifiedClick = event.metaKey || event.ctrlKey || event.shiftKey || event.altKey;
      if (event.defaultPrevented || event.button !== 0 || modifiedClick) {
        return;
      }
      setActive(entry.heading);
      hashSelectionLocked = true;
    });
  }

  window.addEventListener('hashchange', selectHashTarget);

  const unlockHashSelection = () => {
    hashSelectionLocked = false;
  };
  for (const eventName of ['wheel', 'touchstart', 'pointerdown']) {
    window.addEventListener(eventName, unlockHashSelection, { passive: true });
  }
  window.addEventListener('keydown', (event) => {
    if (['ArrowDown', 'ArrowUp', 'End', 'Home', 'PageDown', 'PageUp', ' '].includes(event.key)) {
      unlockHashSelection();
    }
  });

  selectHashTarget();

  if (!('IntersectionObserver' in window)) return;

  const observer = new window.IntersectionObserver((observations) => {
    const visible = observations
      .filter((observation) => observation.isIntersecting)
      .sort((left, right) => left.boundingClientRect.top - right.boundingClientRect.top);
    if (hashSelectionLocked && activeHeading && !visible.some(({ target }) => target === activeHeading)) return;
    if (visible[0]) setActive(visible[0].target);
  }, { rootMargin: '-15% 0px -70% 0px', threshold: 0 });

  entries.forEach(({ heading }) => observer.observe(heading));
}

export async function renderMermaidDiagrams({
  loadMermaid = () => import(/* @vite-ignore */ MERMAID_ESM_URL),
} = {}) {
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
    role: diagram.getAttribute('role'),
    label: diagram.getAttribute('aria-label'),
    describedBy: diagram.getAttribute('aria-describedby'),
  }));

  const restoreAccessibility = (original) => {
    const { diagram, role, label, describedBy } = original;
    if (role) diagram.setAttribute('role', role);
    if (label) diagram.setAttribute('aria-label', label);
    if (describedBy) diagram.setAttribute('aria-describedby', describedBy);
    const figure = diagram.closest('figure.diagram');
    const caption = describedBy ? document.getElementById(describedBy) : null;
    if (figure && caption && figure.contains(caption)) {
      figure.setAttribute('aria-labelledby', describedBy);
    }
    diagram.querySelector('svg')?.setAttribute('aria-hidden', 'true');
  };

  try {
    const { default: mermaid } = await loadMermaid();
    mermaid.initialize({
      startOnLoad: false,
      theme: 'neutral',
      securityLevel: 'strict',
      themeVariables,
    });
    await mermaid.run({ nodes: diagrams });
    originals.forEach(restoreAccessibility);
    status.classList.remove('diagram-status--fallback');
    status.textContent = `다이어그램 ${diagrams.length}개를 렌더링했습니다.`;
  } catch {
    for (const original of originals) {
      original.diagram.replaceChildren();
      for (const attribute of [...original.diagram.attributes]) original.diagram.removeAttribute(attribute.name);
      for (const [name, value] of original.attributes) original.diagram.setAttribute(name, value);
      original.diagram.innerHTML = original.html;
      restoreAccessibility(original);
    }
    status.classList.add('diagram-status--fallback');
    status.textContent = '다이어그램을 불러오지 못했습니다. 아래 Mermaid 원본을 확인하세요.';
  }
}

if (typeof document !== 'undefined') {
  const headings = [...document.querySelectorAll('main h2, main h3')];
  assignMissingHeadingIds(headings);
  highlightActiveSection(buildTableOfContents(headings));
  void renderMermaidDiagrams();
}
