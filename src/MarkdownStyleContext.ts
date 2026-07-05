import { createContext } from "react";
import type { MarkdownStyle } from "./appSettings";

export const MarkdownStyleContext = createContext<MarkdownStyle>("github");
