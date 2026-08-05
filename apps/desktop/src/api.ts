import { invoke } from "@tauri-apps/api/core";
import type { BootSnapshot } from "../../../packages/contracts/generated/BootSnapshot";
import type { CloseOutcome } from "../../../packages/contracts/generated/CloseOutcome";
import type { CommandEnvelope } from "../../../packages/contracts/generated/CommandEnvelope";
import type { ForestRequest } from "../../../packages/contracts/generated/ForestRequest";
import type { ForestSnapshot } from "../../../packages/contracts/generated/ForestSnapshot";
import type { HistoryRequest } from "../../../packages/contracts/generated/HistoryRequest";
import type { ImageDownloadRequest } from "../../../packages/contracts/generated/ImageDownloadRequest";
import type { ImageReadRequest } from "../../../packages/contracts/generated/ImageReadRequest";
import type { ImageReplacePathRequest } from "../../../packages/contracts/generated/ImageReplacePathRequest";
import type { MutationReceipt } from "../../../packages/contracts/generated/MutationReceipt";
import type { NotesExportRequest } from "../../../packages/contracts/generated/NotesExportRequest";
import type { NotesExportResult } from "../../../packages/contracts/generated/NotesExportResult";
import type { SearchPage } from "../../../packages/contracts/generated/SearchPage";
import type { UnusedAssetsReport } from "../../../packages/contracts/generated/UnusedAssetsReport";
import type { SearchQuery } from "../../../packages/contracts/generated/SearchQuery";
import type { ViewportPage } from "../../../packages/contracts/generated/ViewportPage";
import type { ViewportRequest } from "../../../packages/contracts/generated/ViewportRequest";
import type {
  ImageImportRequest,
  ImagePathImportRequest,
  ImageReplaceRequest
} from "./imageApi";

export interface NotesApi {
  bootstrap(): Promise<BootSnapshot>;
  queryViewport(request: ViewportRequest): Promise<ViewportPage>;
  queryForest(request: ForestRequest): Promise<ForestSnapshot>;
  execute(envelope: CommandEnvelope): Promise<MutationReceipt>;
  importImageBytes(request: ImageImportRequest): Promise<MutationReceipt>;
  importImagePaths(request: ImagePathImportRequest): Promise<MutationReceipt>;
  replaceImageBytes(request: ImageReplaceRequest): Promise<MutationReceipt>;
  replaceImagePath(request: ImageReplacePathRequest): Promise<MutationReceipt>;
  readImage(request: ImageReadRequest): Promise<Uint8Array>;
  viewImageOriginal(request: ImageReadRequest): Promise<void>;
  downloadImage(request: ImageDownloadRequest): Promise<void>;
  exportNotes(request: NotesExportRequest): Promise<NotesExportResult>;
  undo(request: HistoryRequest): Promise<MutationReceipt>;
  redo(request: HistoryRequest): Promise<MutationReceipt>;
  search(query: SearchQuery): Promise<SearchPage>;
  closeSession(): Promise<CloseOutcome>;
  unusedAssets(purge: boolean): Promise<UnusedAssetsReport>;
  deleteAllData(): Promise<void>;
}

export const tauriNotesApi: NotesApi = {
  bootstrap: () => invoke("notes_bootstrap"),
  queryViewport: (request) => invoke("notes_query_viewport", { request }),
  queryForest: (request) => invoke("notes_query_forest", { request }),
  execute: (envelope) => invoke("notes_execute", { envelope }),
  importImageBytes: async (request) => {
    const { encodeImageEnvelope } = await import("./imageApi");
    return invoke(
      "notes_import_image_bytes",
      await encodeImageEnvelope(request)
    );
  },
  importImagePaths: (request) =>
    invoke("notes_import_image_paths", { request }),
  replaceImageBytes: async (request) => {
    const { encodeImageReplaceEnvelope } = await import("./imageApi");
    return invoke(
      "notes_replace_image_bytes",
      await encodeImageReplaceEnvelope(request)
    );
  },
  replaceImagePath: (request) =>
    invoke("notes_replace_image_path", { request }),
  readImage: async (request) => {
    const [{ normalizeImageBytes }, response] = await Promise.all([
      import("./imageApi"),
      invoke<unknown>("notes_read_image", { request })
    ]);
    return normalizeImageBytes(response);
  },
  viewImageOriginal: (request) =>
    invoke("notes_view_image_original", { request }),
  downloadImage: (request) =>
    invoke("notes_download_image", { request }),
  exportNotes: (request) => invoke("notes_export", { request }),
  undo: (request) => invoke("notes_undo", { request }),
  redo: (request) => invoke("notes_redo", { request }),
  search: (query) => invoke("notes_search", { query }),
  closeSession: () => invoke("notes_close_session"),
  unusedAssets: (purge) => invoke("notes_unused_assets", { purge }),
  deleteAllData: () => invoke("notes_delete_all_data")
};
