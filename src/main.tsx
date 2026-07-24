import React from "react";
import ReactDOM from "react-dom/client";
import {
  configureNotesSplitInputBenchmarkVault,
  installNotesSplitInputBenchmarkCollector
} from "./features/notes/notesSplitLatencyProbe";
import { tracePerf } from "./services/perfTrace";
import "./styles.css";

function startupErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return `${error.name}: ${error.message}\n${error.stack ?? ""}`;
  }
  return String(error);
}

function renderStartupError(error: unknown) {
  const root = document.getElementById("root");
  if (!root) {
    return;
  }
  root.innerHTML = "";
  const container = document.createElement("main");
  container.style.cssText = [
    "min-height: 100vh",
    "padding: 32px",
    "background: #15171c",
    "color: #e7eaef",
    "font: 14px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
    "white-space: pre-wrap"
  ].join(";");
  container.textContent = `Yonalist failed to start.\n\n${startupErrorMessage(error)}`;
  root.appendChild(container);
}

function handleStartupWindowError(event: ErrorEvent) {
  renderStartupError(event.error ?? event.message);
}

function handleStartupUnhandledRejection(event: PromiseRejectionEvent) {
  renderStartupError(event.reason);
}

function installStartupErrorHandlers() {
  window.addEventListener("error", handleStartupWindowError);
  window.addEventListener("unhandledrejection", handleStartupUnhandledRejection);
}

function removeStartupErrorHandlers() {
  window.removeEventListener("error", handleStartupWindowError);
  window.removeEventListener(
    "unhandledrejection",
    handleStartupUnhandledRejection
  );
}

async function start() {
  tracePerf("renderer_entry");
  const { default: App } = await import("./App");
  ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
    <React.StrictMode>
      <App />
    </React.StrictMode>
  );
  removeStartupErrorHandlers();
}

const splitInputBenchmarkEnv = import.meta.env;
configureNotesSplitInputBenchmarkVault(
  window.localStorage,
  window.location.origin,
  window.location.search,
  splitInputBenchmarkEnv?.VITE_SPLIT_INPUT_BENCH_VAULT
);
installNotesSplitInputBenchmarkCollector();
installStartupErrorHandlers();
void start().catch(renderStartupError);
