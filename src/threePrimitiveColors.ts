import type * as THREE from "three";
import type { PrimitiveColorUpdate } from "./primitiveAppearance";

/** Patch the renderer's copy, never the immutable scene payload. */
export function patchPrimitiveColorTexture(
  texture: THREE.DataTexture,
  source: Float32Array | Uint8Array,
  updates: readonly PrimitiveColorUpdate[],
  kind: "stroke" | "fill" | "text",
  channels: readonly { source: number; target: number; component?: number }[]
): void {
  const target = texture.image.data as Float32Array | Uint8Array;
  const byteScale = target instanceof Uint8Array ? 255 : 1;
  let changed = false;
  for (const update of updates) {
    if (update.ref.kind !== kind) continue;
    const offset = update.ref.index * 4;
    channels.forEach((channel, index) => {
      const component = channel.component ?? index;
      target[offset + channel.target] = update.color
        ? (byteScale === 255 ? Math.round(update.color[component] * 255) : update.color[component])
        : (byteScale === 255 && !(source instanceof Uint8Array)
          ? Math.round(source[offset + channel.source] * 255)
          : source[offset + channel.source]);
    });
    changed = true;
  }
  // DataTexture updates may upload the complete texture on WebGPU.
  if (changed) texture.needsUpdate = true;
}
