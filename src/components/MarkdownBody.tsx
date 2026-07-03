import { X } from "lucide-react";
import { type MouseEvent, useContext, useEffect, useRef, useState } from "react";
import { GithubConnectionContext } from "../GithubConnectionContext";
import { renderMarkdown } from "../markdownRender";
import {
  needsAuthenticatedFetch,
  resolveAuthenticatedImage
} from "../services/imageProxy";

interface MarkdownBodyProps {
  body: string;
}

/**
 * Sanitized markdown content. Images are constrained to the pane width and
 * clicking one opens the original at its natural size in a lightbox.
 * Attachment images on the signed-in GitHub host are refetched with the
 * token, since the webview's plain <img> requests would 401 on GHE.
 */
export function MarkdownBody({ body }: MarkdownBodyProps) {
  const connection = useContext(GithubConnectionContext);
  const containerRef = useRef<HTMLDivElement>(null);
  const [lightboxSrc, setLightboxSrc] = useState<string | null>(null);

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
  }, [body, connection]);

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
    if (target.tagName === "IMG") {
      setLightboxSrc((target as HTMLImageElement).src);
    }
  }

  return (
    <>
      <div
        ref={containerRef}
        className="markdown-body"
        onClick={handleClick}
        dangerouslySetInnerHTML={renderMarkdown(body)}
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
