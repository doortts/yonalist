import { createCloseRequestHandler } from "./closeSession";

it("flushes once while allowing the destroy close event to continue", async () => {
  const firstEvent = { preventDefault: vi.fn() };
  const destroyEvent = { preventDefault: vi.fn() };
  const flush = vi.fn().mockResolvedValue(undefined);
  let handler: ReturnType<typeof createCloseRequestHandler>;
  const destroy = vi.fn(async () => {
    await handler(destroyEvent);
  });
  handler = createCloseRequestHandler(flush, destroy);

  await handler(firstEvent);

  expect(flush).toHaveBeenCalledTimes(1);
  expect(destroy).toHaveBeenCalledTimes(1);
  expect(firstEvent.preventDefault).toHaveBeenCalledTimes(1);
  expect(destroyEvent.preventDefault).not.toHaveBeenCalled();
});

it("continues preventing repeated close requests until the flush completes", async () => {
  let finishFlush: (() => void) | undefined;
  const flush = vi.fn(() => new Promise<void>((resolve) => {
    finishFlush = resolve;
  }));
  const destroy = vi.fn().mockResolvedValue(undefined);
  const handler = createCloseRequestHandler(flush, destroy);
  const firstEvent = { preventDefault: vi.fn() };
  const repeatedEvent = { preventDefault: vi.fn() };

  const closing = handler(firstEvent);
  await handler(repeatedEvent);

  expect(firstEvent.preventDefault).toHaveBeenCalledTimes(1);
  expect(repeatedEvent.preventDefault).toHaveBeenCalledTimes(1);
  expect(flush).toHaveBeenCalledTimes(1);
  expect(destroy).not.toHaveBeenCalled();

  finishFlush?.();
  await closing;
  expect(destroy).toHaveBeenCalledTimes(1);
});
