import { Download } from "lucide-react";
import { lazy, Suspense, useState } from "react";
import type { NotesStore } from "./notesStore";

const NotesExportMenu = lazy(() =>
  import("./NotesExportMenu").then((module) => ({
    default: module.NotesExportMenu
  })));

interface ExportTarget {
  readonly id: string;
  readonly title: string;
}

function ExportTrigger({
  disabled,
  onClick
}: {
  readonly disabled: boolean;
  readonly onClick?: () => void;
}) {
  return (
    <button
      className="notes-export-trigger"
      type="button"
      aria-label="Export"
      aria-haspopup="menu"
      aria-expanded={false}
      disabled={disabled}
      onClick={onClick}
    >
      <Download size={16} aria-hidden="true" />
    </button>
  );
}

export function NotesExportBoundary({
  store,
  currentRoot,
  selectedNode
}: {
  readonly store: NotesStore;
  readonly currentRoot: ExportTarget;
  readonly selectedNode: ExportTarget | null;
}) {
  const [activated, setActivated] = useState(false);
  if (!activated) {
    return (
      <div className="notes-export-control">
        <ExportTrigger disabled={false} onClick={() => setActivated(true)} />
      </div>
    );
  }
  return (
    <Suspense fallback={
      <div className="notes-export-control" aria-busy="true">
        <ExportTrigger disabled />
      </div>
    }>
      <NotesExportMenu
        store={store}
        currentRoot={currentRoot}
        selectedNode={selectedNode}
        initialOpen
      />
    </Suspense>
  );
}
