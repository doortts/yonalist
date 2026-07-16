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
    window.localStorage.clear();
    document.documentElement.removeAttribute("data-theme");
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

  it("applies the stored resolved theme before the mocked App renders", async () => {
    window.localStorage.setItem("yonalist.themeMode.v1", "light");
    window.localStorage.setItem("yonalist.lightTheme.v1", "graphite");

    await import("./main");

    expect(document.documentElement.dataset.theme).toBe("graphite");
  });

  it("renders startup failures with Graphite fallback colors", async () => {
    renderMock.mockImplementationOnce(() => {
      throw new Error("boot failed");
    });

    await import("./main");

    await vi.waitFor(() =>
      expect(document.getElementById("root")).toHaveTextContent(
        "Yonalist failed to start"
      )
    );
    expect(document.querySelector("#root > main")).toHaveStyle({
      background: "#d9dee5",
      color: "#1f2732"
    });
  });
});
