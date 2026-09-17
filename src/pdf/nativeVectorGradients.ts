import { GRADIENT_LUT_WIDTH, type GradientSceneData } from "../orderedGradientPaint";
import type { DensePdfVectorShadingPaint } from "./nativeContentCompiler";
import type { NativePdfShadingRegistry } from "./nativeShadings";
import { DEFAULT_PDF_RESOURCE_LIMITS, PdfError, throwIfAborted } from "./nativeTypes";

/** Bound LUT storage to 16 MiB, independently of the ordinary path ceiling. */
const MAX_VECTOR_SHADING_PAINTS = 4096;

/** The current shader extends both ends; other PDF shading semantics retain fallback. */
export function supportedNativeVectorShadings(registry: NativePdfShadingRegistry): ReadonlySet<number> {
  const supported = new Set<number>();
  for (let index = 0; index < registry.size; index++) {
    const shading = registry.describe(index);
    const [x0, y0, x1, y1] = shading.coordinates;
    if (shading.shadingType === 2 && shading.extend[0] && shading.extend[1] &&
        shading.background === null && (x1 - x0) ** 2 + (y1 - y0) ** 2 > 1e-12) {
      supported.add(index);
    }
  }
  return supported;
}

/** Analytic geometry remains resolution independent; the color function uses the existing 1D LUT. */
export function buildNativeVectorGradients(
  paints: readonly DensePdfVectorShadingPaint[],
  registry: NativePdfShadingRegistry | undefined,
  maxPaths: number,
  signal?: AbortSignal,
  maxPathCoordinates = DEFAULT_PDF_RESOURCE_LIMITS.maxPathCoordinatesPerPage
): GradientSceneData {
  if (paints.length > Math.min(maxPaths, MAX_VECTOR_SHADING_PAINTS) || paints.length * 16 > maxPathCoordinates) {
    throw new PdfError("resource-limit", "Vector shading paints exceed their geometry or color-table storage limit.");
  }
  if (paints.length && !registry) throw new PdfError("invalid-object", "Vector shading paints have no resource registry.");
  const count = paints.length;
  // Every empty store shares this page-owned buffer, which can safely transfer to a worker caller.
  const empty = new Float32Array(0);
  if (!count) return { gradientCount: 0, gradientMetaA: empty, gradientMetaB: empty, gradientMetaC: empty,
    gradientMetaD: empty, gradientMetaE: empty, gradientLut: new Uint8Array(0), gradientFillPathCount: 0,
    gradientFillSegmentCount: 0, gradientFillPathMetaA: empty, gradientFillPathMetaB: empty,
    gradientFillPathMetaC: empty, gradientFillPaintMeta: empty, gradientFillSegmentsA: empty,
    gradientFillSegmentsB: empty, gradientStrokeRunCount: 0, gradientStrokeSegmentCount: 0,
    gradientStrokeRunMetaA: empty, gradientStrokeRunMetaB: empty, gradientStrokeEndpoints: empty,
    gradientStrokePrimitiveMeta: empty, gradientStrokePrimitiveBounds: empty, gradientStrokeStyles: empty };
  const gradientMetaA = new Float32Array(count * 4);
  const gradientMetaB = new Float32Array(count * 4);
  const gradientMetaC = new Float32Array(count * 4);
  const gradientMetaD = new Float32Array(count * 4);
  const gradientMetaE = new Float32Array(count * 4);
  const gradientLut = new Uint8Array(count * GRADIENT_LUT_WIDTH * 4);
  const gradientFillPathMetaA = new Float32Array(count * 4);
  const gradientFillPathMetaB = new Float32Array(count * 4);
  const gradientFillPathMetaC = new Float32Array(count * 4);
  const gradientFillPaintMeta = new Float32Array(count * 4);
  const gradientFillSegmentsA = new Float32Array(count * 16);
  const gradientFillSegmentsB = new Float32Array(count * 16);
  const supported = registry ? supportedNativeVectorShadings(registry) : new Set<number>();
  const sampled = new Map<number, Uint8Array>();
  for (let index = 0; index < count; index++) {
    throwIfAborted(signal);
    const paint = paints[index];
    if (!supported.has(paint.gradientIndex)) throw new PdfError("unsupported-content", "An unsupported shading reached the analytic vector renderer.");
    const shading = registry!.describe(paint.gradientIndex);
    const [a, b, c, d, e, f] = paint.transform;
    const det = a * d - b * c;
    const { minX, minY, maxX, maxY } = paint.clipBounds;
    if (![...paint.transform, minX, minY, maxX, maxY, paint.alpha, paint.paintOrder].every(Number.isFinite) ||
        !Number.isFinite(det) || Math.abs(det) <= 1e-12 || minX > maxX || minY > maxY || paint.alpha < 0 || paint.alpha > 1 ||
        !Number.isSafeInteger(paint.paintOrder) || paint.paintOrder < 0) {
      throw new PdfError("invalid-object", "Invalid native vector shading paint metadata.");
    }
    const offset = index * 4;
    // Transform scene points into shading space before projection: transforming
    // the axis alone would distort the gradient under a shear or nonuniform scale.
    gradientMetaA.set([0, shading.boundingBox ? 1 : 0, 0, 0], offset);
    gradientMetaB.set([d / det, -b / det, -c / det, a / det], offset);
    const inverseDet = gradientMetaB[offset] * gradientMetaB[offset + 3] -
      gradientMetaB[offset + 1] * gradientMetaB[offset + 2];
    if (!Number.isFinite(inverseDet) || Math.abs(inverseDet) <= 1e-12) {
      throw new PdfError("unsupported-content", "Native shading transformation exceeds the GPU precision range.");
    }
    gradientMetaC.set([(c * f - d * e) / det, (b * e - a * f) / det,
      shading.coordinates[0], shading.coordinates[1]], offset);
    gradientMetaD.set([shading.coordinates[2], shading.coordinates[3], 0, 0], offset);
    if (shading.boundingBox) gradientMetaE.set(shading.boundingBox, offset);

    let lut = sampled.get(paint.gradientIndex);
    if (!lut) {
      lut = new Uint8Array(GRADIENT_LUT_WIDTH * 4);
      const [start, end] = shading.domain;
      for (let sample = 0; sample < GRADIENT_LUT_WIDTH; sample++) {
        if ((sample & 63) === 0) throwIfAborted(signal);
        const parameter = start + (end - start) * sample / (GRADIENT_LUT_WIDTH - 1);
        const components = shading.functionIndex >= 0
          ? Array.from(registry!.functions.evaluate(shading.functionIndex, [parameter], signal))
          : shading.functionIndices.map(functionIndex => registry!.functions.evaluate(functionIndex, [parameter], signal)[0]);
        const rgb = registry!.colors.convertToSrgb(shading.colorSpaceIndex, components, signal);
        lut.set([Math.round(rgb[0] * 255), Math.round(rgb[1] * 255), Math.round(rgb[2] * 255), 255], sample * 4);
      }
      sampled.set(paint.gradientIndex, lut);
    }
    gradientLut.set(lut, index * GRADIENT_LUT_WIDTH * 4);
    gradientFillPathMetaA.set([index * 4, 4, minX, minY], offset);
    gradientFillPathMetaB.set([maxX, maxY, 0, 0], offset);
    gradientFillPathMetaC.set([0, 0, 0, paint.alpha], offset);
    gradientFillPaintMeta.set([index, -1, paint.paintOrder, 0], offset);
    gradientFillSegmentsA.set([
      minX, minY, maxX, minY, maxX, minY, maxX, maxY,
      maxX, maxY, minX, maxY, minX, maxY, minX, minY
    ], index * 16);
    gradientFillSegmentsB.set([
      maxX, minY, 0, 0, maxX, maxY, 0, 0,
      minX, maxY, 0, 0, minX, minY, 0, 0
    ], index * 16);
  }
  if (![gradientMetaB, gradientMetaC, gradientMetaD, gradientMetaE, gradientFillPathMetaA,
      gradientFillPathMetaB, gradientFillSegmentsA, gradientFillSegmentsB].every(array => array.every(Number.isFinite))) {
    throw new PdfError("unsupported-content", "Native shading geometry exceeds the finite GPU coordinate range.");
  }
  return { gradientCount: count, gradientMetaA, gradientMetaB, gradientMetaC, gradientMetaD, gradientMetaE, gradientLut,
    gradientFillPathCount: count, gradientFillSegmentCount: count * 4, gradientFillPathMetaA, gradientFillPathMetaB,
    gradientFillPathMetaC, gradientFillPaintMeta, gradientFillSegmentsA, gradientFillSegmentsB,
    gradientStrokeRunCount: 0, gradientStrokeSegmentCount: 0, gradientStrokeRunMetaA: empty,
    gradientStrokeRunMetaB: empty, gradientStrokeEndpoints: empty, gradientStrokePrimitiveMeta: empty,
    gradientStrokePrimitiveBounds: empty, gradientStrokeStyles: empty };
}
