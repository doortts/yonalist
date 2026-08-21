import type { NotesApi } from "./api";
import type { ImageCandidate } from "./image/imageApi";
import type { NotesState } from "./notesState";
import type { StoreCommands } from "./store/storeCommands";
import type { StoreImages } from "./store/storeImages";

export class LazyStoreImages {
  private loaded: Promise<StoreImages> | null = null;

  constructor(
    private readonly api: NotesApi,
    private readonly commands: StoreCommands,
    private readonly readState: () => NotesState
  ) {}

  importAfter(
    parentId: string,
    beforeId: string | null,
    candidates: readonly ImageCandidate[]
  ): Promise<string> {
    return this.load().then((images) =>
      images.importAfter(parentId, beforeId, candidates));
  }

  importPathsAfter(
    parentId: string,
    beforeId: string | null,
    paths: readonly string[]
  ): Promise<string> {
    return this.load().then((images) =>
      images.importPathsAfter(parentId, beforeId, paths));
  }

  read(nodeId: string): Promise<Uint8Array> {
    return this.load().then((images) => images.read(nodeId));
  }

  resize(
    nodeId: string,
    displayWidth: number,
    historyGroup: string | null = null
  ): Promise<void> {
    return this.load().then((images) =>
      images.resize(nodeId, displayWidth, historyGroup));
  }

  replace(nodeId: string, candidate: ImageCandidate): Promise<void> {
    return this.load().then((images) => images.replace(nodeId, candidate));
  }

  replacePath(nodeId: string, path: string): Promise<void> {
    return this.load().then((images) => images.replacePath(nodeId, path));
  }

  viewOriginal(nodeId: string): Promise<void> {
    return this.load().then((images) => images.viewOriginal(nodeId));
  }

  download(nodeId: string, destinationPath: string): Promise<void> {
    return this.load().then((images) =>
      images.download(nodeId, destinationPath));
  }

  private load(): Promise<StoreImages> {
    this.loaded ??= import("./store/storeImages").then(({ StoreImages }) =>
      new StoreImages(this.api, this.commands, this.readState));
    return this.loaded;
  }
}
