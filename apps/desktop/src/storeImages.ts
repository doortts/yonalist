import type { NotesApi } from "./api";
import type { ImageCandidate, ImageInput } from "./imageApi";
import type { NotesState } from "./notesState";
import {
  StoreCommands,
  type ExternalCommandContext
} from "./storeCommands";
import { freshId } from "./storeSupport";

interface RetryableImport {
  readonly parentId: string;
  readonly beforeId: string | null;
  readonly candidates: readonly ImageCandidate[];
  readonly images: readonly ImageInput[];
  readonly requestId: string;
}

interface RetryablePathImport {
  readonly parentId: string;
  readonly beforeId: string | null;
  readonly paths: readonly string[];
  readonly images: readonly { readonly nodeId: string; readonly path: string }[];
  readonly requestId: string;
}

export class StoreImages {
  private retryableImport: RetryableImport | null = null;
  private retryablePathImport: RetryablePathImport | null = null;

  constructor(
    private readonly api: NotesApi,
    private readonly commands: StoreCommands,
    private readonly readState: () => NotesState
  ) {}

  async importAfter(
    parentId: string,
    beforeId: string | null,
    candidates: readonly ImageCandidate[]
  ): Promise<string> {
    const retry = this.matchesRetry(parentId, beforeId, candidates)
      ? this.retryableImport
      : null;
    const operation = retry ?? {
      parentId,
      beforeId,
      candidates,
      requestId: freshId(),
      images: candidates.map((candidate) => ({
        ...candidate,
        nodeId: freshId()
      }))
    };
    this.retryableImport = operation;
    try {
      await this.commands.executeExternal(
        (context) => this.api.importImageBytes(
          importRequest(context, operation)
        ),
        "images:batch",
        operation.requestId
      );
      if (this.retryableImport === operation) this.retryableImport = null;
      return operation.images[0]!.nodeId;
    } catch (error) {
      throw error;
    }
  }

  read(nodeId: string): Promise<Uint8Array> {
    const sessionId = this.readState().sessionId;
    if (!sessionId) {
      return Promise.reject(new Error("Notes session is not ready."));
    }
    return this.api.readImage({ sessionId, nodeId });
  }

  async importPathsAfter(
    parentId: string,
    beforeId: string | null,
    paths: readonly string[]
  ): Promise<string> {
    const retry = this.matchesPathRetry(parentId, beforeId, paths)
      ? this.retryablePathImport
      : null;
    const operation = retry ?? {
      parentId,
      beforeId,
      paths: [...paths],
      requestId: freshId(),
      images: paths.map((path) => ({ nodeId: freshId(), path }))
    };
    this.retryablePathImport = operation;
    await this.commands.executeExternal(
      (context) => this.api.importImagePaths({
        ...context,
        parentId: operation.parentId,
        beforeId: operation.beforeId,
        images: [...operation.images]
      }),
      "images:batch",
      operation.requestId
    );
    if (this.retryablePathImport === operation) {
      this.retryablePathImport = null;
    }
    return operation.images[0]!.nodeId;
  }

  private matchesRetry(
    parentId: string,
    beforeId: string | null,
    candidates: readonly ImageCandidate[]
  ): boolean {
    const retry = this.retryableImport;
    return Boolean(
      retry &&
      retry.parentId === parentId &&
      retry.beforeId === beforeId &&
      retry.candidates.length === candidates.length &&
      retry.candidates.every((candidate, index) => {
        const next = candidates[index];
        return Boolean(
          next &&
          candidate.blob === next.blob &&
          candidate.originalName === next.originalName &&
          candidate.declaredMimeType === next.declaredMimeType
        );
      })
    );
  }

  private matchesPathRetry(
    parentId: string,
    beforeId: string | null,
    paths: readonly string[]
  ): boolean {
    const retry = this.retryablePathImport;
    return Boolean(
      retry &&
      retry.parentId === parentId &&
      retry.beforeId === beforeId &&
      retry.paths.length === paths.length &&
      retry.paths.every((path, index) => path === paths[index])
    );
  }
}

function importRequest(
  context: ExternalCommandContext,
  operation: RetryableImport
) {
  return {
    ...context,
    parentId: operation.parentId,
    beforeId: operation.beforeId,
    images: operation.images
  };
}
