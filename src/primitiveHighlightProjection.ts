import type { Bounds } from "./pdfVectorExtractor";

/** A conservative expansion bound using the inverse projected Jacobian at page corners. */
export function estimateHighlightLocalUnitsPerPixel(m: ArrayLike<number>, viewport: { width: number; height: number }, bounds: Bounds): number {
  let extent = 1e-6;
  for (const x of [bounds.minX, bounds.maxX]) for (const y of [bounds.minY, bounds.maxY]) {
    const w = m[3] * x + m[7] * y + m[15];
    if (w <= 1e-10) continue;
    const clipX = m[0] * x + m[4] * y + m[12];
    const clipY = m[1] * x + m[5] * y + m[13];
    const xx = (m[0] * w - clipX * m[3]) / (w * w) * viewport.width * 0.5;
    const xy = (m[4] * w - clipX * m[7]) / (w * w) * viewport.width * 0.5;
    const yx = (m[1] * w - clipY * m[3]) / (w * w) * viewport.height * 0.5;
    const yy = (m[5] * w - clipY * m[7]) / (w * w) * viewport.height * 0.5;
    const trace = xx * xx + xy * xy + yx * yx + yy * yy;
    const determinant = xx * yy - xy * yx;
    const largest = (trace + Math.sqrt(Math.max(0, trace * trace - 4 * determinant * determinant))) * 0.5;
    const inverseSmallest = Math.sqrt(largest) / Math.max(1e-12, Math.abs(determinant));
    if (Number.isFinite(inverseSmallest)) extent = Math.max(extent, inverseSmallest);
  }
  return extent;
}

