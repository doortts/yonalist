export type NativeImageDropEvent =
  | {
      readonly type: "enter" | "drop";
      readonly paths: readonly string[];
      readonly position: { readonly x: number; readonly y: number };
    }
  | {
      readonly type: "over";
      readonly position: { readonly x: number; readonly y: number };
    }
  | { readonly type: "leave" };

export interface ImageIngestBoundary {
  readonly native: boolean;
  pickPaths(): Promise<readonly string[]>;
  listenNativeDrops(
    listener: (event: NativeImageDropEvent) => void
  ): Promise<() => void>;
}
