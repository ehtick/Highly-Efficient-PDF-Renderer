interface DrawCallMeterOptions {
  intervalMs?: number;
  signal?: AbortSignal;
}

/** Share HUD formatting and a trailing update for the final, on-demand frame. */
export function createDrawCallMeter(
  element: Pick<HTMLElement, "textContent">,
  { intervalMs = 100, signal }: DrawCallMeterOptions = {}
): { update: (drawCalls: number | null | undefined) => void; reset: () => void; dispose: () => void } {
  let pending: number | null | undefined = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let lastWriteTime = -Infinity;
  let lastText = element.textContent;
  let disposed = false;

  function cancelUpdate(): void {
    if (timer !== null) clearTimeout(timer);
    timer = null;
  }

  function write(): void {
    cancelUpdate();
    lastWriteTime = performance.now();
    const text = isDrawCallCount(pending) ? pending.toLocaleString() : "-";
    if (text !== lastText) {
      element.textContent = text;
      lastText = text;
    }
  }

  function update(drawCalls: number | null | undefined): void {
    if (disposed) return;
    pending = drawCalls;
    const remaining = intervalMs - (performance.now() - lastWriteTime);
    if (remaining <= 0) write();
    else if (timer === null) timer = setTimeout(write, remaining);
  }

  function reset(): void {
    if (disposed) return;
    pending = null;
    write();
    lastWriteTime = -Infinity;
  }

  function dispose(): void {
    disposed = true;
    cancelUpdate();
    signal?.removeEventListener("abort", dispose);
  }

  if (signal?.aborted) dispose();
  else signal?.addEventListener("abort", dispose, { once: true });
  return { update, reset, dispose };
}

interface ThreeDrawCallInfo {
  autoReset: boolean;
  reset: () => void;
  render: { calls: number; drawCalls?: number };
}

/** Count nested Three passes plus native offscreen draws submitted in this frame. */
export function createThreeDrawCallCounter(): {
  recordNativeFrame: (drawCalls: number | undefined) => void;
  measure: (info: ThreeDrawCallInfo, render: () => void) => number | null;
} {
  let measuring = false;
  let nativeDrawCalls: number | null = 0;
  return {
    recordNativeFrame(drawCalls): void {
      if (!measuring || nativeDrawCalls === null) return;
      nativeDrawCalls = isDrawCallCount(drawCalls) ? nativeDrawCalls + drawCalls : null;
    },
    measure(info, render): number | null {
      const autoReset = info.autoReset;
      // WebGL otherwise resets after the scene hook and inside every nested
      // compositor render, discarding work belonging to the displayed frame.
      info.autoReset = false;
      info.reset();
      nativeDrawCalls = 0;
      measuring = true;
      try {
        render();
        // WebGPU's `calls` counts renderer.render(), not GPU draw commands.
        const threeDrawCalls = info.render.drawCalls ?? info.render.calls;
        return nativeDrawCalls !== null && isDrawCallCount(threeDrawCalls)
          ? threeDrawCalls + nativeDrawCalls
          : null;
      } finally {
        measuring = false;
        info.autoReset = autoReset;
      }
    }
  };
}

function isDrawCallCount(value: number | null | undefined): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}
