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

export class StoreImages {
  private retryableImport: RetryableImport | null = null;

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
