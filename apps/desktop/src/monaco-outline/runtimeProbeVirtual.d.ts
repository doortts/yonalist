declare module "virtual:yonalist-monaco-runtime-probe" {
  type MonacoEditor = import(
    "monaco-editor/esm/vs/editor/editor.api"
  ).editor.IStandaloneCodeEditor;
  type MonacoDisposable = import(
    "monaco-editor/esm/vs/editor/editor.api"
  ).IDisposable;
  type OutlineSession = import("./session").MonacoOutlineSession;

  export function attachDevelopmentBenchmarkRun(
    editor: MonacoEditor,
    session: OutlineSession
  ): MonacoDisposable | null;
}
