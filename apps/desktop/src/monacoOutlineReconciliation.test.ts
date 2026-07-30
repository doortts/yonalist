import { runMonacoOutlineReconciliation } from "./monacoOutlineReconciliation";

describe("Monaco outline reconciliation", () => {
  it("defers projection writes while IME composition owns the model", () => {
    const reconcile = vi.fn();

    expect(runMonacoOutlineReconciliation(true, reconcile)).toBe(false);
    expect(reconcile).not.toHaveBeenCalled();
    expect(runMonacoOutlineReconciliation(false, reconcile)).toBe(true);
    expect(reconcile).toHaveBeenCalledOnce();
  });
});
