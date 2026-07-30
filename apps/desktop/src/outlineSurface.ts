export type OutlineSurface = "react" | "monaco";

export function outlineSurfaceFromSearch(search: string): OutlineSurface {
  return new URLSearchParams(search).get("outline") === "monaco"
    ? "monaco"
    : "react";
}
