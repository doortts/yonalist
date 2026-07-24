import { describe, expect, it } from "vitest";
import { serializeMarkdownDocument } from "../domain/markdown";
import type { ItemFrontMatter } from "../domain/types";
import {
  parseVaultIndexScanChanges,
  type VaultIndexScanChange
} from "./vaultIndex";

function itemFrontMatter(): ItemFrontMatter {
  return {
    kind: "issue",
    host: "github.com",
    owner: "acme",
    repo: "app",
    number: 42,
    title: "Indexed issue",
    state: "open",
    author: "mona",
    labels: [],
    created_at: "2026-07-03T00:00:00Z",
    updated_at: "2026-07-04T00:00:00Z",
    local: { favorite: false },
    sync: { status: "synced" }
  };
}

function scanChange(
  relativePath = "github.com/acme/app/issues/42/issue.md",
  frontmatter = "kind: issue"
): VaultIndexScanChange {
  return {
    relative_path: relativePath,
    size: 100,
    modified_ns: "1721790000000000000",
    content_hash: "abc12345",
    frontmatter,
    frontmatter_error: false,
    expected: null
  };
}

describe("Vault index candidates", () => {
  it("parses valid items, preserves non-items, and isolates malformed YAML", () => {
    const result = parseVaultIndexScanChanges("/vault", [
      scanChange(
        "github.com/acme/app/issues/42/issue.md",
        serializeMarkdownDocument(itemFrontMatter(), "").slice(4, -5)
      ),
      scanChange(".yonalist/outbox/op.md", "kind: outbox_operation"),
      scanChange("broken.md", "kind: [")
    ]);

    expect(result.changes).toHaveLength(2);
    expect(result.changes[0].candidate?.number).toBe(42);
    expect(result.changes[1].candidate).toBeNull();
    expect(result.invalidCount).toBe(1);
  });

  it("counts Rust frontmatter extraction errors as invalid", () => {
    const result = parseVaultIndexScanChanges("/vault", [
      { ...scanChange(), frontmatter_error: true }
    ]);

    expect(result.changes).toEqual([]);
    expect(result.invalidCount).toBe(1);
  });

  it("isolates item-shaped frontmatter with an invalid required field", () => {
    const result = parseVaultIndexScanChanges("/vault", [
      scanChange(
        "github.com/acme/app/issues/42/issue.md",
        "kind: issue\nnumber: 42\ntitle: Missing identity"
      ),
      scanChange(
        "github.com/acme/app/issues/43/issue.md",
        serializeMarkdownDocument(itemFrontMatter(), "").slice(4, -5)
      )
    ]);

    expect(result.changes).toHaveLength(1);
    expect(result.changes[0].candidate?.number).toBe(42);
    expect(result.invalidCount).toBe(1);
  });

  it("isolates item-shaped frontmatter with array label colors", () => {
    const invalid = serializeMarkdownDocument(
      { ...itemFrontMatter(), label_colors: ["red"] as unknown as Record<string, string> },
      ""
    ).slice(4, -5);

    const result = parseVaultIndexScanChanges("/vault", [scanChange(undefined, invalid)]);

    expect(result.changes).toEqual([]);
    expect(result.invalidCount).toBe(1);
  });

  it("isolates item-shaped frontmatter with an empty required string", () => {
    const invalid = serializeMarkdownDocument(
      { ...itemFrontMatter(), title: "" },
      ""
    ).slice(4, -5);

    const result = parseVaultIndexScanChanges("/vault", [scanChange(undefined, invalid)]);

    expect(result.changes).toEqual([]);
    expect(result.invalidCount).toBe(1);
  });

  it("keeps local drafts out of the native item index", () => {
    const result = parseVaultIndexScanChanges("/vault", [
      scanChange(
        "github.com/acme/app/issues/_drafts/local-1/issue.md",
        serializeMarkdownDocument(
          { ...itemFrontMatter(), number: 0, sync: { status: "pending" } },
          ""
        ).slice(4, -5)
      )
    ]);

    expect(result.changes[0].candidate).toBeNull();
  });

  it("keeps a candidate aligned with its scanned path", () => {
    const result = parseVaultIndexScanChanges("/vault", [
      scanChange(
        "imported/issue.md",
        serializeMarkdownDocument(itemFrontMatter(), "").slice(4, -5)
      )
    ]);

    expect(result.changes[0].candidate?.relative_path).toBe("imported/issue.md");
  });
});
