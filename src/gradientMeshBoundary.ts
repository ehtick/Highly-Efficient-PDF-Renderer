import type { GradientSceneData } from "./orderedGradientPaint";
import { gradientMeshTriangleCount } from "./gradientMesh";

/** Matches the maximum generated mesh; selection must not allocate an unbounded edge map. */
export const MAX_MESH_TRACE_TRIANGLES = 65536;

interface EdgeEvent { position: number; delta: number }
interface EdgeLine { axis: number; slope: number; offset: number; events: EdgeEvent[] }

/**
 * Trace a tessellation's boundary, ignoring color seams and triangle orientation.
 * Collinear shared edges cancel even when one side has additional subdivisions.
 * Exact source coordinates avoid welding nearby, distinct pieces of geometry.
 */
export function buildGradientMeshBoundary(scene: GradientSceneData, gradient: number): {
  edges: Float32Array; domainClip?: Float32Array;
} {
  const count = gradientMeshTriangleCount(scene, gradient);
  if (count > MAX_MESH_TRACE_TRIANGLES) throw new RangeError("Mesh highlighting exceeds its triangle budget.");
  const positions = scene.gradientMeshPositions!, indices = scene.gradientMeshIndices!;
  const first = scene.gradientMeshRanges![gradient * 2];
  const lines = new Map<string, EdgeLine>();
  const addEdge = (ax: number, ay: number, bx: number, by: number, orientation: number): void => {
    const dx = bx - ax, dy = by - ay;
    if (!dx && !dy) return;
    const axis = Math.abs(dx) >= Math.abs(dy) ? 0 : 1;
    const start = axis ? ay : ax, end = axis ? by : bx;
    const slope = axis ? dx / dy : dy / dx;
    // Always derive the intercept from the lesser endpoint to make reverse edges identical.
    const lesserOther = start < end ? (axis ? ax : ay) : (axis ? bx : by);
    const offset = lesserOther - slope * Math.min(start, end);
    const key = `${axis}:${slope}:${offset}`;
    let line = lines.get(key);
    if (!line) lines.set(key, line = { axis, slope, offset, events: [] });
    const sign = (end > start ? 1 : -1) * orientation;
    line.events.push({ position: Math.min(start, end), delta: sign }, { position: Math.max(start, end), delta: -sign });
  };
  for (let i = 0; i < count; i++) {
    const a = indices[first + i * 3] * 2, b = indices[first + i * 3 + 1] * 2, c = indices[first + i * 3 + 2] * 2;
    const ax = positions[a], ay = positions[a + 1], bx = positions[b], by = positions[b + 1], cx = positions[c], cy = positions[c + 1];
    const area = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
    if (!area) continue;
    const orientation = Math.sign(area);
    addEdge(ax, ay, bx, by, orientation);
    addEdge(bx, by, cx, cy, orientation);
    addEdge(cx, cy, ax, ay, orientation);
  }
  const i = gradient * 4, b = scene.gradientMetaB, c = scene.gradientMetaC;
  const determinant = b[i] * b[i + 3] - b[i + 1] * b[i + 2];
  const point = (x: number, y: number): [number, number] => {
    const px = x - c[i], py = y - c[i + 1];
    return [(b[i + 3] * px - b[i + 2] * py) / determinant, (-b[i + 1] * px + b[i] * py) / determinant];
  };
  const edges: number[] = [];
  for (const line of lines.values()) {
    line.events.sort((a, b) => a.position - b.position);
    let balance = 0, start = 0;
    for (let event = 0; event < line.events.length;) {
      const position = line.events[event].position;
      const previous = balance;
      do { balance += line.events[event++].delta; } while (event < line.events.length && line.events[event].position === position);
      if (!previous && balance) start = position;
      if (previous && !balance) {
        const a = line.axis ? point(line.slope * start + line.offset, start) : point(start, line.slope * start + line.offset);
        const b = line.axis ? point(line.slope * position + line.offset, position) : point(position, line.slope * position + line.offset);
        edges.push(...a, ...b);
      }
    }
  }
  let domainClip: Float32Array | undefined;
  if (scene.gradientMetaA[i + 1] >= 0.5) {
    const bounds = scene.gradientMetaE;
    const points = [point(bounds[i], bounds[i + 1]), point(bounds[i + 2], bounds[i + 1]),
      point(bounds[i + 2], bounds[i + 3]), point(bounds[i], bounds[i + 3])];
    domainClip = Float32Array.from(points.flatMap((p, index) => [...p, ...points[(index + 1) % 4]]));
  }
  return { edges: Float32Array.from(edges), ...(domainClip ? { domainClip } : {}) };
}
