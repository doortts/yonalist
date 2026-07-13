import { describe, expect, it } from "vitest";
import type { NotesExportRequest } from "./notesExport";
import {
  defaultNotesExportFileName,
  isNotesExportConflictMessage,
  isNotesExportResult,
  NotesExportConflictError
} from "./notesExport";

describe("defaultNotesExportFileName", () => {
  it.each(
    [undefined, null, "", "   ", ".", ".."]
  )(
    "uses the default Markdown filename for %j",
    (title) => {
      expect(defaultNotesExportFileName(title)).toBe("notes-export.md");
    }
  );

  it("removes path separators, control characters, and reserved filename punctuation", () => {
    expect(
      defaultNotesExportFileName("  Sprint/Plan:\\\u0000*  Q3?  ")
    ).toBe("Sprint Plan Q3.md");
  });

  it("collapses whitespace and keeps exactly one case-normalized Markdown suffix", () => {
    expect(defaultNotesExportFileName("  Project   roadmap.MD  ")).toBe(
      "Project roadmap.md"
    );
  });

  it.each([
    "Project.md.",
    "Project.md .",
    "Project.md.md",
    "Project.md .md",
    "Project.md. .md",
    "Project.md .MD.."
  ])("normalizes trailing dots and repeated Markdown suffixes in %j", (title) => {
    expect(defaultNotesExportFileName(title)).toBe("Project.md");
  });

  const reservedDeviceStems = [
    "CON",
    "PRN",
    "AUX",
    "NUL",
    ...Array.from({ length: 9 }, (_, index) => `COM${index + 1}`),
    ...Array.from({ length: 9 }, (_, index) => `LPT${index + 1}`),
    "COM\u00b9",
    "COM\u00b2",
    "COM\u00b3",
    "LPT\u00b9",
    "LPT\u00b2",
    "LPT\u00b3"
  ];

  const reservedNameVariants = [
    (stem: string) => stem,
    (stem: string) => `${stem.toLowerCase()}.txt`,
    (stem: string) => `${stem} .txt`,
    (stem: string) => `${stem}. txt`,
    (stem: string) => `${stem}..txt`,
    (stem: string) => `${stem}.md.md`,
    (stem: string) => `${stem} .md .MD..`
  ];

  it.each(
    reservedDeviceStems.flatMap((stem) =>
      reservedNameVariants.map((createTitle) => createTitle(stem))
    )
  )("uses the default filename for reserved Windows device name %j", (title) => {
    expect(defaultNotesExportFileName(title)).toBe("notes-export.md");
  });

  it.each([
    "COM0",
    "COM10",
    "LPT0",
    "LPT10",
    "CONSOLE",
    "COM\u2074",
    "LPT\u2074"
  ])(
    "keeps non-reserved Windows filename stem %j",
    (title) => {
      expect(defaultNotesExportFileName(title)).toBe(`${title}.md`);
    }
  );

  it("preserves ordinary base text used only to derive the Windows comparison stem", () => {
    expect(defaultNotesExportFileName("Project notes .txt")).toBe(
      "Project notes .txt.md"
    );
  });

  it.each(
    [undefined, null, "", "   ", ".", ".."]
  )("uses the default PDF filename for %j", (title) => {
    expect(defaultNotesExportFileName(title, "pdf")).toBe("notes-export.pdf");
  });

  it.each([
    "Project.pdf.",
    "Project.pdf .",
    "Project.pdf.pdf",
    "Project.pdf .pdf",
    "Project.pdf. .pdf",
    "Project.pdf .PDF.."
  ])("normalizes trailing dots and repeated PDF suffixes in %j", (title) => {
    expect(defaultNotesExportFileName(title, "pdf")).toBe("Project.pdf");
  });

  it.each(
    reservedDeviceStems.flatMap((stem) =>
      reservedNameVariants.map((createTitle) => createTitle(stem))
    )
  )("uses the PDF fallback for reserved Windows device name %j", (title) => {
    expect(defaultNotesExportFileName(title, "pdf")).toBe("notes-export.pdf");
  });
});

describe("isNotesExportResult", () => {
  it("accepts the exact camelCase Markdown result", () => {
    expect(
      isNotesExportResult({
        destination: "/exports/project.md",
        format: "markdown"
      })
    ).toBe(true);
  });

  it("accepts the exact camelCase PDF result", () => {
    expect(
      isNotesExportResult({
        destination: "/exports/project.pdf",
        format: "pdf"
      })
    ).toBe(true);
  });

  it("validates the result against the requested format", () => {
    const result = {
      destination: "/exports/project.pdf",
      format: "pdf"
    };

    expect(isNotesExportResult(result, "pdf")).toBe(true);
    expect(isNotesExportResult(result, "markdown")).toBe(false);
  });

  it.each([
    null,
    [],
    { destination: "/exports/project.md" },
    { destination: "", format: "markdown" },
    { destination: "/exports/project.md", format: "Markdown" },
    { destination: "/exports/project.pdf", format: "PDF" },
    { destination: "/exports/project.txt", format: "text" },
    {
      destination: "/exports/project.md",
      format: "markdown",
      overwrite: false
    }
  ])("rejects malformed native result %j", (value) => {
    expect(isNotesExportResult(value)).toBe(false);
  });
});

describe("Notes export conflicts", () => {
  const request: NotesExportRequest = {
    vaultPath: "/vault",
    rootNodeId: "11111111-1111-4111-8111-111111111111",
    destination: "/exports/project.md",
    overwrite: false
  };

  it("retains the exact conflict contract and original retry request", () => {
    const error = new NotesExportConflictError(request.destination, request);

    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe("NotesExportConflictError");
    expect(error.message).toBe("Destination already exists.");
    expect(error.destination).toBe(request.destination);
    expect(error.request).toBe(request);
  });

  it("recognizes only the exact native conflict string", () => {
    expect(isNotesExportConflictMessage("Destination already exists.")).toBe(
      true
    );
    expect(isNotesExportConflictMessage("Destination already exists")).toBe(
      false
    );
    expect(
      isNotesExportConflictMessage(new Error("Destination already exists."))
    ).toBe(false);
  });
});
