import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { MarkdownBody } from "./MarkdownBody";

const imageMarkdown = "![roadmap](https://example.com/roadmap.png)\n\nBody text";

describe("MarkdownBody", () => {
  it("renders markdown images inside the body", () => {
    render(<MarkdownBody body={imageMarkdown} />);

    const image = screen.getByRole("img", { name: "roadmap" });
    expect(image).toHaveAttribute("src", "https://example.com/roadmap.png");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("opens the original image in a lightbox when clicked", async () => {
    const user = userEvent.setup();
    render(<MarkdownBody body={imageMarkdown} />);

    await user.click(screen.getByRole("img", { name: "roadmap" }));

    const viewer = screen.getByRole("dialog", { name: "Image viewer" });
    expect(viewer).toBeInTheDocument();
    expect(screen.getByRole("img", { name: "Original size" })).toHaveAttribute(
      "src",
      "https://example.com/roadmap.png"
    );
  });

  it("closes the lightbox from the backdrop, close button, and Escape", async () => {
    const user = userEvent.setup();
    render(<MarkdownBody body={imageMarkdown} />);

    await user.click(screen.getByRole("img", { name: "roadmap" }));
    await user.click(screen.getByRole("button", { name: "Close image viewer" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();

    await user.click(screen.getByRole("img", { name: "roadmap" }));
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();

    // Clicking the enlarged image itself keeps the viewer open.
    await user.click(screen.getByRole("img", { name: "roadmap" }));
    await user.click(screen.getByRole("img", { name: "Original size" }));
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });
});
