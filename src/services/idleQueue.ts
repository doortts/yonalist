type IdleCallbackHandle = number;

type IdleWindow = Window & {
  requestIdleCallback?: (
    callback: IdleRequestCallback,
    options?: IdleRequestOptions
  ) => IdleCallbackHandle;
  cancelIdleCallback?: (handle: IdleCallbackHandle) => void;
};

export function scheduleIdleTask(
  callback: IdleRequestCallback,
  timeout = 1500
): () => void {
  const idleWindow = window as IdleWindow;
  if (typeof idleWindow.requestIdleCallback === "function") {
    const handle = idleWindow.requestIdleCallback(callback, { timeout });
    return () => idleWindow.cancelIdleCallback?.(handle);
  }

  const handle = window.setTimeout(
    () =>
      callback({
        didTimeout: true,
        timeRemaining: () => 0
      }),
    timeout
  );
  return () => window.clearTimeout(handle);
}
