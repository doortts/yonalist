import { render, screen, waitFor } from "@testing-library/react";
import type { NoteView } from "../../../packages/contracts/generated/NoteView";
import { ImageNodeContent } from "./ImageNodeContent";
import { ImageResidency } from "./imageResidency";

function node(): NoteView {
  return {
    id: "image-1",
    parentId: "page-1",
    sortKey: 1_024,
    kind: "image",
    image: {
      contentHash: "a".repeat(64),
      originalName: "cat.png",
      mimeType: "image/png",
      byteLength: 3,
      pixelWidth: 640,
      pixelHeight: 480,
      displayWidth: 320
    },
    text: "cat.png",
    note: "",
    marker: "bullet",
    collapsed: false,
    completed: false,
    starred: false,
    deleted: false
  };
}

describe("ImageNodeContent", () => {
  it("renders a lazy resident image without exposing its hidden filename as text", async () => {
    const residency = new ImageResidency(
      vi.fn().mockResolvedValue(Uint8Array.from([1, 2, 3])),
      {
        createObjectURL: vi.fn(() => "blob:cat"),
        revokeObjectURL: vi.fn()
      }
    );

    const view = render(
      <ImageNodeContent node={node()} residency={residency} />
    );

    expect(screen.queryByText("cat.png")).not.toBeInTheDocument();
    const image = await screen.findByRole("img", { name: "cat.png" });
    expect(image).toHaveAttribute("src", "blob:cat");
    expect(view.container.querySelector(".notes-image-attachment-frame"))
      .toHaveStyle({ width: "320px", aspectRatio: "640 / 480" });
  });

  it("shows the existing unavailable state when verified reading fails", async () => {
    const residency = new ImageResidency(
      vi.fn().mockRejectedValue(new Error("hash mismatch")),
      {
        createObjectURL: vi.fn(),
        revokeObjectURL: vi.fn()
      }
    );

    render(<ImageNodeContent node={node()} residency={residency} />);

    await waitFor(() =>
      expect(screen.getByRole("alert", { name: "Image unavailable: cat.png" }))
        .toHaveTextContent("Image unavailable")
    );
  });
});
