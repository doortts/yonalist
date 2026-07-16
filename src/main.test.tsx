import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const renderMock = vi.hoisted(() => vi.fn());
const createRootMock = vi.hoisted(() =>
  vi.fn((root: HTMLElement) => ({
    render: vi.fn(() => {
      root.textContent = "App shell";
      renderMock();
    })
  }))
);

vi.mock("react-dom/client", () => ({
  default: { createRoot: createRootMock },
  createRoot: createRootMock
}));

vi.mock("./App", () => ({
  default: () => null
}));

describe("renderer startup error handling", () => {
  beforeEach(() => {
    vi.resetModules();
    createRootMock.mockClear();
    renderMock.mockClear();
    document.body.innerHTML = '<div id="root"></div>';
  });

  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("does not replace the mounted app with the startup failure screen for later runtime errors", async () => {
    await import("./main");
    await vi.waitFor(() => {
      expect(renderMock).toHaveBeenCalledTimes(1);
    });

    window.addEventListener("error", (event) => event.preventDefault(), {
      once: true
    });
    window.dispatchEvent(
      new ErrorEvent("error", {
        error: new Error("offline transition hiccup"),
        message: "offline transition hiccup"
      })
    );

    expect(document.getElementById("root")).toHaveTextContent("App shell");
    expect(document.getElementById("root")).not.toHaveTextContent(
      "Yonalist failed to start"
    );
  });
});
