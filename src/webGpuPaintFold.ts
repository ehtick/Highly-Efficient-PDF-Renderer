import { paintFoldMaskWeights } from "./nativePaintFold";
import type { ScenePaintMask } from "./scenePaintGraph";
import { GRADIENT_MASK_VECTORS } from "./gradientMaskFold";

/** Fold factors and weights, followed by the analytic gradient mask vectors. */
const FOLD_BYTES = 32 + GRADIENT_MASK_VECTORS * 16;

/**
 * Native WebGPU fold inputs (see `paintFoldFragmentWgsl`): a bind group of a
 * dynamic-offset uniform (opacity, masked, mask weights) and the mask surface,
 * for each foldable paint pipeline. Slot 0 of the uniform buffer holds the neutral
 * fold. Queue writes all land before a frame's commands run, so every fold
 * of a frame takes a slot of its own.
 */
export class WebGpuPaintFolds {
  readonly layout: any;
  private readonly device: any;
  private readonly stride: number;
  private buffer: any = null;
  private slots = 0;
  private nextSlot = 1;
  /** Outgrown buffers, which earlier folds of the frame still read. */
  private readonly retired: any[] = [];
  private neutral: { texture: any; view: any } | null = null;
  private groups = new WeakMap<object, { buffer: any; group: any }>();
  /** The fold the next foldable draw applies; null draws unfolded. */
  private current: { offset: number; mask: any } | null = null;

  constructor(device: any) {
    this.device = device;
    const fragment = (globalThis as any).GPUShaderStage?.FRAGMENT ?? 2;
    this.layout = device.createBindGroupLayout({ entries: [
      { binding: 0, visibility: fragment, buffer: { type: "uniform", hasDynamicOffset: true, minBindingSize: FOLD_BYTES } },
      { binding: 1, visibility: fragment, texture: { sampleType: "float" } }
    ] });
    const alignment = Math.max(256, Number(device.limits?.minUniformBufferOffsetAlignment) || 256);
    this.stride = Math.ceil(FOLD_BYTES / alignment) * alignment;
  }

  /** Every frame's folds take fresh slots; buffers outgrown last frame are no longer in flight. */
  beginFrame(): void {
    this.nextSlot = 1;
    for (const buffer of this.retired) buffer.destroy();
    this.retired.length = 0;
  }

  /**
   * Applies a group chain's opacity and mask surface view (or null) to the
   * draws until `end`. `content` is the soft mask whose rendered content the
   * mask surface holds, when it was not converted first. With `gradient`,
   * `mask` is the LUT view and the paint computes the mask at each fragment.
   */
  begin(opacity: number, mask: any, content?: ScenePaintMask, gradient?: Float32Array): void {
    const slot = this.nextSlot++;
    this.ensure(slot + 1);
    const offset = slot * this.stride;
    const [red, green, blue, alpha, bias] = paintFoldMaskWeights(content);
    const values = new Float32Array(FOLD_BYTES / 4);
    values.set([opacity, gradient ? 2 : mask ? 1 : 0, bias, 0, red, green, blue, alpha]);
    if (gradient) values.set(gradient, 8);
    this.device.queue.writeBuffer(this.buffer, offset, values);
    this.current = { offset, mask };
  }

  end(): void { this.current = null; }

  /** Binds the current fold, or the neutral one, to a foldable paint pipeline's `group`. */
  bind(pass: any, group: number): void {
    this.ensure(1);
    const fold = this.current;
    const view = fold?.mask ?? this.neutral!.view;
    let entry = this.groups.get(view);
    if (!entry || entry.buffer !== this.buffer) {
      entry = { buffer: this.buffer, group: this.device.createBindGroup({ layout: this.layout, entries: [
        { binding: 0, resource: { buffer: this.buffer, size: FOLD_BYTES } },
        { binding: 1, resource: view }
      ] }) };
      this.groups.set(view, entry);
    }
    pass.setBindGroup(group, entry.group, [fold?.offset ?? 0]);
  }

  dispose(): void {
    this.buffer?.destroy(); this.buffer = null; this.slots = 0;
    this.beginFrame();
    this.neutral?.texture.destroy(); this.neutral = null;
    this.groups = new WeakMap();
  }

  private ensure(slots: number): void {
    if (!this.neutral) {
      const usage = (globalThis as any).GPUTextureUsage;
      const texture = this.device.createTexture({ size: [1, 1], format: "rgba8unorm",
        usage: (usage?.TEXTURE_BINDING ?? 4) | (usage?.COPY_DST ?? 2) });
      this.device.queue.writeTexture({ texture }, Uint8Array.of(255, 255, 255, 255), { bytesPerRow: 4 }, [1, 1]);
      this.neutral = { texture, view: texture.createView() };
    }
    if (this.buffer && this.slots >= slots) return;
    if (this.buffer) this.retired.push(this.buffer);
    this.slots = Math.max(64, this.slots * 2, slots);
    const usage = (globalThis as any).GPUBufferUsage;
    this.buffer = this.device.createBuffer({ size: this.slots * this.stride,
      usage: (usage?.UNIFORM ?? 0x40) | (usage?.COPY_DST ?? 0x08) });
    this.device.queue.writeBuffer(this.buffer, 0, new Float32Array(FOLD_BYTES / 4).fill(1, 0, 1));
  }
}
