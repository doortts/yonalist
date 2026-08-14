import { act, renderHook, waitFor } from "@testing-library/react";
import type { RefObject } from "react";
import type { NotesStore } from "../notesStore";
import { OutlineIndex } from "../outline/outlineIndex";
import {
  useImageIngest,
  type ImageIngestBoundary,
  type NativeImageDropEvent
} from "./useImageIngest";

function scopeFixture() {
  const scope = document.createElement("section");
  scope.className = "notes-outline";
  scope.dataset.outlineRootId = "page";
  const row = document.createElement("div");
  row.dataset.outlineId = "first";
  scope.append(row);
  document.body.append(scope);
  return {
    scope,
    ref: { current: scope } as RefObject<HTMLElement>
  };
}

function index() {
  return new OutlineIndex([{
    id: "first",
    parentId: "page",
    sortKey: 1_024,
    kind: "bullet",
    image: null,
    text: "First",
    note: "",
    marker: "bullet",
    collapsed: false,
    completed: false,
    starred: false,
    deleted: false
  }]);
}

function boundary() {
  let listener: ((event: NativeImageDropEvent) => void) | null = null;
  const value: ImageIngestBoundary = {
    native: true,
    pickPaths: vi.fn(),
    listenNativeDrops: vi.fn(async (next) => {
      listener = next;
      return vi.fn();
    })
  };
  return {
    value,
    emit(event: NativeImageDropEvent) {
      listener?.(event);
    }
  };
}

function store() {
  return {
    images: {
      importAfter: vi.fn(),
      importPathsAfter: vi.fn()
    }
  } as unknown as NotesStore;
}

describe("image ingest", () => {
  it("treats picker cancellation as a no-op and imports paths in one batch", async () => {
    const { ref } = scopeFixture();
    const native = boundary();
    const notesStore = store();
    vi.mocked(native.value.pickPaths)
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce(["C:\\cat.png", "C:\\dog.webp"]);
    vi.mocked(notesStore.images.importPathsAfter).mockResolvedValue("cat");
    const { result } = renderHook(() => useImageIngest({
      store: notesStore,
      outlineRootId: "page",
      index: index(),
      scopeRef: ref,
      boundary: native.value
    }));

    await act(() => result.current.openPicker("first"));
    expect(notesStore.images.importPathsAfter).not.toHaveBeenCalled();

    await act(() => result.current.openPicker("first"));
    expect(notesStore.images.importPathsAfter).toHaveBeenCalledWith(
      "page",
      null,
      ["C:\\cat.png", "C:\\dog.webp"]
    );
  });

  it("clears the native drop marker after failure and unmount", async () => {
    const { ref } = scopeFixture();
    const native = boundary();
    const notesStore = store();
    vi.mocked(notesStore.images.importPathsAfter)
      .mockRejectedValue(new Error("import failed"));
    const { result, unmount } = renderHook(() => useImageIngest({
      store: notesStore,
      outlineRootId: "page",
      index: index(),
      scopeRef: ref,
      boundary: native.value
    }));
    await waitFor(() => expect(
      native.value.listenNativeDrops
    ).toHaveBeenCalledOnce());
    Object.defineProperty(document, "elementFromPoint", {
      configurable: true,
      value: vi.fn(() => ref.current!.querySelector("[data-outline-id]"))
    });

    act(() => native.emit({
      type: "over",
      position: { x: 10, y: 10 }
    }));
    expect(result.current.dropTargetId).toBe("first");
    await act(async () => {
      native.emit({
        type: "drop",
        paths: ["C:\\cat.png"],
        position: { x: 10, y: 10 }
      });
    });
    await waitFor(() => expect(result.current.dropTargetId).toBeNull());

    act(() => native.emit({
      type: "over",
      position: { x: 10, y: 10 }
    }));
    unmount();
    expect(vi.mocked(native.value.listenNativeDrops).mock.results[0])
      .toBeDefined();
    Reflect.deleteProperty(document, "elementFromPoint");
  });

  // A browser keeps the files back until the drop, so every `dragover` reports
  // an empty file list. Reading it there refuses the drag, the section never
  // accepts the drop, and nothing at all arrives.
  it("accepts a drag whose files the browser has not handed over yet", () => {
    const { scope, ref } = scopeFixture();
    const { result } = renderHook(() => useImageIngest({
      store: store(),
      outlineRootId: "page",
      index: index(),
      scopeRef: ref,
      boundary: { ...boundary().value, native: false }
    }));
    const preventDefault = vi.fn();
    const dataTransfer = {
      files: [] as unknown as FileList,
      items: [{ kind: "file", type: "image/png" }],
      types: ["Files"]
    };

    act(() => result.current.sectionProps.onDragOver({
      preventDefault,
      dataTransfer,
      target: scope.querySelector("[data-outline-id]"),
      currentTarget: scope
    } as unknown as Parameters<
      typeof result.current.sectionProps.onDragOver
    >[0]));

    expect(preventDefault).toHaveBeenCalled();
    expect(result.current.dropTargetId).toBe("first");
  });

  it("leaves a drag carrying no file to whatever else wants it", () => {
    const { scope, ref } = scopeFixture();
    const { result } = renderHook(() => useImageIngest({
      store: store(),
      outlineRootId: "page",
      index: index(),
      scopeRef: ref,
      boundary: { ...boundary().value, native: false }
    }));
    const preventDefault = vi.fn();

    act(() => result.current.sectionProps.onDragOver({
      preventDefault,
      dataTransfer: {
        files: [] as unknown as FileList,
        items: [{ kind: "string", type: "text/plain" }],
        types: ["text/plain"]
      },
      target: scope,
      currentTarget: scope
    } as unknown as Parameters<
      typeof result.current.sectionProps.onDragOver
    >[0]));

    expect(preventDefault).not.toHaveBeenCalled();
    expect(result.current.dropTargetId).toBeNull();
  });
});
