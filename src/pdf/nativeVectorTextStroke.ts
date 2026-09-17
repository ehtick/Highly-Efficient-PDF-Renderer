import type { DensePdfCompiledPage, DensePdfVectorSceneData, DensePdfBounds } from "./nativeContentCompiler";
import type { NativePdfFont } from "./nativeFont";
import type { NativeTextCompilation } from "./nativeText";
import { buildNativeGlyphStroke } from "./nativeGlyphStroke";
import { PdfError, throwIfAborted } from "./nativeTypes";

export interface NativeStrokeTextStores {
  instanceA: Float32Array;
  instanceB: Float32Array;
  instanceC: Float32Array;
  glyphMetaA: Float32Array;
  glyphMetaB: Float32Array;
  glyphSegmentsA: Float32Array;
  glyphSegmentsB: Float32Array;
}

/** Stroke glyphs become filled vector outlines in the text stores, including overlapping joins. */
export function buildNativeVectorTextStrokes(
  compiled: DensePdfCompiledPage,
  sidecar: DensePdfVectorSceneData,
  text: NativeTextCompilation,
  stores: NativeStrokeTextStores,
  fonts: readonly NativePdfFont[],
  pageBounds: DensePdfBounds,
  maxPaths: number,
  maxCoordinates: number,
  signal?: AbortSignal
): { glyphToInstance: Int32Array | null; approximated: boolean } {
  if (!sidecar.glyphStrokePaints?.some(paint => paint && paint.color[3] > 1e-3)) {
    return { glyphToInstance: null, approximated: false };
  }
  const glyphToInstance = new Int32Array(text.glyphs.glyphIds.length).fill(-1);
  const metaA: number[] = [], metaB: number[] = [];
  const instanceA: number[] = [], instanceB: number[] = [], instanceC: number[] = [];
  const segmentsA: number[] = [], segmentsB: number[] = [];
  let approximated = false;
  for (let run = 0; run < sidecar.glyphRunMeta.length / 3; run++) {
    const stroke = sidecar.glyphStrokePaints[run];
    if (!stroke || stroke.color[3] <= 1e-3) continue;
    const first = sidecar.glyphRunMeta[run * 3], end = first + sidecar.glyphRunMeta[run * 3 + 1];
    const clip = sidecar.glyphClipBounds?.subarray(run * 4, run * 4 + 4);
    for (let glyph = first; glyph < end; glyph++) {
      throwIfAborted(signal);
      if ((text.glyphs.flags[glyph] & (1 << 2)) !== 0) {
        throw new PdfError("unsupported-content", "Type3 stroked text requires its glyph program.");
      }
      const font = fonts[text.glyphs.fontIndices[glyph]];
      const outline = font.getGlyphOutline(text.glyphs.glyphIds[glyph]);
      const transform = text.glyphs.transformIndices[glyph] * 6;
      const geometry = buildNativeGlyphStroke(outline.commands,
        text.transforms.values.subarray(transform, transform + 6), stroke, signal);
      if (!geometry) continue;
      const bounds = {
        minX: Math.max(geometry.bounds.minX, pageBounds.minX, clip?.[0] ?? -Infinity),
        minY: Math.max(geometry.bounds.minY, pageBounds.minY, clip?.[1] ?? -Infinity),
        maxX: Math.min(geometry.bounds.maxX, pageBounds.maxX, clip?.[2] ?? Infinity),
        maxY: Math.min(geometry.bounds.maxY, pageBounds.maxY, clip?.[3] ?? Infinity)
      };
      if (bounds.maxX <= bounds.minX || bounds.maxY <= bounds.minY) continue;
      const pathCount = metaA.length / 4;
      if (compiled.pathCount + stores.glyphMetaA.length / 4 + pathCount + 1 > maxPaths ||
          compiled.fillSegmentsA.length + compiled.fillSegmentsB.length + compiled.endpoints.length +
            stores.glyphSegmentsA.length + stores.glyphSegmentsB.length +
            segmentsA.length + segmentsB.length + geometry.segmentsA.length + geometry.segmentsB.length > maxCoordinates) {
        throw new PdfError("resource-limit", "Outlined text exceeds the page geometry limit.", {
          details: { reason: "vector-glyph-stroke-limit", maxPaths, maxCoordinates }
        });
      }
      glyphToInstance[glyph] = (stores.instanceA.length + instanceA.length) / 4;
      metaA.push((stores.glyphSegmentsA.length + segmentsA.length) / 4, geometry.segmentsA.length / 4, bounds.minX, bounds.minY);
      metaB.push(bounds.maxX, bounds.maxY, 0, 0);
      instanceA.push(1, 0, 0, 1);
      instanceB.push(0, 0, stores.glyphMetaA.length / 4 + pathCount, 0);
      instanceC.push(...stroke.color);
      segmentsA.push(...geometry.segmentsA);
      segmentsB.push(...geometry.segmentsB);
      approximated ||= geometry.approximated;
    }
  }
  const append = (base: Float32Array, added: number[]): Float32Array => {
    if (added.length === 0) return base;
    const result = new Float32Array(base.length + added.length);
    result.set(base); result.set(added, base.length);
    return result;
  };
  stores.instanceA = append(stores.instanceA, instanceA);
  stores.instanceB = append(stores.instanceB, instanceB);
  stores.instanceC = append(stores.instanceC, instanceC);
  stores.glyphMetaA = append(stores.glyphMetaA, metaA);
  stores.glyphMetaB = append(stores.glyphMetaB, metaB);
  stores.glyphSegmentsA = append(stores.glyphSegmentsA, segmentsA);
  stores.glyphSegmentsB = append(stores.glyphSegmentsB, segmentsB);
  return { glyphToInstance, approximated };
}
