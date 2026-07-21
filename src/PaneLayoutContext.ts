import { createContext } from "react";

export interface PaneLayoutControls {
  detailMaximized: boolean;
  toggleDetailMaximized(): void;
}

export const PaneLayoutContext = createContext<PaneLayoutControls | null>(null);
