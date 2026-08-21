import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { MobileApp } from "./MobileApp";
import { tauriNotesApi, type NotesApi } from "../api";
import "../styles.css";

async function start() {
  let api: NotesApi = tauriNotesApi;
  // The same swap the desktop entry makes: a browser with no Tauri behind it
  // gets the in-memory backend, which is how the phone screens are built
  // without an Xcode round trip.
  if (import.meta.env.DEV && !("__TAURI_INTERNALS__" in window)) {
    api = (await import("../preview/previewApi")).previewNotesApi;
  }
  createRoot(document.getElementById("root")!).render(
    <StrictMode>
      <MobileApp api={api} />
    </StrictMode>
  );
}

void start();
