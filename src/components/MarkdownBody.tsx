import { X } from "lucide-react";
import {
  type MouseEvent,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState
} from "react";
import { GithubConnectionContext } from "../GithubConnectionContext";
import { MarkdownStyleContext } from "../MarkdownStyleContext";
import type { MarkdownStyle } from "../appSettings";
import {
  needsAuthenticatedFetch,
  resolveAuthenticatedImage
} from "../services/imageProxy";
import { openExternal } from "../services/browser";
import {
  estimateTextBytes,
  type CacheSizeStats
} from "../services/cacheStats";
import { LruCache } from "../services/lruCache";

interface MarkdownBodyProps {
  body: string;
  variant?: MarkdownStyle;
}

type RenderedMarkdown = { __html: string };

const emptyMarkdown: RenderedMarkdown = { __html: "" };
const renderedMarkdownCache = new LruCache<RenderedMarkdown>(200);
let rendererPromise: Promise<typeof import("../markdownRender")> | null = null;

function loadMarkdownRenderer() {
  rendererPromise ??= import("../markdownRender");
  return rendererPromise;
}

export async function warmMarkdownBodies(bodies: string[]) {
  const missingBodies = bodies.filter(
    (body) => body && !renderedMarkdownCache.has(body)
  );
  if (missingBodies.length === 0) {
    return;
  }
  const { renderMarkdown } = await loadMarkdownRenderer();
  for (const body of missingBodies) {
    if (!renderedMarkdownCache.has(body)) {
      renderedMarkdownCache.set(body, renderMarkdown(body));
    }
  }
}

export function clearMarkdownRenderCache() {
  renderedMarkdownCache.clear();
}

export function getMarkdownRenderCacheStats(): CacheSizeStats {
  return renderedMarkdownCache.entries().reduce<CacheSizeStats>(
    (stats, [body, rendered]) => ({
      entries: stats.entries + 1,
      bytes:
        stats.bytes +
        estimateTextBytes(body) +
        estimateTextBytes(rendered.__html)
    }),
    { entries: 0, bytes: 0 }
  );
}

/**
 * Sanitized markdown content. Images are constrained to the pane width and
 * clicking one opens the original at its natural size in a lightbox.
 * Attachment images on the signed-in GitHub host are refetched with the
 * token, since the webview's plain <img> requests would 401 on GHE.
 */
export function MarkdownBody({ body, variant }: MarkdownBodyProps) {
  const connection = useContext(GithubConnectionContext);
  const defaultVariant = useContext(MarkdownStyleContext);
  const styleVariant = variant ?? defaultVariant;
  const containerRef = useRef<HTMLDivElement>(null);
  const [lightboxSrc, setLightboxSrc] = useState<string | null>(null);
  const cachedMarkdown = useMemo(
    () => renderedMarkdownCache.get(body) ?? emptyMarkdown,
    [body]
  );
  const [renderedMarkdown, setRenderedMarkdown] =
    useState<RenderedMarkdown>(cachedMarkdown);

  useEffect(() => {
    const cached = renderedMarkdownCache.get(body);
    if (cached) {
      setRenderedMarkdown(cached);
      return;
    }

    let cancelled = false;
    setRenderedMarkdown(emptyMarkdown);
    void loadMarkdownRenderer().then(({ renderMarkdown }) => {
      if (cancelled) {
        return;
      }
      const rendered = renderMarkdown(body);
      renderedMarkdownCache.set(body, rendered);
      setRenderedMarkdown(rendered);
    });
    return () => {
      cancelled = true;
    };
  }, [body]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) {
      return;
    }
    let cancelled = false;
    for (const image of container.querySelectorAll("img")) {
      const src = image.getAttribute("src") ?? "";
      if (!needsAuthenticatedFetch(src, connection)) {
        continue;
      }
      void resolveAuthenticatedImage(src, connection).then((resolved) => {
        if (!cancelled && resolved) {
          image.src = resolved;
        }
      });
    }
    return () => {
      cancelled = true;
    };
  }, [renderedMarkdown, connection]);

  useEffect(() => {
    if (!lightboxSrc) {
      return;
    }
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        setLightboxSrc(null);
      }
    }
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [lightboxSrc]);

  function handleClick(event: MouseEvent<HTMLDivElement>) {
    const target = event.target as HTMLElement;
    const link = target.closest<HTMLAnchorElement>("a[href]");
    if (link) {
      const href = link.href;
      if (href.startsWith("http://") || href.startsWith("https://")) {
        event.preventDefault();
        event.stopPropagation();
        void openExternal(href);
        return;
      }
    }
    if (target.tagName === "IMG") {
      setLightboxSrc((target as HTMLImageElement).src);
    }
  }

  return (
    <>
      <div
        ref={containerRef}
        className={`markdown-body markdown-body-${styleVariant}`}
        onClick={handleClick}
        dangerouslySetInnerHTML={renderedMarkdown}
      />
      {lightboxSrc && (
        <div
          className="image-lightbox"
          role="dialog"
          aria-modal="true"
          aria-label="Image viewer"
          onClick={() => setLightboxSrc(null)}
        >
          <button
            type="button"
            className="icon-button image-lightbox-close"
            aria-label="Close image viewer"
            onClick={() => setLightboxSrc(null)}
          >
            <X size={18} />
          </button>
          <img
            className="image-lightbox-image"
            src={lightboxSrc}
            alt="Original size"
            onClick={(event) => event.stopPropagation()}
          />
        </div>
      )}
    </>
  );
}
