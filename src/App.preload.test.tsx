import React from "react";
import { render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import App from "./App";

// Isolated from App.test.tsx on purpose: mocking the markdownRender module
// here must not leak into shell tests that render real markdown.
const rendererLoaded = vi.hoisted(() => ({ current: false }));

vi.mock("./markdownRender", () => {
  rendererLoaded.current = true;
  return {
    renderMarkdown: () => ({ __html: "" })
  };
});

function installLocalStorageMock() {
  let store: Record<string, string> = {};
  const localStorageMock = {
    get length() {
      return Object.keys(store).length;
    },
    clear: vi.fn(() => {
      store = {};
    }),
    getItem: vi.fn((key: string) => store[key] ?? null),
    key: vi.fn((index: number) => Object.keys(store)[index] ?? null),
    removeItem: vi.fn((key: string) => {
      delete store[key];
    }),
    setItem: vi.fn((key: string, value: string) => {
      store[key] = String(value);
    })
  } as Storage;

  Object.defineProperty(window, "localStorage", {
    configurable: true,
    value: localStorageMock
  });
}

describe("markdown renderer idle preload", () => {
  beforeEach(() => {
    installLocalStorageMock();
    window.localStorage.setItem("yonalist.auth.skipLogin.v1", "true");
    rendererLoaded.current = false;
  });

  it("loads the markdown renderer at idle without opening any detail", async () => {
    render(<App />);
    await screen.findByLabelText("Navigation");
    // No detail is selected in the demo inbox, so only the idle preload can
    // pull the renderer chunk in. jsdom lacks requestIdleCallback, so the
    // scheduleIdleTask fallback timer (1.5s) has to fire first.
    await waitFor(() => expect(rendererLoaded.current).toBe(true), {
      timeout: 4000
    });
  });
});
