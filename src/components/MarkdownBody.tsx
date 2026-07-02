import { X } from "lucide-react";
import { type MouseEvent, useEffect, useState } from "react";
import { renderMarkdown } from "../markdownRender";

interface MarkdownBodyProps {
  body: string;
}

/**
 * Sanitized markdown content. Images are constrained to the pane width and
 * clicking one opens the original at its natural size in a lightbox.
 */
export function MarkdownBody({ body }: MarkdownBodyProps) {
  const [lightboxSrc, setLightboxSrc] = useState<string | null>(null);

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
