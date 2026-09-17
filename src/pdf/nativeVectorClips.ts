import type { DensePdfBounds, DensePdfMatrix, DensePdfTextClip } from "./nativeContentCompiler";
import type { VectorClipPath } from "../pdfVectorExtractor";
import { MAX_VECTOR_CLIP_DEPTH, MAX_VECTOR_CLIP_EDGES, MAX_VECTOR_CLIP_TEXELS } from "../vectorClips";
import { PdfError, throwIfAborted } from "./nativeTypes";

export function rectangleVectorClip(bounds: Readonly<DensePdfBounds>, transform: DensePdfMatrix,
  parent: DensePdfTextClip | null): DensePdfTextClip {
  const { minX, minY, maxX, maxY } = bounds;
  return { parent, fillRule: 0, path: { data: new Float32Array([
    0, minX, minY, 1, maxX, minY, 1, maxX, maxY, 1, minX, maxY, 4
  ]), transform, bounds } };
}

/** Clip curves use a bounded vector approximation; painted glyphs/paths stay untouched. */
export class NativeVectorClipBuilder {
  readonly paths: VectorClipPath[] = [];
  approximatedCurves = false;
  private readonly ids = new Map<DensePdfTextClip, number>();
  private readonly shapes = new Map<string, number>();
  private texelCount = 0;

  add(clip: DensePdfTextClip | null | undefined, signal?: AbortSignal, depth = 0): number | undefined {
    if (!clip) return undefined;
    throwIfAborted(signal);
    if (depth >= MAX_VECTOR_CLIP_DEPTH) throw new PdfError("resource-limit", "Vector clip nesting exceeds its limit.");
    const existing = this.ids.get(clip);
    if (existing !== undefined) return existing;
    const parent = this.add(clip.parent, signal, depth + 1) ?? -1;
    const edges: number[] = [];
    const data = clip.path.data;
    const [a, b, c, d, e, f] = clip.path.transform;
    const point = (offset: number): [number, number] => [
      a * data[offset] + c * data[offset + 1] + e, b * data[offset] + d * data[offset + 1] + f
    ];
    let x = 0, y = 0, sx = 0, sy = 0, open = false;
    const line = (nx: number, ny: number): void => {
      if (x === nx && y === ny) return;
      if (edges.length >= MAX_VECTOR_CLIP_EDGES * 4) throw new PdfError("unsupported-content",
        "A vector clip exceeds the bounded edge representation.", { details: { reason: "vector-clip-edge-limit" } });
      if ((edges.length & 1023) === 0) throwIfAborted(signal);
      edges.push(x, y, nx, ny); x = nx; y = ny;
    };
    const cubic = (x0: number, y0: number, x1: number, y1: number, x2: number, y2: number,
      x3: number, y3: number, level = 0): void => {
      // Distance to the endpoint segment bounds the complete Bezier control hull.
      const distance = (px: number, py: number): number => {
        const dx = x3 - x0, dy = y3 - y0;
        const t = Math.max(0, Math.min(1, ((px - x0) * dx + (py - y0) * dy) / (dx * dx + dy * dy || 1)));
        return Math.hypot(px - x0 - t * dx, py - y0 - t * dy);
      };
      if (Math.max(distance(x1, y1), distance(x2, y2)) <= 0.0001) { line(x3, y3); return; }
      if (level >= 20) throw new PdfError("unsupported-content", "A vector clip curve exceeds its subdivision limit.",
        { details: { reason: "vector-clip-curve-limit" } });
      const ax = (x0 + x1) / 2, ay = (y0 + y1) / 2, bx = (x1 + x2) / 2, by = (y1 + y2) / 2;
      const cx = (x2 + x3) / 2, cy = (y2 + y3) / 2, dx = (ax + bx) / 2, dy = (ay + by) / 2;
      const ex = (bx + cx) / 2, ey = (by + cy) / 2, mx = (dx + ex) / 2, my = (dy + ey) / 2;
      cubic(x0, y0, ax, ay, dx, dy, mx, my, level + 1);
      cubic(mx, my, ex, ey, cx, cy, x3, y3, level + 1);
    };
    for (let offset = 0; offset < data.length;) {
      const op = data[offset++];
      if (op === 0) {
        if (open) line(sx, sy);
        [x, y] = point(offset); sx = x; sy = y; offset += 2; open = true;
      } else if (op === 1) { line(...point(offset)); offset += 2; open = true; }
      else if (op === 2) {
        this.approximatedCurves = true;
        cubic(x, y, ...point(offset), ...point(offset + 2), ...point(offset + 4)); offset += 6; open = true;
      } else if (op === 3) {
        this.approximatedCurves = true;
        const [cx, cy] = point(offset), [nx, ny] = point(offset + 2);
        cubic(x, y, x + (cx - x) * 2 / 3, y + (cy - y) * 2 / 3,
          nx + (cx - nx) * 2 / 3, ny + (cy - ny) * 2 / 3, nx, ny); offset += 4; open = true;
      } else if (op === 4) { if (open) line(sx, sy); open = false; }
      else throw new PdfError("invalid-object", "Invalid vector clip path operator.");
    }
    if (open) line(sx, sy);
    const packedEdges = Float32Array.from(edges);
    const shapeKey = `${parent}:${clip.fillRule}:${packedEdges.join(",")}`;
    const sameShape = this.shapes.get(shapeKey);
    if (sameShape !== undefined) { this.ids.set(clip, sameShape); return sameShape; }
    const index = this.paths.length;
    this.texelCount += 1 + packedEdges.length / 4;
    if (this.texelCount > MAX_VECTOR_CLIP_TEXELS) {
      throw new PdfError("resource-limit", "Vector clip storage exceeds its limit.");
    }
    this.paths.push({ parent, fillRule: clip.fillRule, edges: packedEdges });
    this.shapes.set(shapeKey, index);
    this.ids.set(clip, index);
    return index;
  }
}
