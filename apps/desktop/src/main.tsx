import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { tauriNotesApi, type NotesApi } from "./api";

async function start() {
  let api: NotesApi = tauriNotesApi;
  if (import.meta.env.DEV && !("__TAURI_INTERNALS__" in window)) {
    api = (await import("./previewApi")).previewNotesApi;
  }
  createRoot(document.getElementById("root")!).render(
    <StrictMode>
      <App api={api} />
    </StrictMode>
  );
}

void start();
