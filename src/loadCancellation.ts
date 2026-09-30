/** Wait for non-cancellable host work while observing (and draining) its result. */
export function waitForLoad<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => {
      signal.removeEventListener("abort", onAbort);
      reject(signal.reason);
    };
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        if (signal.aborted) reject(signal.reason);
        else resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(signal.aborted ? signal.reason : error);
      }
    );
    if (signal.aborted) onAbort();
  });
}

/** Yield before GPU allocation; cancellation also works in a background tab. */
export async function yieldForLoad(signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted();
  let cancel: () => void = () => {};
  const frame = new Promise<void>((resolve) => {
    if (typeof requestAnimationFrame === "function") {
      const id = requestAnimationFrame(() => resolve());
      cancel = () => cancelAnimationFrame(id);
    } else {
      const id = setTimeout(resolve, 0);
      cancel = () => clearTimeout(id);
    }
  });
  try {
    await waitForLoad(frame, signal);
  } finally {
    cancel();
  }
}

/**
 * Return to the event loop after about `budgetMs` of work. Long CPU preparation
 * then keeps input and rendering responsive without waiting a whole frame per
 * step, so its throughput does not depend on the display refresh rate.
 */
export function createLoadYielder(signal?: AbortSignal, budgetMs = 10): () => Promise<void> {
  let sliceStart = performance.now();
  return async () => {
    signal?.throwIfAborted();
    if (performance.now() - sliceStart < budgetMs) return;
    await waitForLoad(yieldToEventLoop(), signal);
    sliceStart = performance.now();
  };
}

/** Wait until the page has had a chance to paint, e.g. to show a progress indicator. */
export async function yieldAfterPaint(signal?: AbortSignal): Promise<void> {
  // Animation frame callbacks run before that frame paints; the next task after.
  await yieldForLoad(signal);
  await waitForLoad(yieldToEventLoop(), signal);
}

function yieldToEventLoop(): Promise<void> {
  // scheduler.yield() resumes ahead of other queued tasks where supported.
  const scheduler = (globalThis as { scheduler?: { yield?: () => Promise<void> } }).scheduler;
  if (typeof scheduler?.yield === "function") return scheduler.yield();
  return new Promise((resolve) => {
    if (typeof MessageChannel !== "function") { setTimeout(resolve, 0); return; }
    const channel = new MessageChannel();
    channel.port1.onmessage = () => { channel.port1.close(); resolve(); };
    channel.port2.postMessage(null);
  });
}
