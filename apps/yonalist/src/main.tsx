import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { tauriNotesApi, type NotesApi } from "./api";
import { restorePageZoom } from "./pageZoom";

async function start() {
  // Ahead of the first paint, so a remembered size is not a visible reflow.
  void restorePageZoom();
  let api: NotesApi = tauriNotesApi;
  if (import.meta.env.DEV && !("__TAURI_INTERNALS__" in window)) {
    api = (await import("./preview/previewApi")).previewNotesApi;
  }
  createRoot(document.getElementById("root")!).render(
    <StrictMode>
      <App api={api} />
    </StrictMode>
  );
}

void start();
