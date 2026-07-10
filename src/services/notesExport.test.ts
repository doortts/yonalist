import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  NotesExportRequest,
  NotesExportSaveRequest
} from "../domain/notesExport";
import { NotesExportConflictError } from "../domain/notesExport";
import { renderMarkdownExport, saveNotesExport } from "./notesExport";

const tauriCoreFactoryEvaluated = vi.hoisted(() => ({ current: false }));
const dialogFactoryEvaluated = vi.hoisted(() => ({ current: false }));
const invokeMock = vi.hoisted(() => vi.fn());
const saveMock = vi.hoisted(() => vi.fn());

vi.mock("@tauri-apps/api/core", () => {
  tauriCoreFactoryEvaluated.current = true;
  return { invoke: invokeMock };
});

vi.mock("@tauri-apps/plugin-dialog", () => {
  dialogFactoryEvaluated.current = true;
  return { save: saveMock };
});

const saveRequest: NotesExportSaveRequest = {
  vaultPath: "/vault",
  rootNodeId: "11111111-1111-4111-8111-111111111111",
  format: "markdown"
};

const exportRequest: NotesExportRequest = {
  vaultPath: saveRequest.vaultPath,
  rootNodeId: saveRequest.rootNodeId,
  destination: "/exports/project.md",
  overwrite: true
};

describe("notesExport", () => {
  beforeEach(() => {
    invokeMock.mockReset();
    saveMock.mockReset();
    tauriCoreFactoryEvaluated.current = false;
    dialogFactoryEvaluated.current = false;
    Object.defineProperty(window, "__TAURI_INTERNALS__", {
      configurable: true,
      value: {}
    });
  });

  afterEach(() => {
    Reflect.deleteProperty(window, "__TAURI_INTERNALS__");
  });

  it("guards outside Tauri before importing either native module", async () => {
    Reflect.deleteProperty(window, "__TAURI_INTERNALS__");

    const error = await saveNotesExport(saveRequest).catch(
      (rejection: unknown) => rejection
    );

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe(
      "Notes requires Tauri desktop storage."
    );
    expect(dialogFactoryEvaluated.current).toBe(false);
    expect(tauriCoreFactoryEvaluated.current).toBe(false);
    expect(saveMock).not.toHaveBeenCalled();
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it("returns null on dialog cancellation before importing or invoking core", async () => {
    saveMock.mockResolvedValue(null);

    await expect(saveNotesExport(saveRequest)).resolves.toBeNull();

    expect(saveMock).toHaveBeenCalledWith({
      defaultPath: "notes-export.md",
      filters: [{ name: "Markdown", extensions: ["md"] }]
    });
    expect(dialogFactoryEvaluated.current).toBe(true);
    expect(tauriCoreFactoryEvaluated.current).toBe(false);
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it("uses the Markdown filter and sanitized default path before invoking the exact payload", async () => {
    const destination = "/exports/Project roadmap.md";
    saveMock.mockResolvedValue(destination);
    invokeMock.mockResolvedValue({ destination, format: "markdown" });

    await expect(
      saveNotesExport({
        ...saveRequest,
        defaultFileName: "  Project/roadmap.MD  "
      })
    ).resolves.toEqual({ destination, format: "markdown" });

    expect(saveMock).toHaveBeenCalledWith({
      defaultPath: "Project roadmap.md",
      filters: [{ name: "Markdown", extensions: ["md"] }]
    });
    expect(invokeMock).toHaveBeenCalledWith("notes_export_markdown", {
      vaultPath: "/vault",
      rootNodeId: "11111111-1111-4111-8111-111111111111",
      destination,
      overwrite: false
    });
    expect(saveMock.mock.invocationCallOrder[0]).toBeLessThan(
      invokeMock.mock.invocationCallOrder[0]
    );
  });

  it("passes an overwrite retry request unchanged to the native command", async () => {
    invokeMock.mockResolvedValue({
      destination: exportRequest.destination,
      format: "markdown"
    });

    await expect(renderMarkdownExport(exportRequest)).resolves.toEqual({
      destination: exportRequest.destination,
      format: "markdown"
    });

    expect(invokeMock).toHaveBeenCalledWith(
      "notes_export_markdown",
      exportRequest
    );
  });

  it("rejects a malformed native response", async () => {
    invokeMock.mockResolvedValue({
      destination: exportRequest.destination,
      format: "Markdown"
    });

    await expect(renderMarkdownExport(exportRequest)).rejects.toEqual(
      new Error("Notes export returned an invalid result.")
    );
  });

  it("maps only the exact conflict text and retains the retry request", async () => {
    invokeMock.mockRejectedValue("Destination already exists.");

    const error = await renderMarkdownExport(exportRequest).catch(
      (rejection: unknown) => rejection
    );

    expect(error).toBeInstanceOf(NotesExportConflictError);
    expect((error as NotesExportConflictError).message).toBe(
      "Destination already exists."
    );
    expect((error as NotesExportConflictError).destination).toBe(
      exportRequest.destination
    );
    expect((error as NotesExportConflictError).request).toBe(exportRequest);
  });

  it.each([
    "Destination already exists",
    new Error("Destination already exists."),
    new Error("Disk full")
  ])("passes through a non-exact conflict rejection", async (cause) => {
    invokeMock.mockRejectedValue(cause);

    const error = await renderMarkdownExport(exportRequest).catch(
      (rejection: unknown) => rejection
    );

    expect(error).toBe(cause);
  });
});
