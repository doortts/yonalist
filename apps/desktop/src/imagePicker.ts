import type { ImageCandidate } from "./imageApi";

const supportedMimeTypes = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp"
]);

export function isNativeImageRuntime(): boolean {
  return "__TAURI_INTERNALS__" in window;
}

export function imageCandidates(
  files: readonly File[]
): readonly ImageCandidate[] {
  return files
    .filter((file) => supportedMimeTypes.has(file.type))
    .map((file) => ({
      originalName: file.name,
      declaredMimeType: file.type,
      blob: file
    }));
}

export async function pickImagePaths(
  multiple: boolean
): Promise<readonly string[]> {
  const { open } = await import("@tauri-apps/plugin-dialog");
  const selected = await open({
    multiple,
    directory: false,
    filters: [{
      name: "Images",
      extensions: ["png", "jpg", "jpeg", "gif", "webp"]
    }]
  });
  if (!selected) return [];
  return Array.isArray(selected) ? selected : [selected];
}

export function pickImageFiles(
  multiple: boolean
): Promise<readonly File[]> {
  return new Promise((resolve) => {
    const input = document.createElement("input");
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      window.removeEventListener("focus", handleWindowFocus);
      const files = input.files ? [...input.files] : [];
      input.remove();
      resolve(files);
    };
    const handleWindowFocus = () => window.setTimeout(finish, 0);
    input.type = "file";
    input.accept = "image/png,image/jpeg,image/gif,image/webp";
    input.multiple = multiple;
    input.hidden = true;
    input.addEventListener("change", finish, { once: true });
    window.addEventListener("focus", handleWindowFocus, { once: true });
    document.body.append(input);
    input.click();
  });
}

export async function pickImageSavePath(
  originalName: string
): Promise<string | null> {
  const { save } = await import("@tauri-apps/plugin-dialog");
  return save({ defaultPath: originalName });
}
