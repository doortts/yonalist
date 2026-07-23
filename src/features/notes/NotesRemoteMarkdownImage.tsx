import { useEffect, useState } from "react";
import { NotesResizableImageFrame } from "./NotesResizableImageFrame";

export interface NotesRemoteMarkdownImageProps {
  readonly nodeId: string;
  readonly alt: string;
  readonly url: string;
  readonly persistedWidth: number | null;
  readonly disabled?: boolean;
  readonly onDisplayWidthCommit: (width: number) => void;
  readonly onEditRequest: () => void;
}

interface RemoteImageState {
  readonly status: "loading" | "ready" | "error";
  readonly intrinsicWidth: number | null;
  readonly intrinsicHeight: number | null;
}

function remoteImageAccessibleLabel(alt: string, url: string): string {
  const normalizedAlt = alt.trim();
  if (normalizedAlt) return normalizedAlt;
  try {
    return new URL(url).hostname || "Image";
  } catch {
    return "Image";
  }
}

export function NotesRemoteMarkdownImage({
  nodeId,
  alt,
  url,
  persistedWidth,
  disabled = false,
  onDisplayWidthCommit,
  onEditRequest
}: NotesRemoteMarkdownImageProps) {
  const [state, setState] = useState<RemoteImageState>({
    status: "loading",
    intrinsicWidth: null,
    intrinsicHeight: null
  });
  const accessibleLabel = remoteImageAccessibleLabel(alt, url);

  useEffect(() => {
    setState({
      status: "loading",
      intrinsicWidth: null,
      intrinsicHeight: null
    });
  }, [url]);

  return (
    <NotesResizableImageFrame
      id={nodeId}
      accessibleLabel={accessibleLabel}
      sourceUrl={url}
      sourceStatus={state.status}
      intrinsicWidth={state.intrinsicWidth}
      intrinsicHeight={state.intrinsicHeight}
      persistedWidth={persistedWidth}
      disabled={disabled}
      sourceIdentity={url}
      onDisplayWidthCommit={onDisplayWidthCommit}
      onSourceLoad={(image) => {
        if (image.naturalWidth <= 0 || image.naturalHeight <= 0) {
          setState({
            status: "error",
            intrinsicWidth: null,
            intrinsicHeight: null
          });
          return;
        }
        setState({
          status: "ready",
          intrinsicWidth: image.naturalWidth,
          intrinsicHeight: image.naturalHeight
        });
      }}
      onSourceError={() =>
        setState({
          status: "error",
          intrinsicWidth: null,
          intrinsicHeight: null
        })
      }
      onDoubleClick={onEditRequest}
      errorContent={
        <span className="notes-remote-markdown-image-fallback">
          <span>{accessibleLabel}</span>
          {!disabled && (
            <button type="button" className="text-button" onClick={onEditRequest}>
              Edit Markdown
            </button>
          )}
        </span>
      }
    />
  );
}
