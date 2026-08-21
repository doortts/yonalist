import type { NotesStore } from "../notesStore";
import {
  imageCandidates,
  isNativeImageRuntime,
  pickImageFiles,
  pickImagePaths,
  pickImageSavePath
} from "./imagePicker";

export async function replaceImageFromPicker(
  store: NotesStore,
  nodeId: string
): Promise<void> {
  if (isNativeImageRuntime()) {
    const [path] = await pickImagePaths(false);
    if (path) await store.images.replacePath(nodeId, path);
    return;
  }
  const [candidate] = imageCandidates(await pickImageFiles(false));
  if (candidate) await store.images.replace(nodeId, candidate);
}

export async function viewImageOriginal(
  store: NotesStore,
  nodeId: string,
  mimeType: string
): Promise<void> {
  if (isNativeImageRuntime()) {
    await store.images.viewOriginal(nodeId);
    return;
  }
  const bytes = await store.images.read(nodeId);
  const url = URL.createObjectURL(new Blob([bytes.slice().buffer], {
    type: mimeType
  }));
  window.open(url, "_blank", "noopener,noreferrer");
  window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

export async function downloadImage(
  store: NotesStore,
  nodeId: string,
  originalName: string,
  mimeType: string
): Promise<void> {
  if (isNativeImageRuntime()) {
    const destination = await pickImageSavePath(originalName);
    if (destination) await store.images.download(nodeId, destination);
    return;
  }
  const bytes = await store.images.read(nodeId);
  const url = URL.createObjectURL(new Blob([bytes.slice().buffer], {
    type: mimeType
  }));
  const link = document.createElement("a");
  link.href = url;
  link.download = originalName;
  link.click();
  URL.revokeObjectURL(url);
}
