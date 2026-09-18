import type { VectorScene } from "./pdfVectorExtractor";
import type { PrimitiveColorUpdate } from "./primitiveAppearance";
import { primitiveRefKey } from "./primitiveAppearance";
import { validatePrimitiveRef } from "./scenePrimitives";

export interface PrimitiveColorTexel {
  kind: "stroke" | "fillB" | "fillC" | "text";
  index: number;
  pixels: Float32Array | Uint8Array;
}

export interface PrimitiveColorRow extends PrimitiveColorTexel {
  count: number;
}

/** Merge only adjacent changed texels on one texture row, keeping sparse storage. */
export function coalescePrimitiveColorTexels(
  patches: readonly PrimitiveColorTexel[],
  widths: Readonly<Record<PrimitiveColorTexel["kind"], number>>
): PrimitiveColorRow[] {
  const groups = new Map<PrimitiveColorTexel["kind"], Map<number, PrimitiveColorTexel>>();
  for (const patch of patches) {
    let group = groups.get(patch.kind);
    if (!group) groups.set(patch.kind, group = new Map());
    // Repeated references within one batch use their last requested color.
    group.set(patch.index, patch);
  }
  const rows: PrimitiveColorRow[] = [];
  for (const [kind, group] of groups) {
    const sorted = [...group.values()].sort((a, b) => a.index - b.index);
    const width = widths[kind];
    for (let start = 0; start < sorted.length;) {
      const first = sorted[start];
      const row = Math.floor(first.index / width);
      let end = start + 1;
      while (end < sorted.length && sorted[end].index === sorted[end - 1].index + 1 &&
          Math.floor(sorted[end].index / width) === row) end++;
      const count = end - start;
      const pixels = count === 1 ? first.pixels : first.pixels instanceof Uint8Array
        ? new Uint8Array(count * 4) : new Float32Array(count * 4);
      if (count > 1) for (let index = start; index < end; index++) pixels.set(sorted[index].pixels, (index - start) * 4);
      rows.push({ kind, index: first.index, count, pixels });
      start = end;
    }
  }
  return rows;
}

/** Sparse renderer state; source scene arrays always remain untouched. */
export class NativePrimitiveColors {
  private readonly colors = new Map<string, PrimitiveColorUpdate>();
  readonly scene: VectorScene;
  constructor(scene: VectorScene) { this.scene = scene; }

  update(updates: readonly PrimitiveColorUpdate[]): PrimitiveColorTexel[] {
    for (const update of updates) {
      validatePrimitiveRef(this.scene, update.ref);
      if (update.ref.kind === "raster") throw new TypeError("Raster primitives cannot be recolored.");
      if (update.color && (update.color.length !== 3 || !update.color.every(value => Number.isFinite(value) && value >= 0 && value <= 1))) {
        throw new TypeError("Primitive colors must contain three normalized channels.");
      }
    }
    const patches = updates.flatMap(update => primitiveColorTexels(this.scene, update));
    for (const update of updates) {
      if (update.color) this.colors.set(primitiveRefKey(update.ref), { ref: { ...update.ref }, color: [...update.color] });
      else this.colors.delete(primitiveRefKey(update.ref));
    }
    return patches;
  }

  updates(): PrimitiveColorUpdate[] { return [...this.colors.values()]; }
  has(kind: PrimitiveColorUpdate["ref"]["kind"]): boolean {
    for (const update of this.colors.values()) if (update.ref.kind === kind) return true;
    return false;
  }
  gradient(kind: "gradient-fill" | "gradient-stroke", index: number): [number, number, number] | null {
    return this.colors.get(`${kind}:${index}`)?.color ?? null;
  }
}

export function primitiveColorTexels(scene: VectorScene, { ref, color }: PrimitiveColorUpdate): PrimitiveColorTexel[] {
  const offset = ref.index * 4;
  if (ref.kind === "stroke") {
    const pixels = scene.styles.slice(offset, offset + 4);
    if (color) pixels.set(color, 1);
    return [{ kind: "stroke", index: ref.index, pixels }];
  }
  if (ref.kind === "fill") {
    const b = scene.fillPathMetaB.slice(offset, offset + 4);
    const c = scene.fillPathMetaC.slice(offset, offset + 4);
    if (color) { b[2] = color[0]; b[3] = color[1]; c[2] = color[2]; }
    return [{ kind: "fillB", index: ref.index, pixels: b }, { kind: "fillC", index: ref.index, pixels: c }];
  }
  if (ref.kind === "text") {
    const pixels = new Uint8Array(4);
    for (let channel = 0; channel < 4; channel++) {
      const value = channel < 3 && color ? color[channel] : scene.textInstanceC[offset + channel];
      pixels[channel] = Math.round(Math.max(0, Math.min(1, value)) * 255);
    }
    return [{ kind: "text", index: ref.index, pixels }];
  }
  return [];
}

/** One uniform per overridden gradient paint, plus a lazily shared disabled value. */
export class WebGpuPrimitiveGradientColors {
  private readonly entries = new Map<string, { buffer: any; bindGroup: any }>();
  private readonly device: any;
  private readonly layout: any;
  constructor(device: any, layout: any) { this.device = device; this.layout = layout; }

  update(updates: readonly PrimitiveColorUpdate[]): void {
    for (const { ref, color } of updates) {
      if (ref.kind !== "gradient-fill" && ref.kind !== "gradient-stroke") continue;
      const key = primitiveRefKey(ref);
      const previous = this.entries.get(key);
      if (!color) { previous?.buffer.destroy(); this.entries.delete(key); continue; }
      const entry = previous ?? this.createEntry();
      this.device.queue.writeBuffer(entry.buffer, 0, new Float32Array([...color, 1]));
      this.entries.set(key, entry);
    }
  }

  bindGroup(kind: "gradient-fill" | "gradient-stroke", index: number): any {
    const entry = this.entries.get(`${kind}:${index}`);
    if (entry) return entry.bindGroup;
    let fallback = this.entries.get("default");
    if (!fallback) { fallback = this.createEntry(); this.entries.set("default", fallback); }
    return fallback.bindGroup;
  }

  dispose(): void { for (const entry of this.entries.values()) entry.buffer.destroy(); this.entries.clear(); }

  private createEntry(): { buffer: any; bindGroup: any } {
    const usage = (globalThis as any).GPUBufferUsage;
    const buffer = this.device.createBuffer({ size: 16, usage: usage.UNIFORM | usage.COPY_DST });
    const bindGroup = this.device.createBindGroup({ layout: this.layout, entries: [{ binding: 0, resource: { buffer } }] });
    return { buffer, bindGroup };
  }
}
