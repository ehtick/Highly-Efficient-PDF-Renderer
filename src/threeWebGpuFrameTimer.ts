import type { ExternalGpuFrameResult, ExternalGpuFrameTimer } from "./renderPerformance";

interface TimestampRenderer {
  backend?: { trackTimestamp?: boolean; device?: { features?: { has(name: string): boolean } } };
  resolveTimestampsAsync?(type?: string): Promise<number | undefined>;
}

/**
 * GPU times of Three WebGPU frames through Three's own timestamp queries. A
 * sampled frame turns tracking on, and its time is the sum of the render
 * passes Three timed in it. Three groups passes by `info.frame`, which the
 * example sets once per rendered frame.
 */
export class ThreeWebGpuFrameTimer implements ExternalGpuFrameTimer {
  readonly unavailableReason: string | null;
  readonly note = "Three WebGPU GPU times sum the render passes Three timed in a sampled frame, so unlike a command " +
    "span they exclude the GPU's gaps between passes. Browsers may quantize these timestamps; Chrome rounds them to " +
    "100 µs unless its WebGPU developer features are enabled.";
  private readonly renderer: TimestampRenderer;
  private frame: number | null = null;
  private resolving = false;
  /** Bumped on cancel, so a resolve still in flight reports nothing. */
  private generation = 0;
  private readonly results: ExternalGpuFrameResult[] = [];

  constructor(renderer: TimestampRenderer) {
    this.renderer = renderer;
    this.unavailableReason = !renderer.backend || typeof renderer.resolveTimestampsAsync !== "function"
      ? "The renderer has no WebGPU timestamp support."
      : renderer.backend.device?.features?.has("timestamp-query")
        ? null : "The WebGPU device was created without the timestamp-query feature.";
  }

  beginFrame(frame: number): boolean {
    // One frame at a time: Three's pool sums whatever it recorded since its last resolve.
    if (this.unavailableReason || this.resolving || this.frame !== null) return false;
    this.frame = frame;
    this.renderer.backend!.trackTimestamp = true;
    return true;
  }

  endFrame(): void {
    const frame = this.frame;
    this.frame = null;
    if (frame === null) return;
    const generation = this.generation;
    this.resolving = true;
    // Three checks tracking as the resolve starts, and encodes it before its
    // first await, so tracking can stop right after.
    const pending = this.renderer.resolveTimestampsAsync!("render");
    this.renderer.backend!.trackTimestamp = false;
    pending.then(ms => {
      if (generation === this.generation) this.results.push({ frame, ms: typeof ms === "number" ? ms : null });
    }, () => {
      if (generation === this.generation) this.results.push({ frame, ms: null });
    }).finally(() => { this.resolving = false; });
  }

  takeResults(): readonly ExternalGpuFrameResult[] {
    return this.results.splice(0);
  }

  cancel(): number {
    const pending = (this.resolving ? 1 : 0) + (this.frame !== null ? 1 : 0);
    this.generation++;
    if (this.frame !== null) { this.frame = null; this.renderer.backend!.trackTimestamp = false; }
    this.results.length = 0;
    return pending;
  }
}
