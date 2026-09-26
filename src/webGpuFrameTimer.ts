import type { ExternalGpuFrameResult, ExternalGpuFrameTimer, GpuOperationDetail } from "./renderPerformance";

/** Render passes one frame can time; each takes two timestamps. */
const MAX_PASSES = 1024;
/** Frames in flight at once; later samples are skipped rather than waited for. */
const MAX_PENDING_FRAMES = 2;

interface TimedPass { label: string; draws: number }
interface FrameSlot {
  querySet: any;
  resolve: any;
  readback: any;
  frame: number;
  passes: TimedPass[];
  state: "idle" | "recording" | "reading";
  cancelled: boolean;
}

/**
 * GPU times of native WebGPU frames from timestamp queries. While a sampled
 * frame renders, every render pass its instrumented encoders begin writes a
 * timestamp at its start and end; the frame's time runs from its first
 * pass's start to its last pass's end, and each pass is one timed operation.
 */
export class WebGpuFrameTimer implements ExternalGpuFrameTimer {
  readonly unavailableReason: string | null;
  readonly note = "WebGPU GPU times come from timestamps at the start and end of each render pass of a sampled frame: " +
    "the frame time spans its first pass's start to its last pass's end, each operation is a whole render pass, and its " +
    "instances count the pass's draws. Browsers may quantize these timestamps; Chrome rounds them to 100 µs unless its " +
    "WebGPU developer features are enabled.";
  private readonly device: any;
  private readonly slots: FrameSlot[] = [];
  private recording: FrameSlot | null = null;
  private readonly results: ExternalGpuFrameResult[] = [];

  constructor(device: any) {
    this.device = device;
    this.unavailableReason = device?.features?.has?.("timestamp-query")
      ? null : "The WebGPU device was created without the timestamp-query feature.";
  }

  beginFrame(frame: number): boolean {
    if (this.unavailableReason) return false;
    let slot: FrameSlot | null = this.slots.find(candidate => candidate.state === "idle") ?? null;
    if (!slot) {
      if (this.slots.length >= MAX_PENDING_FRAMES) return false;
      slot = this.createSlot();
      if (!slot) return false;
    }
    slot.frame = frame; slot.passes = []; slot.state = "recording"; slot.cancelled = false;
    this.recording = slot;
    return true;
  }

  /** Times the render passes this encoder begins while a sampled frame records. */
  instrument(encoder: any): any {
    const slot = this.recording;
    if (!slot) return encoder;
    return new Proxy(encoder, { get: (target, key) => {
      if (key === "beginRenderPass") return (descriptor: any) => this.beginPass(target, slot, descriptor);
      const value = target[key];
      return typeof value === "function" ? value.bind(target) : value;
    } });
  }

  endFrame(): void {
    const slot = this.recording;
    this.recording = null;
    if (!slot) return;
    const count = slot.passes.length * 2;
    if (!count) { slot.state = "idle"; this.results.push({ frame: slot.frame, ms: null }); return; }
    // Every timestamp was written by an earlier submission of this frame, so
    // one command resolves them all.
    const encoder = this.device.createCommandEncoder();
    encoder.resolveQuerySet(slot.querySet, 0, count, slot.resolve, 0);
    encoder.copyBufferToBuffer(slot.resolve, 0, slot.readback, 0, count * 8);
    this.device.queue.submit([encoder.finish()]);
    slot.state = "reading";
    const { frame, passes } = slot;
    const mapRead = (globalThis as any).GPUMapMode?.READ ?? 1;
    slot.readback.mapAsync(mapRead, 0, count * 8).then(() => {
      const times = new BigUint64Array(slot.readback.getMappedRange(0, count * 8).slice(0));
      slot.readback.unmap();
      if (!slot.cancelled) this.results.push(frameResult(frame, passes, times));
    }, () => {
      if (!slot.cancelled) this.results.push({ frame, ms: null });
    }).finally(() => { slot.state = "idle"; });
  }

  takeResults(): readonly ExternalGpuFrameResult[] {
    return this.results.splice(0);
  }

  cancel(): number {
    let cancelled = 0;
    for (const slot of this.slots) {
      if (slot.state === "idle" || slot.cancelled) continue;
      slot.cancelled = true; cancelled++;
      if (slot.state === "recording") slot.state = "idle";
    }
    this.recording = null;
    this.results.length = 0;
    return cancelled;
  }

  dispose(): void {
    this.cancel();
    for (const slot of this.slots) {
      slot.querySet.destroy?.(); slot.resolve.destroy?.();
      // A buffer still mapping resolves its promise as an error once destroyed.
      slot.readback.destroy?.();
    }
    this.slots.length = 0;
  }

  private beginPass(encoder: any, slot: FrameSlot, descriptor: any): any {
    if (slot.state !== "recording" || slot.passes.length >= MAX_PASSES) return encoder.beginRenderPass(descriptor);
    const index = slot.passes.length * 2;
    const pass: TimedPass = { label: descriptor.label ?? "pass", draws: 0 };
    slot.passes.push(pass);
    const encoded = encoder.beginRenderPass({ ...descriptor, timestampWrites: { querySet: slot.querySet,
      beginningOfPassWriteIndex: index, endOfPassWriteIndex: index + 1 } });
    return new Proxy(encoded, { get: (target, key) => {
      const value = target[key];
      if (typeof value !== "function") return value;
      if (key === "draw" || key === "drawIndexed" || key === "drawIndirect" || key === "drawIndexedIndirect") {
        return (...args: unknown[]) => { pass.draws++; return value.apply(target, args); };
      }
      return value.bind(target);
    } });
  }

  private createSlot(): FrameSlot | null {
    try {
      const usage = (globalThis as any).GPUBufferUsage;
      const bytes = MAX_PASSES * 2 * 8;
      const slot: FrameSlot = {
        querySet: this.device.createQuerySet({ type: "timestamp", count: MAX_PASSES * 2 }),
        resolve: this.device.createBuffer({ size: bytes, usage: (usage?.QUERY_RESOLVE ?? 0x200) | (usage?.COPY_SRC ?? 0x04) }),
        readback: this.device.createBuffer({ size: bytes, usage: (usage?.MAP_READ ?? 0x01) | (usage?.COPY_DST ?? 0x08) }),
        frame: 0, passes: [], state: "idle", cancelled: false
      };
      this.slots.push(slot);
      return slot;
    } catch { return null; }
  }
}

/** A frame's span and passes from its resolved timestamps, in nanoseconds. */
function frameResult(frame: number, passes: readonly TimedPass[], times: BigUint64Array): ExternalGpuFrameResult {
  let first = Infinity, last = -Infinity;
  const operations: GpuOperationDetail[] = [];
  for (let index = 0; index < passes.length; index++) {
    const begin = Number(times[index * 2]), end = Number(times[index * 2 + 1]);
    // A pass the GPU skipped writes nothing; reversed times are unusable.
    if (!(begin > 0) || !(end >= begin)) return { frame, ms: null };
    first = Math.min(first, begin); last = Math.max(last, end);
    const label = passes[index].label;
    operations.push({ label, ms: (end - begin) / 1_000_000, order: index, call: "renderPass", vertices: null,
      instances: passes[index].draws, pixels: null, target: label === "frame" ? "screen" : "offscreen",
      viewport: [0, 0], scissor: null });
  }
  return { frame, ms: (last - first) / 1_000_000, operations };
}
