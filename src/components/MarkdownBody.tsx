import { X } from "lucide-react";
import { Dialog } from "@base-ui/react/dialog";
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
import "./ui/lightbox.css";

interface MarkdownBodyProps {
  body: string;
  variant?: MarkdownStyle;
}

type RenderedMarkdown = { __html: string };
type RenderedMarkdownState = {
  body: string;
  complete: boolean;
  rendered: RenderedMarkdown;
};

const emptyMarkdown: RenderedMarkdown = { __html: "" };
const renderedMarkdownCache = new LruCache<RenderedMarkdown>(
  200,
  (body, rendered) => estimateTextBytes(body) + estimateTextBytes(rendered.__html)
);
const WARM_RENDER_BATCH_SIZE = 4;
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
  let renderedCount = 0;
  for (const body of missingBodies) {
    // Yield to the event loop between batches so a large prefetched
    // conversation cannot block the main thread in one synchronous burst.
    if (renderedCount > 0 && renderedCount % WARM_RENDER_BATCH_SIZE === 0) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    // Re-check inside the loop: a concurrent warm may have filled the entry
    // during one of the yields above.
    if (!renderedMarkdownCache.has(body)) {
      renderedMarkdownCache.set(body, renderMarkdown(body));
      renderedCount += 1;
    }
  }
}

export function clearMarkdownRenderCache() {
  renderedMarkdownCache.clear();
}

export function getMarkdownRenderCacheStats(): CacheSizeStats {
  return renderedMarkdownCache.stats();
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
  const lightboxTriggerRef = useRef<HTMLImageElement | null>(null);
  const [lightboxSrc, setLightboxSrc] = useState<string | null>(null);
  const cachedMarkdown = useMemo(
    () => renderedMarkdownCache.get(body),
    [body]
  );
  const fallbackMarkdown = cachedMarkdown ?? emptyMarkdown;
  const cachedComplete = body.trim().length === 0 || cachedMarkdown !== undefined;
  const [renderedMarkdownState, setRenderedMarkdownState] =
    useState<RenderedMarkdownState>(() => ({
      body,
      complete: cachedComplete,
      rendered: fallbackMarkdown
    }));
  const currentBodyComplete =
    renderedMarkdownState.body === body
      ? renderedMarkdownState.complete
      : cachedComplete;
  const renderedMarkdown =
    renderedMarkdownState.body === body
      ? renderedMarkdownState.rendered
      : fallbackMarkdown;

  useEffect(() => {
    const cached = renderedMarkdownCache.get(body);
    if (cached || body.trim().length === 0) {
      setRenderedMarkdownState((current) =>
        current.body === body &&
        current.complete &&
        current.rendered === (cached ?? emptyMarkdown)
          ? current
          : { body, complete: true, rendered: cached ?? emptyMarkdown }
      );
      return;
    }

    let cancelled = false;
    setRenderedMarkdownState({ body, complete: false, rendered: emptyMarkdown });
    void loadMarkdownRenderer().then(({ renderMarkdown }) => {
      if (cancelled) {
        return;
      }
      const rendered = renderMarkdown(body);
      renderedMarkdownCache.set(body, rendered);
      setRenderedMarkdownState({ body, complete: true, rendered });
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
      const image = target as HTMLImageElement;
      // Remember the body image so Base UI can return focus to it on close.
      // A plain <img> is not focusable, so make it programmatically focusable.
      if (!image.hasAttribute("tabindex")) {
        image.tabIndex = -1;
      }
      lightboxTriggerRef.current = image;
      setLightboxSrc(image.src);
    }
  }

  return (
    <>
      <div
        ref={containerRef}
        className={`markdown-body markdown-body-${styleVariant}`}
        data-markdown-body="true"
        data-markdown-rendered={currentBodyComplete ? "true" : "false"}
        onClick={handleClick}
        dangerouslySetInnerHTML={renderedMarkdown}
      />
      <Dialog.Root
        open={!!lightboxSrc}
        onOpenChange={(nextOpen) => {
          if (!nextOpen) {
            setLightboxSrc(null);
          }
        }}
      >
        <Dialog.Portal>
          <Dialog.Backdrop className="image-lightbox-backdrop" />
          <Dialog.Popup
            className="image-lightbox"
            aria-label="Image viewer"
            finalFocus={lightboxTriggerRef}
            onClick={() => setLightboxSrc(null)}
          >
            <Dialog.Close
              className="icon-button image-lightbox-close"
              aria-label="Close image viewer"
            >
              <X size={18} />
            </Dialog.Close>
            {lightboxSrc && (
              <img
                className="image-lightbox-image"
                src={lightboxSrc}
                alt="Original size"
                onClick={(event) => event.stopPropagation()}
              />
            )}
          </Dialog.Popup>
        </Dialog.Portal>
      </Dialog.Root>
    </>
  );
}
