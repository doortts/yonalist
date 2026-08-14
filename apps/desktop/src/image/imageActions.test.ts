import type { NotesStore } from "../notesStore";

const picker = vi.hoisted(() => ({
  native: true,
  files: vi.fn(),
  paths: vi.fn(),
  savePath: vi.fn()
}));

vi.mock("./imagePicker", () => ({
  isNativeImageRuntime: () => picker.native,
  pickImageFiles: picker.files,
  pickImagePaths: picker.paths,
  pickImageSavePath: picker.savePath,
  imageCandidates: (files: readonly File[]) => files.map((file) => ({
    originalName: file.name,
    declaredMimeType: file.type,
    blob: file
  }))
}));

import {
  downloadImage,
  replaceImageFromPicker,
  viewImageOriginal
} from "./imageActions";

function store() {
  return {
    images: {
      replace: vi.fn().mockResolvedValue(undefined),
      replacePath: vi.fn().mockResolvedValue(undefined),
      read: vi.fn().mockResolvedValue(Uint8Array.from([1, 2, 3])),
      viewOriginal: vi.fn().mockResolvedValue(undefined),
      download: vi.fn().mockResolvedValue(undefined)
    }
  } as unknown as NotesStore;
}

describe("image actions", () => {
  beforeEach(() => {
    picker.native = true;
    picker.files.mockReset();
    picker.paths.mockReset();
    picker.savePath.mockReset();
  });

  it("treats native replace and save cancellation as a no-op", async () => {
    const notes = store();
    picker.paths.mockResolvedValue([]);
    picker.savePath.mockResolvedValue(null);

    await replaceImageFromPicker(notes, "image-1");
    await downloadImage(notes, "image-1", "cat.png", "image/png");

    expect(notes.images.replacePath).not.toHaveBeenCalled();
    expect(notes.images.download).not.toHaveBeenCalled();
  });

  it("routes native replacement, original view, and download through the store", async () => {
    const notes = store();
    picker.paths.mockResolvedValue(["C:\\Images\\replacement.png"]);
    picker.savePath.mockResolvedValue("C:\\Downloads\\cat.png");

    await replaceImageFromPicker(notes, "image-1");
    await viewImageOriginal(notes, "image-1", "image/png");
    await downloadImage(notes, "image-1", "cat.png", "image/png");

    expect(notes.images.replacePath)
      .toHaveBeenCalledWith("image-1", "C:\\Images\\replacement.png");
    expect(notes.images.viewOriginal).toHaveBeenCalledWith("image-1");
    expect(notes.images.download)
      .toHaveBeenCalledWith("image-1", "C:\\Downloads\\cat.png");
  });

  it("uses browser files and temporary object URLs outside Tauri", async () => {
    picker.native = false;
    picker.files.mockResolvedValue([
      new File([Uint8Array.from([4, 5])], "replacement.png", {
        type: "image/png"
      })
    ]);
    const notes = store();
    const createObjectURL = vi.spyOn(URL, "createObjectURL")
      .mockReturnValue("blob:action");
    const revokeObjectURL = vi.spyOn(URL, "revokeObjectURL")
      .mockImplementation(() => undefined);
    const open = vi.spyOn(window, "open").mockImplementation(() => null);
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click")
      .mockImplementation(() => undefined);

    await replaceImageFromPicker(notes, "image-1");
    await viewImageOriginal(notes, "image-1", "image/png");
    await downloadImage(notes, "image-1", "cat.png", "image/png");

    expect(notes.images.replace).toHaveBeenCalledWith(
      "image-1",
      expect.objectContaining({ originalName: "replacement.png" })
    );
    expect(open).toHaveBeenCalledWith(
      "blob:action",
      "_blank",
      "noopener,noreferrer"
    );
    expect(click).toHaveBeenCalledOnce();
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:action");

    createObjectURL.mockRestore();
    revokeObjectURL.mockRestore();
    open.mockRestore();
    click.mockRestore();
  });
});
