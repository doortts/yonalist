import * as monaco from "monaco-editor/esm/vs/editor/editor.api";

import { setEditorHiddenAreas } from "./internalAdapter";
import type { OutlineMetadataSnapshot } from "./metadata";
import type { MonacoOutlinePaneBinding } from "./plugin";
import type { MonacoOutlineSession } from "./session";

export interface OutlinePaneNavigation {
  zoomSamePane(nodeId: string): void;
  openSecondary(nodeId: string): void;
}

export interface MonacoOutlinePaneDiagnostics {
  readonly disposed: boolean;
  readonly savedViewStates: number;
  readonly liveSubscriptions: number;
}

export class MonacoOutlinePaneAdapter implements MonacoOutlinePaneBinding {
  private readonly viewStates =
    new Map<string, monaco.editor.ICodeEditorViewState | null>();
  private readonly unsubscribeMetadata: () => void;
  private readonly hiddenAreaSource: string;
  private zoomRootId: string | null;
  private showCompleted: boolean;
  private disposed = false;

  constructor(private readonly input: {
    readonly paneId: "primary" | "secondary";
    readonly editor: monaco.editor.IStandaloneCodeEditor;
    readonly session: MonacoOutlineSession;
    readonly zoomRootId: string | null;
    readonly showCompleted: boolean;
    readonly navigation: OutlinePaneNavigation;
  }) {
    this.zoomRootId = input.zoomRootId;
    this.showCompleted = input.showCompleted;
    this.hiddenAreaSource = `yonalist-outline-${input.paneId}`;
    this.unsubscribeMetadata = input.session.subscribeMetadata(
      () => this.updateHiddenAreas()
    );
    this.updateHiddenAreas();
  }

  activeNodeId(): string | null {
    const lineNumber = this.input.editor.getSelection()?.positionLineNumber;
    if (!lineNumber) return null;
    return this.input.session.metadata.current()
      .lines[lineNumber - 1]?.nodeId ?? null;
  }

  setZoomRoot(nodeId: string | null): void {
    if (nodeId === this.zoomRootId) return;
    this.viewStates.set(
      viewStateKey(this.zoomRootId),
      this.input.editor.saveViewState()
    );
    this.zoomRootId = nodeId;
    this.updateHiddenAreas();
    const saved = this.viewStates.get(viewStateKey(nodeId));
    if (saved) this.input.editor.restoreViewState(saved);
  }

  setShowCompleted(value: boolean): void {
    if (value === this.showCompleted) return;
    this.showCompleted = value;
    this.updateHiddenAreas();
  }

  handleBullet(nodeId: string, shiftKey: boolean): void {
    routeBulletClick(
      { nodeId, shiftKey },
      this.input.navigation
    );
  }

  diagnostics(): MonacoOutlinePaneDiagnostics {
    return Object.freeze({
      disposed: this.disposed,
      savedViewStates: this.viewStates.size,
      liveSubscriptions: this.disposed ? 0 : 1
    });
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.unsubscribeMetadata();
    this.input.editor.getDomNode()?.removeAttribute("data-empty-zoom");
    setEditorHiddenAreas(
      this.input.editor,
      [],
      this.hiddenAreaSource
    );
    this.viewStates.clear();
  }

  private updateHiddenAreas(): void {
    const metadata = this.input.session.metadata.current();
    const editorHost = this.input.editor.getDomNode();
    const emptyZoom = this.zoomRootId !== null &&
      visibleRangesForZoom(metadata, this.zoomRootId).length === 0;
    if (emptyZoom) {
      editorHost?.setAttribute("data-empty-zoom", "true");
    } else {
      editorHost?.removeAttribute("data-empty-zoom");
    }
    setEditorHiddenAreas(
      this.input.editor,
      hiddenRangesForPane(
        metadata,
        this.zoomRootId,
        this.showCompleted
      ),
      this.hiddenAreaSource
    );
  }
}

export function visibleRangesForZoom(
  metadata: OutlineMetadataSnapshot,
  nodeId: string | null
): readonly monaco.Range[] {
  if (metadata.lines.length === 0) return [];
  if (nodeId === null) {
    return [new monaco.Range(1, 1, metadata.lines.length, 1)];
  }
  const lineNumber = metadata.lineByNodeId.get(nodeId);
  if (lineNumber === undefined) return [];
  const startIndex = lineNumber - 1;
  const depth = metadata.lines[startIndex]!.depth;
  let endIndex = startIndex + 1;
  while (
    endIndex < metadata.lines.length &&
    metadata.lines[endIndex]!.depth > depth
  ) {
    endIndex += 1;
  }
  if (endIndex === startIndex + 1) return [];
  return [new monaco.Range(lineNumber + 1, 1, endIndex, 1)];
}

export function hiddenRangesForZoom(
  metadata: OutlineMetadataSnapshot,
  nodeId: string | null
): readonly monaco.Range[] {
  const visible = new Set<number>();
  for (const range of visibleRangesForZoom(metadata, nodeId)) {
    for (
      let lineNumber = range.startLineNumber;
      lineNumber <= range.endLineNumber;
      lineNumber += 1
    ) {
      visible.add(lineNumber);
    }
  }
  return rangesFromHiddenMask(
    metadata.lines.map((_, index) => !visible.has(index + 1))
  );
}

export function routeBulletClick(
  click: { readonly nodeId: string; readonly shiftKey: boolean },
  navigation: OutlinePaneNavigation
): void {
  if (click.shiftKey) {
    navigation.openSecondary(click.nodeId);
  } else {
    navigation.zoomSamePane(click.nodeId);
  }
}

function hiddenRangesForPane(
  metadata: OutlineMetadataSnapshot,
  zoomRootId: string | null,
  showCompleted: boolean
): readonly monaco.Range[] {
  const zoomVisible = new Set<number>();
  for (const range of visibleRangesForZoom(metadata, zoomRootId)) {
    for (
      let lineNumber = range.startLineNumber;
      lineNumber <= range.endLineNumber;
      lineNumber += 1
    ) {
      zoomVisible.add(lineNumber);
    }
  }
  let suppressedDepth: number | null = null;
  const hidden = metadata.lines.map((line, index) => {
    const lineNumber = index + 1;
    if (!zoomVisible.has(lineNumber)) return true;
    if (suppressedDepth !== null) {
      if (line.depth > suppressedDepth) return true;
      suppressedDepth = null;
    }
    if (!showCompleted && line.completed) {
      suppressedDepth = line.depth;
      return true;
    }
    if (line.collapsed) suppressedDepth = line.depth;
    return false;
  });
  return rangesFromHiddenMask(hidden);
}

function rangesFromHiddenMask(
  hidden: readonly boolean[]
): readonly monaco.Range[] {
  const ranges: monaco.Range[] = [];
  let start: number | null = null;
  hidden.forEach((value, index) => {
    const lineNumber = index + 1;
    if (value && start === null) start = lineNumber;
    if (!value && start !== null) {
      ranges.push(new monaco.Range(start, 1, lineNumber - 1, 1));
      start = null;
    }
  });
  if (start !== null) {
    ranges.push(new monaco.Range(start, 1, hidden.length, 1));
  }
  return ranges;
}

function viewStateKey(nodeId: string | null): string {
  return nodeId ?? "__page__";
}
