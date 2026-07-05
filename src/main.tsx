import React from "react";
import ReactDOM from "react-dom/client";
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

window.addEventListener("error", (event) => {
  renderStartupError(event.error ?? event.message);
});

window.addEventListener("unhandledrejection", (event) => {
  renderStartupError(event.reason);
});

async function start() {
  tracePerf("renderer_entry");
  const { default: App } = await import("./App");
  ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
    <React.StrictMode>
      <App />
    </React.StrictMode>
  );
}

void start().catch(renderStartupError);
