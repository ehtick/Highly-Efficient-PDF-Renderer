import { createEmptyVectorScene } from "./emptyVectorScene";
import type { Bounds, VectorScene } from "./pdfVectorExtractor";
import { normalizePrimitiveColor, type PrimitiveColorInput } from "./primitiveAppearance";

/** A point in scene coordinates (X right, Y up). */
export type StrokeScenePoint = readonly [number, number];

export interface StrokeSceneStyle {
  /** sRGB hex/name, 0xRRGGBB, or normalized RGB tuple. Defaults to black. */
  color?: PrimitiveColorInput;
  /** Full width in scene units. Zero is a device-pixel hairline. Defaults to 1. */
  width?: number;
}

export interface StrokeScenePolyline extends StrokeSceneStyle {
  /** Point tuples, or flat typed-array coordinates [x0, y0, x1, y1, ...]. */
  points: readonly StrokeScenePoint[] | Float32Array | Float64Array;
  /** Connect the last point to the first. Defaults to false. */
  closed?: boolean;
}

const STROKE_STYLE_FLAG_HAIRLINE = 1;
const STROKE_STYLE_FLAG_ROUND_CAP = 2;
const STROKE_STYLE_FLAG_OFFSET = 2;
// Segment IDs travel through float32 GPU attributes.
const MAX_SEGMENTS = 16_777_216;

/**
 * Compile opaque, solid polylines into a renderable scene without parsing a PDF.
 * Strokes have round caps and round joins. Each polyline can override the
 * default color/width. Input data is copied; treat the returned scene as immutable.
 * Consecutive points equal after float32 conversion are discarded and counted
 * in discardedDegenerateCount. Empty input returns a valid empty scene.
 *
 * Pass the result to the public createThreePdfObject(scene, options) factory.
 * Internal buffer layouts are not part of this builder's compatibility contract.
 */
export function buildStrokeScene(
  polylines: readonly StrokeScenePolyline[],
  defaults: StrokeSceneStyle = {}
): VectorScene {
  if (!Array.isArray(polylines)) throw new TypeError("Polylines must be an array.");
  const defaultColor = normalizePrimitiveColor(defaults.color ?? 0x000000);
  const defaultWidth = readWidth(defaults.width ?? 1);
  let capacity = 0;
  const paths = polylines.map((polyline, index) => {
    const points = polyline?.points;
    const flat = points instanceof Float32Array || points instanceof Float64Array;
    if (!flat && !Array.isArray(points)) {
      throw new TypeError(`Polyline ${index} points must be tuples or a float typed array.`);
    }
    if (flat && points.length % 2 !== 0) {
      throw new TypeError(`Polyline ${index} must contain pairs of coordinates.`);
    }
    if (polyline.closed !== undefined && typeof polyline.closed !== "boolean") {
      throw new TypeError(`Polyline ${index} closed must be a boolean.`);
    }
    const count = flat ? points.length / 2 : points.length;
    for (let i = 0; i < count; i += 1) {
      if (!flat && (!Array.isArray(points[i]) || (points[i] as StrokeScenePoint).length !== 2)) {
        throw new TypeError(`Polyline ${index} point ${i} must be an [x, y] tuple.`);
      }
      readCoordinate(points, flat, i, 0);
      readCoordinate(points, flat, i, 1);
    }
    const close = polyline.closed === true && count > 1 && (
      readCoordinate(points, flat, 0, 0) !== readCoordinate(points, flat, count - 1, 0) ||
      readCoordinate(points, flat, 0, 1) !== readCoordinate(points, flat, count - 1, 1)
    );
    const segments = Math.max(0, count - 1) + Number(close);
    capacity += segments;
    if (capacity > MAX_SEGMENTS) throw new RangeError(`Stroke scenes support at most ${MAX_SEGMENTS} segments.`);
    return {
      points, flat, count, segments,
      width: polyline.width === undefined ? defaultWidth : readWidth(polyline.width),
      color: polyline.color === undefined ? defaultColor : normalizePrimitiveColor(polyline.color)
    };
  });

  const scene = createEmptyVectorScene();
  const endpoints = new Float32Array(capacity * 4);
  const primitiveMeta = new Float32Array(capacity * 4);
  const primitiveBounds = new Float32Array(capacity * 4);
  const styles = new Float32Array(capacity * 4);
  const bounds: Bounds = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
  for (const path of paths) {
    const halfWidth = Math.fround(path.width * 0.5);
    const flags = STROKE_STYLE_FLAG_ROUND_CAP | (path.width === 0 ? STROKE_STYLE_FLAG_HAIRLINE : 0);
    const firstSegment = scene.segmentCount;
    for (let i = 0; i < path.segments; i += 1) {
      const next = (i + 1) % path.count;
      const x0 = readCoordinate(path.points, path.flat, i, 0);
      const y0 = readCoordinate(path.points, path.flat, i, 1);
      const x1 = readCoordinate(path.points, path.flat, next, 0);
      const y1 = readCoordinate(path.points, path.flat, next, 1);
      if (x0 === x1 && y0 === y1) {
        scene.discardedDegenerateCount += 1;
        continue;
      }
      const offset = scene.segmentCount * 4;
      const minX = Math.min(x0, x1), minY = Math.min(y0, y1);
      const maxX = Math.max(x0, x1), maxY = Math.max(y0, y1);
      writeFloat4(endpoints, offset, x0, y0, x1, y1);
      writeFloat4(primitiveMeta, offset, x1, y1, 0, 1 + flags * STROKE_STYLE_FLAG_OFFSET);
      writeFloat4(primitiveBounds, offset, minX, minY, maxX, maxY);
      writeFloat4(styles, offset, halfWidth, path.color[0], path.color[1], path.color[2]);
      bounds.minX = Math.min(bounds.minX, minX - halfWidth);
      bounds.minY = Math.min(bounds.minY, minY - halfWidth);
      bounds.maxX = Math.max(bounds.maxX, maxX + halfWidth);
      bounds.maxY = Math.max(bounds.maxY, maxY + halfWidth);
      scene.segmentCount += 1;
    }
    if (scene.segmentCount > firstSegment) {
      scene.pathCount += 1;
      scene.maxHalfWidth = Math.max(scene.maxHalfWidth, halfWidth);
    }
  }
  const length = scene.segmentCount * 4;
  scene.endpoints = length === endpoints.length ? endpoints : endpoints.slice(0, length);
  scene.primitiveMeta = length === primitiveMeta.length ? primitiveMeta : primitiveMeta.slice(0, length);
  scene.primitiveBounds = length === primitiveBounds.length ? primitiveBounds : primitiveBounds.slice(0, length);
  scene.styles = length === styles.length ? styles : styles.slice(0, length);
  scene.sourceSegmentCount = capacity;
  scene.mergedSegmentCount = capacity;
  scene.imageLayerSegmentCount = 0;
  if (scene.segmentCount > 0) {
    // Give horizontal/vertical hairline-only scenes a usable page rectangle.
    if (bounds.minX === bounds.maxX) { bounds.minX -= 0.5; bounds.maxX += 0.5; }
    if (bounds.minY === bounds.maxY) { bounds.minY -= 0.5; bounds.maxY += 0.5; }
    for (const value of Object.values(bounds)) {
      if (!Number.isFinite(Math.fround(value))) throw new RangeError("Stroke bounds exceed float32 range.");
    }
    scene.bounds = bounds;
    scene.pageCount = 1;
    scene.pageRects = new Float32Array([bounds.minX, bounds.minY, bounds.maxX, bounds.maxY]);
    scene.pageBounds = {
      minX: scene.pageRects[0], minY: scene.pageRects[1],
      maxX: scene.pageRects[2], maxY: scene.pageRects[3]
    };
    scene.pageTextRanges = new Uint32Array([0, 0]);
  }
  return scene;
}

function readCoordinate(points: StrokeScenePolyline["points"], flat: boolean, index: number, axis: 0 | 1): number {
  const value = flat ? points[index * 2 + axis] as number : (points[index] as StrokeScenePoint)[axis];
  if (typeof value !== "number" || !Number.isFinite(value) || !Number.isFinite(Math.fround(value))) {
    throw new TypeError("Stroke coordinates must be finite float32-representable numbers.");
  }
  return Math.fround(value);
}

function readWidth(width: number): number {
  if (!Number.isFinite(width) || width < 0 || !Number.isFinite(Math.fround(width)) ||
      (width > 0 && Math.fround(width * 0.5) === 0)) {
    throw new RangeError("Stroke width must be a nonnegative float32-representable number.");
  }
  return width;
}

function writeFloat4(target: Float32Array, offset: number, a: number, b: number, c: number, d: number): void {
  target[offset] = a;
  target[offset + 1] = b;
  target[offset + 2] = c;
  target[offset + 3] = d;
}
