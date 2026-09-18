import type { GradientSceneData } from "./orderedGradientPaint";

export interface GradientMeshTriangle {
  readonly points: readonly [{ x: number; y: number }, { x: number; y: number }, { x: number; y: number }];
  readonly colors: readonly [readonly number[], readonly number[], readonly number[]];
}

export function gradientMeshTriangleCount(scene: GradientSceneData, gradient: number): number {
  return scene.gradientMetaA[gradient * 4] === 2 ? (scene.gradientMeshRanges?.[gradient * 2 + 1] ?? 0) / 3 : 0;
}

export function getGradientMeshTriangle(scene: GradientSceneData, gradient: number, triangle: number): GradientMeshTriangle {
  const count = gradientMeshTriangleCount(scene, gradient);
  if (!Number.isSafeInteger(triangle) || triangle < 0 || triangle >= count) throw new RangeError("Mesh triangle index is out of range.");
  const points: Array<{ x: number; y: number }> = [], colors: number[][] = [];
  const first = scene.gradientMeshRanges![gradient * 2] + triangle * 3;
  const offset = gradient * 4, b = scene.gradientMetaB, c = scene.gradientMetaC;
  const det = b[offset] * b[offset + 3] - b[offset + 1] * b[offset + 2];
  for (let i = 0; i < 3; i++) {
    const vertex = scene.gradientMeshIndices![first + i];
    const x = scene.gradientMeshPositions![vertex * 2] - c[offset], y = scene.gradientMeshPositions![vertex * 2 + 1] - c[offset + 1];
    points.push({ x: (b[offset + 3] * x - b[offset + 2] * y) / det, y: (-b[offset + 1] * x + b[offset] * y) / det });
    colors.push(Array.from(scene.gradientMeshColors!.subarray(vertex * 4, vertex * 4 + 4)));
  }
  return { points: points as unknown as GradientMeshTriangle["points"], colors: colors as unknown as GradientMeshTriangle["colors"] };
}

/** Point is already transformed into shading coordinates. Later source triangles win on overlap. */
export function sampleGradientMeshChannel(scene: GradientSceneData, gradient: number, x: number, y: number, channel: number): number | null {
  const ranges = scene.gradientMeshRanges, positions = scene.gradientMeshPositions, colors = scene.gradientMeshColors, indices = scene.gradientMeshIndices;
  if (!ranges || !positions || !colors || !indices) return null;
  const first = ranges[gradient * 2], end = first + ranges[gradient * 2 + 1];
  for (let i = end - 3; i >= first; i -= 3) {
    const a = indices[i], b = indices[i + 1], c = indices[i + 2];
    const ax = positions[a * 2], ay = positions[a * 2 + 1], bx = positions[b * 2], by = positions[b * 2 + 1], cx = positions[c * 2], cy = positions[c * 2 + 1];
    const determinant = (by - cy) * (ax - cx) + (cx - bx) * (ay - cy);
    if (Math.abs(determinant) < 1e-15) continue;
    const u = ((by - cy) * (x - cx) + (cx - bx) * (y - cy)) / determinant;
    const v = ((cy - ay) * (x - cx) + (ax - cx) * (y - cy)) / determinant, w = 1 - u - v;
    if (u >= -1e-7 && v >= -1e-7 && w >= -1e-7)
      return colors[a * 4 + channel] * u + colors[b * 4 + channel] * v + colors[c * 4 + channel] * w;
  }
  return null;
}

/** Renderer-owned expanded vertex stream (xy/RGBA); canonical scene arrays remain shared and untouched. */
export function buildGradientMeshRenderData(scene: GradientSceneData): { vertices: Float32Array; ranges: Uint32Array } {
  const ranges = new Uint32Array(scene.gradientFillPathCount * 2);
  let count = 0;
  for (let i = 0; i < scene.gradientFillPathCount; i++) {
    const gradient = scene.gradientFillPaintMeta[i * 4];
    if (gradient >= 0) count += gradientMeshTriangleCount(scene, gradient) * 3;
  }
  const vertices = new Float32Array(count * 6);
  let offset = 0;
  for (let i = 0; i < scene.gradientFillPathCount; i++) {
    const gradient = scene.gradientFillPaintMeta[i * 4];
    const triangles = gradient >= 0 ? gradientMeshTriangleCount(scene, gradient) : 0;
    ranges.set([offset / 6, triangles * 3], i * 2);
    for (let j = 0; j < triangles; j++) {
      const triangle = getGradientMeshTriangle(scene, gradient, j);
      for (let k = 0; k < 3; k++) {
        vertices.set([triangle.points[k].x, triangle.points[k].y, ...triangle.colors[k]], offset);
        offset += 6;
      }
    }
  }
  return { vertices, ranges };
}
