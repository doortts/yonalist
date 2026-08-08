import type * as monaco from "monaco-editor/esm/vs/editor/editor.api";

import type { ImageView } from "../../../../packages/contracts/generated/ImageView";
import type { ImageLease, ResidentImageIdentity } from "../imageResidency";
import {
  clampImageWidth,
  imageKeyboardResizeWidth,
  MIN_IMAGE_DISPLAY_WIDTH
} from "../imageResize";
import type { DecorationWindowRange } from "./decorationWindow";
import type { OutlineLineMetadata } from "./metadata";

export interface ImageZoneSize {
  readonly width: number;
  readonly height: number;
}

/** The part of `ImageResidency` a zone leases through. */
export interface ImageZoneResidency {
  subscribe(image: ResidentImageIdentity, listener: () => void): () => void;
  getSnapshot(image: ResidentImageIdentity): ImageLease;
  activate(image: ResidentImageIdentity): () => void;
}

export interface ImageZoneLightboxRequest {
  readonly nodeId: string;
  readonly sourceUrl: string;
  readonly originalName: string;
  readonly pixelWidth: number;
  readonly pixelHeight: number;
}

export interface ImageZonePort {
  readonly residency: ImageZoneResidency;
  /** Commits one released resize gesture; rejection restores the old width. */
  resize(nodeId: string, displayWidth: number): Promise<void>;
  openLightbox(request: ImageZoneLightboxRequest): void;
}

export interface ImageZoneSyncInput {
  readonly lines: readonly OutlineLineMetadata[];
  readonly images: ReadonlyMap<string, ImageView>;
  readonly window: DecorationWindowRange;
  readonly hidden: readonly monaco.Range[];
}

interface MutableViewZone extends monaco.editor.IViewZone {
  afterLineNumber: number;
  heightInPx: number;
}

interface ZoneEntry {
  readonly nodeId: string;
  readonly identity: ResidentImageIdentity;
  readonly frame: HTMLDivElement;
  readonly handle: HTMLDivElement;
  readonly picture: HTMLImageElement;
  readonly placeholder: HTMLDivElement;
  readonly zone: MutableViewZone;
  release: () => void;
  unsubscribe: () => void;
  zoneId: string;
  image: ImageView;
  sourceUrl: string | null;
  pendingWidth: number | null;
}

/**
 * Contract I3: an image row is as wide as the width the node stored, never
 * wider than the original pixels (small images are never blown up) and never
 * wider than the editor content area. The height follows the original ratio.
 */
export function imageZoneSize(
  image: ImageView,
  contentWidth: number
): ImageZoneSize {
  const intrinsic = Math.max(0, Math.floor(image.pixelWidth));
  const available = Math.floor(contentWidth) > 0
    ? Math.floor(contentWidth)
    : intrinsic;
  const stored = image.displayWidth > 0 ? image.displayWidth : intrinsic;
  const width = Math.max(0, Math.min(stored, intrinsic, available));
  const ratio = image.pixelHeight / image.pixelWidth;
  return {
    width,
    height: Number.isFinite(ratio) ? Math.round(width * ratio) : 0
  };
}

/**
 * The image bodies of one pane. A caption line is an ordinary model line; the
 * picture above it is a Monaco view zone that lives exactly as long as the
 * caption stays inside the decoration window and outside every hidden area.
 */
export class PaneImageZones {
  private readonly entries = new Map<string, ZoneEntry>();
  private lastSync: ImageZoneSyncInput | null = null;
  private disposed = false;

  constructor(private readonly input: {
    readonly editor: monaco.editor.ICodeEditor;
    readonly port: ImageZonePort;
  }) {}

  get size(): number {
    return this.entries.size;
  }

  sync(input: ImageZoneSyncInput): void {
    if (this.disposed) return;
    this.lastSync = input;
    const contentWidth = this.input.editor.getLayoutInfo().contentWidth;
    const wanted = new Map<string, {
      readonly lineNumber: number;
      readonly image: ImageView;
      readonly depth: number;
    }>();
    for (
      let lineNumber = Math.max(1, input.window[0]);
      lineNumber <= input.window[1];
      lineNumber += 1
    ) {
      const line = input.lines[lineNumber - 1];
      if (line?.kind !== "image" || isLineHidden(input.hidden, lineNumber)) {
        continue;
      }
      const image = input.images.get(line.nodeId);
      if (image) {
        wanted.set(line.nodeId, { lineNumber, image, depth: line.depth });
      }
    }
    this.input.editor.changeViewZones((accessor) => {
      for (const [nodeId, entry] of [...this.entries]) {
        const target = wanted.get(nodeId);
        // A replaced image is a different picture under the same node, so the
        // zone starts over rather than keeping the retired lease.
        if (target && target.image.contentHash === entry.identity.contentHash) {
          continue;
        }
        accessor.removeZone(entry.zoneId);
        this.retire(entry);
        this.entries.delete(nodeId);
      }
      for (const [nodeId, target] of wanted) {
        const existing = this.entries.get(nodeId);
        if (existing) {
          existing.image = target.image;
          if (layoutEntry(existing, target, contentWidth)) {
            accessor.layoutZone(existing.zoneId);
          }
          continue;
        }
        const entry = this.createEntry(nodeId, target.image);
        layoutEntry(entry, target, contentWidth);
        entry.zoneId = accessor.addZone(entry.zone);
        this.entries.set(nodeId, entry);
      }
    });
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.input.editor.changeViewZones((accessor) => {
      for (const entry of this.entries.values()) {
        accessor.removeZone(entry.zoneId);
        this.retire(entry);
      }
    });
    this.entries.clear();
    this.lastSync = null;
  }

  private createEntry(nodeId: string, image: ImageView): ZoneEntry {
    const domNode = document.createElement("div");
    domNode.className = "yonalist-outline-image-zone";
    const frame = document.createElement("div");
    frame.className = "yonalist-outline-image-frame";
    const picture = document.createElement("img");
    picture.className = "yonalist-outline-image";
    picture.draggable = false;
    picture.alt = image.originalName;
    const placeholder = document.createElement("div");
    placeholder.className = "yonalist-outline-image-placeholder";
    const handle = document.createElement("div");
    handle.className = "yonalist-outline-image-resize";
    handle.setAttribute("role", "separator");
    handle.setAttribute("aria-orientation", "vertical");
    handle.setAttribute("aria-label", `Resize ${image.originalName}`);
    handle.setAttribute("aria-valuemin", String(MIN_IMAGE_DISPLAY_WIDTH));
    handle.tabIndex = 0;
    frame.append(picture, placeholder, handle);
    domNode.append(frame);
    const identity: ResidentImageIdentity = {
      nodeId,
      contentHash: image.contentHash,
      mimeType: image.mimeType
    };
    const entry: ZoneEntry = {
      nodeId,
      identity,
      frame,
      handle,
      picture,
      placeholder,
      zone: { afterLineNumber: 0, heightInPx: 0, domNode },
      release: () => undefined,
      unsubscribe: () => undefined,
      zoneId: "",
      image,
      sourceUrl: null,
      pendingWidth: null
    };
    picture.addEventListener("click", () => {
      if (!entry.sourceUrl) return;
      this.input.port.openLightbox({
        nodeId,
        sourceUrl: entry.sourceUrl,
        originalName: entry.image.originalName,
        pixelWidth: entry.image.pixelWidth,
        pixelHeight: entry.image.pixelHeight
      });
    });
    this.bindResize(entry);
    entry.unsubscribe = this.input.port.residency.subscribe(
      identity,
      () => this.paint(entry)
    );
    entry.release = this.input.port.residency.activate(identity);
    this.paint(entry);
    return entry;
  }

  /**
   * Width only, ratio kept, one commit per gesture (contract I4). The arrow
   * keys move the same width the pointer does, in the steps the React rows
   * use, and commit when the gesture ends rather than per keypress.
   */
  private bindResize(entry: ZoneEntry): void {
    const handle = entry.handle;
    let drag: {
      readonly pointerId: number;
      readonly startX: number;
      readonly startWidth: number;
      width: number;
    } | null = null;
    let keyboardStart: number | null = null;
    const finishKeyboard = (): void => {
      const start = keyboardStart;
      keyboardStart = null;
      const width = entry.pendingWidth;
      if (start === null || width === null || width === start) return;
      this.commit(entry, width);
    };
    handle.addEventListener("keydown", (event) => {
      if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
      event.preventDefault();
      event.stopPropagation();
      const width = this.currentWidth(entry);
      keyboardStart ??= width;
      entry.pendingWidth = imageKeyboardResizeWidth(
        width,
        event.key,
        event.shiftKey,
        this.maximumWidth(entry)
      );
      this.applyPendingWidth(entry);
    });
    handle.addEventListener("keyup", (event) => {
      if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
      finishKeyboard();
    });
    handle.addEventListener("blur", finishKeyboard);
    handle.addEventListener("pointerdown", (event) => {
      if (event.button !== 0) return;
      event.preventDefault();
      event.stopPropagation();
      const width = this.currentWidth(entry);
      drag = {
        pointerId: event.pointerId,
        startX: event.clientX,
        startWidth: width,
        width
      };
      handle.setPointerCapture?.(event.pointerId);
    });
    handle.addEventListener("pointermove", (event) => {
      if (drag?.pointerId !== event.pointerId) return;
      event.preventDefault();
      drag.width = clampImageWidth(
        drag.startWidth + event.clientX - drag.startX,
        this.maximumWidth(entry)
      );
      entry.pendingWidth = drag.width;
      this.applyPendingWidth(entry);
    });
    handle.addEventListener("pointerup", (event) => {
      if (drag?.pointerId !== event.pointerId) return;
      const width = drag.width;
      drag = null;
      handle.releasePointerCapture?.(event.pointerId);
      this.commit(entry, width);
    });
    handle.addEventListener("pointercancel", (event) => {
      if (drag?.pointerId !== event.pointerId) return;
      drag = null;
      entry.pendingWidth = null;
      this.resync();
    });
  }

  private currentWidth(entry: ZoneEntry): number {
    return entry.pendingWidth ?? imageZoneSize(
      entry.image,
      this.input.editor.getLayoutInfo().contentWidth
    ).width;
  }

  private maximumWidth(entry: ZoneEntry): number {
    return zoneMaximumWidth(
      entry.image,
      this.input.editor.getLayoutInfo().contentWidth
    );
  }

  private applyPendingWidth(entry: ZoneEntry): void {
    const width = entry.pendingWidth;
    if (width === null) return;
    const ratio = entry.image.pixelHeight / entry.image.pixelWidth;
    applySize(entry, width, Number.isFinite(ratio) ? Math.round(width * ratio) : 0);
    this.input.editor.changeViewZones(
      (accessor) => accessor.layoutZone(entry.zoneId)
    );
  }

  private commit(entry: ZoneEntry, width: number): void {
    entry.pendingWidth = width;
    this.applyPendingWidth(entry);
    void this.input.port.resize(entry.nodeId, width)
      .catch(() => undefined)
      .then(() => {
        entry.pendingWidth = null;
        this.resync();
      });
  }

  private resync(): void {
    if (this.lastSync && !this.disposed) this.sync(this.lastSync);
  }

  private paint(entry: ZoneEntry): void {
    const lease = this.input.port.residency.getSnapshot(entry.identity);
    entry.sourceUrl = lease.status === "ready" ? lease.url : null;
    if (lease.status === "ready") {
      entry.picture.src = lease.url;
    } else {
      entry.picture.removeAttribute("src");
    }
    entry.picture.hidden = lease.status !== "ready";
    entry.placeholder.hidden = lease.status === "ready";
    entry.placeholder.setAttribute(
      "role",
      lease.status === "error" ? "alert" : "status"
    );
    entry.placeholder.textContent = lease.status === "error"
      ? "Image unavailable"
      : "Loading image";
  }

  private retire(entry: ZoneEntry): void {
    entry.unsubscribe();
    entry.release();
    entry.sourceUrl = null;
  }
}

function layoutEntry(
  entry: ZoneEntry,
  target: {
    readonly lineNumber: number;
    readonly image: ImageView;
    readonly depth: number;
  },
  contentWidth: number
): boolean {
  const size = entry.pendingWidth === null
    ? imageZoneSize(target.image, contentWidth)
    : imageZoneSize(
        { ...target.image, displayWidth: entry.pendingWidth },
        contentWidth
      );
  entry.handle.setAttribute(
    "aria-valuemax",
    String(zoneMaximumWidth(target.image, contentWidth))
  );
  const afterLineNumber = target.lineNumber - 1;
  const changed = entry.zone.afterLineNumber !== afterLineNumber ||
    entry.zone.heightInPx !== size.height;
  entry.zone.afterLineNumber = afterLineNumber;
  entry.zone.domNode.style.setProperty(
    "--yonalist-outline-depth",
    String(target.depth)
  );
  applySize(entry, size.width, size.height);
  return changed;
}

function applySize(entry: ZoneEntry, width: number, height: number): void {
  entry.zone.heightInPx = height;
  entry.frame.style.width = `${width}px`;
  entry.frame.style.height = `${height}px`;
  entry.handle.setAttribute("aria-valuenow", String(width));
}

/** The widest a picture may be drawn: its own pixels, or the content area. */
function zoneMaximumWidth(image: ImageView, contentWidth: number): number {
  return Math.min(
    image.pixelWidth,
    Math.floor(contentWidth) || image.pixelWidth
  );
}

/** Hidden ranges arrive sorted, so the first range past the line settles it. */
function isLineHidden(
  hidden: readonly monaco.Range[],
  lineNumber: number
): boolean {
  for (const range of hidden) {
    if (lineNumber < range.startLineNumber) return false;
    if (lineNumber <= range.endLineNumber) return true;
  }
  return false;
}
