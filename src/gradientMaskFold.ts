import type { VectorDrawRun, VectorScene } from "./pdfVectorExtractor";
import type { PdfCompositeProjector } from "./scenePaintCompositor";

/** Native views use an axis-aligned projection. Scale it to the actual
 * composite resolution, including WebGPU's top-down fragment coordinates. */
export function nativeGradientMaskVectors(scene: VectorScene, run: VectorDrawRun, clip: number | undefined,
  project: PdfCompositeProjector | null, width: number, height: number,
  viewportWidth: number, viewportHeight: number, topDown: boolean): Float32Array | null {
  if (!project) return null;
  const rect = project({ minX: 0, minY: 0, maxX: 1, maxY: 1 });
  if (!rect) return null;
  const sx = width / viewportWidth, sy = height / viewportHeight, flip = topDown ? -1 : 1;
  return gradientMaskVectors(scene, run, clip, [rect.width * sx, 0, rect.x * sx,
    0, rect.height * sy * flip, topDown ? height - rect.y * sy : rect.y * sy, 0, 0, 1]);
}

/**
 * A soft mask made of one analytic gradient fill, which a folded paint then
 * computes at each of its fragments instead of reading a rendered surface:
 * - 0-2: rows of the homography from a fragment's pixel to gradient space;
 * - 3: the gradient's metadata A (type, bounded, extension flags, background);
 * - 4: its start and end points; 5: its start and end radii, the paint's
 *   alpha and the gradient's row in the colour table;
 * - 6: the gradient-space bounds a bounded gradient paints inside;
 * - 7-14: the half-planes, in pixels, whose intersection the paint covers:
 *   its outline and its own clip. Coverage is the product of
 *   `clamp(0.5 + dot(plane.xyz, (x, y, 1)), 0, 1)`; unused planes are (0, 0, 1).
 */
export const GRADIENT_MASK_VECTORS = 15;
export const GRADIENT_MASK_PLANES = 8;
const PLANE_BASE = 7;

/** Clip chains deeper than this are treated as cyclic. */
const MAX_CLIP_DEPTH = 256;

function clipChainIncludes(scene: VectorScene, from: number | undefined, clip: number): boolean {
  for (let index = from ?? -1, depth = 0; index >= 0 && depth < MAX_CLIP_DEPTH; depth++) {
    if (index === clip) return true;
    index = scene.clipPaths?.[index]?.parent ?? -1;
  }
  return false;
}

/**
 * Describes the soft mask that a gradient fill paints alone, for a folded
 * paint to compute at its fragments (see `GRADIENT_MASK_VECTORS`). Null
 * when that paint needs its rendered surface instead: a patch-mesh gradient,
 * a gradient under another gradient's mask, a curved or non-convex outline or
 * clip, a clip chain other than the folded paint's own plus one clip, or a
 * paint reaching behind the camera.
 *
 * The folded paint is already clipped by `foldedClip`'s chain, so only the
 * mask paint's clips beyond that chain count. `project` is a row-major 3×3
 * homography from scene coordinates to surface pixels, including the backend's
 * fragment-coordinate orientation.
 */
export function gradientMaskVectors(scene: VectorScene, maskRun: VectorDrawRun, foldedClip: number | undefined,
  project: readonly number[]): Float32Array | null {
  const path = maskRun.first, paint = scene.gradientFillPaintMeta, pathMetaA = scene.gradientFillPathMetaA;
  if (maskRun.kind !== "gradient-fill" || maskRun.count !== 1 || !paint || !pathMetaA || !scene.gradientFillPathMetaC ||
    path < 0 || path * 4 + 3 >= paint.length) return null;
  const gradient = paint[path * 4], g = gradient * 4;
  if (!(gradient >= 0 && gradient < scene.gradientCount) || paint[path * 4 + 1] >= 0) return null;
  const { gradientMetaA: a, gradientMetaB: b, gradientMetaC: c, gradientMetaD: d, gradientMetaE: e } = scene;
  if (!a || !b || !c || !d || !e || g + 3 >= a.length || a[g] > 1.5) return null;

  const polygons: number[][] = [];
  const outline: number[] = [];
  const segmentsA = scene.gradientFillSegmentsA, segmentsB = scene.gradientFillSegmentsB;
  for (let segment = pathMetaA[path * 4], end = segment + pathMetaA[path * 4 + 1]; segment < end; segment++) {
    const offset = segment * 4;
    if (!segmentsA || !segmentsB || offset + 3 >= segmentsA.length || segmentsB[offset + 2] >= 1) return null;
    outline.push(segmentsA[offset], segmentsA[offset + 1], segmentsB[offset], segmentsB[offset + 1]);
  }
  polygons.push(outline);
  const clipIndex = maskRun.clipIndex ?? -1;
  if (clipIndex >= 0 && !clipChainIncludes(scene, foldedClip, clipIndex)) {
    const clip = scene.clipPaths?.[clipIndex];
    if (!clip || (clip.parent >= 0 && !clipChainIncludes(scene, foldedClip, clip.parent))) return null;
    polygons.push(Array.from(clip.edges));
  }

  const pixel = (x: number, y: number): [number, number] | null => {
    const w = project[6] * x + project[7] * y + project[8];
    if (!(w > 1e-6)) return null;
    return [(project[0] * x + project[1] * y + project[2]) / w,
      (project[3] * x + project[4] * y + project[5]) / w];
  };

  const vectors = new Float32Array(GRADIENT_MASK_VECTORS * 4);
  let plane = PLANE_BASE;
  for (const edges of polygons) {
    // One closed convex loop, projected: a projection keeps a polygon convex
    // while it stays in front of the camera.
    const points: [number, number][] = [];
    for (let index = 0; index < edges.length; index += 4) {
      const from = pixel(edges[index], edges[index + 1]);
      const next = (index + 4) % edges.length;
      if (!from || Math.hypot(edges[index + 2] - edges[next], edges[index + 3] - edges[next + 1]) >
        1e-5 * (1 + Math.abs(edges[next]) + Math.abs(edges[next + 1]))) return null;
      points.push(from);
    }
    if (points.length < 3) return null;
    const centre = points.reduce((sum, point) => [sum[0] + point[0] / points.length, sum[1] + point[1] / points.length],
      [0, 0]);
    let turn = 0;
    for (let index = 0; index < points.length; index++) {
      const [x0, y0] = points[index], [x1, y1] = points[(index + 1) % points.length];
      const [x2, y2] = points[(index + 2) % points.length];
      const cross = (x1 - x0) * (y2 - y1) - (y1 - y0) * (x2 - x1);
      const scale = Math.hypot(x1 - x0, y1 - y0) * Math.hypot(x2 - x1, y2 - y1);
      if (Math.abs(cross) <= 1e-6 * scale) continue;
      if (turn && Math.sign(cross) !== turn) return null;
      turn = Math.sign(cross);
    }
    if (!turn) return null;
    for (let index = 0; index < points.length; index++) {
      const [x0, y0] = points[index], [x1, y1] = points[(index + 1) % points.length];
      const length = Math.hypot(x1 - x0, y1 - y0);
      if (length < 1e-9) continue;
      if (plane >= GRADIENT_MASK_VECTORS) return null;
      let nx = (y0 - y1) / length, ny = (x1 - x0) / length, offset = -(nx * x0 + ny * y0);
      // A convex loop's centre is inside whichever way it winds.
      if (nx * centre[0] + ny * centre[1] + offset < 0) { nx = -nx; ny = -ny; offset = -offset; }
      vectors.set([nx, ny, offset, 0], plane++ * 4);
    }
  }
  for (; plane < GRADIENT_MASK_VECTORS; plane++) vectors.set([0, 0, 1, 0], plane * 4);

  // Surface pixel to gradient space: the inverse projection, then the
  // gradient's own affine map from scene coordinates.
  const [p0, p1, p2, p3, p4, p5, p6, p7, p8] = project;
  const inverse = [p4 * p8 - p5 * p7, p2 * p7 - p1 * p8, p1 * p5 - p2 * p4,
    p5 * p6 - p3 * p8, p0 * p8 - p2 * p6, p2 * p3 - p0 * p5,
    p3 * p7 - p4 * p6, p1 * p6 - p0 * p7, p0 * p4 - p1 * p3];
  const determinant = p0 * inverse[0] + p1 * inverse[3] + p2 * inverse[6];
  if (!(Math.abs(determinant) > 0) || !Number.isFinite(determinant)) return null;
  for (let i = 0; i < 9; i++) inverse[i] /= determinant;
  const toGradient = [
    ...[0, 1, 2].map(i => b[g] * inverse[i] + b[g + 2] * inverse[i + 3] + c[g] * inverse[i + 6]),
    ...[0, 1, 2].map(i => b[g + 1] * inverse[i] + b[g + 3] * inverse[i + 3] + c[g + 1] * inverse[i + 6]),
    ...inverse.slice(6)
  ];
  const largest = Math.max(...toGradient.map(Math.abs));
  if (!(largest > 0) || !Number.isFinite(largest)) return null;
  // Rows of a row-major matrix, scaled for float precision; the shader divides it back out.
  for (let row = 0; row < 3; row++) {
    vectors.set([toGradient[row * 3] / largest, toGradient[row * 3 + 1] / largest, toGradient[row * 3 + 2] / largest, 0], row * 4);
  }
  vectors.set(a.subarray(g, g + 4), 12);
  vectors.set([c[g + 2], c[g + 3], d[g], d[g + 1]], 16);
  vectors.set([d[g + 2], d[g + 3], scene.gradientFillPathMetaC[path * 4 + 3], gradient], 20);
  vectors.set(e.subarray(g, g + 4), 24);
  return vectors;
}
