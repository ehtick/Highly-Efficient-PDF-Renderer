import type { VectorClipPath, VectorScene } from "./pdfVectorExtractor";

export const MAX_VECTOR_CLIP_EDGES = 8192;
export const MAX_VECTOR_CLIP_DEPTH = 64;
// Keep texel offsets exactly representable as floats and bound upload memory to 64 MiB.
export const MAX_VECTOR_CLIP_TEXELS = 4 * 1024 * 1024;

export function validateVectorClips(scene: VectorScene): void {
  const clips = scene.clipPaths;
  if (clips === undefined) return;
  if (!Array.isArray(clips)) throw new Error("Invalid vector clip paths.");
  const depths: number[] = [];
  let texels = clips.length;
  for (let index = 0; index < clips.length; index++) {
    const clip = clips[index];
    if (!clip || !Number.isInteger(clip.parent) || clip.parent < -1 || clip.parent >= index ||
        (clip.fillRule !== 0 && clip.fillRule !== 1) || !(clip.edges instanceof Float32Array) ||
        clip.edges.length % 4 !== 0 || clip.edges.length / 4 > MAX_VECTOR_CLIP_EDGES ||
        !clip.edges.every(Number.isFinite)) throw new Error("Invalid vector clip path.");
    const depth = clip.parent < 0 ? 1 : depths[clip.parent] + 1;
    if (depth > MAX_VECTOR_CLIP_DEPTH) throw new Error("Vector clip nesting exceeds its limit.");
    texels += clip.edges.length / 4;
    if (texels > MAX_VECTOR_CLIP_TEXELS) throw new Error("Vector clip storage exceeds its limit.");
    depths.push(depth);
  }
}

type ClipRectangle = [number, number, number, number];

function clipRectangle(edges: Float32Array): ClipRectangle | undefined {
  if (edges.length !== 16) return undefined;
  for (let offset = 0; offset < 16; offset += 4) {
    const next = (offset + 4) % 16;
    const vertical = edges[offset] === edges[offset + 2];
    const horizontal = edges[offset + 1] === edges[offset + 3];
    // Require a closed loop of four nonzero, alternating axis-aligned edges.
    // No tolerance: even a slight shear must retain polygon clipping.
    if (vertical === horizontal || vertical === (edges[next] === edges[next + 2]) ||
        edges[offset + 2] !== edges[next] || edges[offset + 3] !== edges[next + 1]) return undefined;
  }
  return [Math.min(edges[0], edges[8]), Math.min(edges[1], edges[9]),
    Math.max(edges[0], edges[8]), Math.max(edges[1], edges[9])];
}

/**
 * One RGBA header [parent, offset, edgeCount, fillRule] per original clip node.
 * A negative edgeCount stores one [minX, minY, maxX, maxY] texel instead of edges.
 * Consecutive rectangle ancestors are intersected once, preserving original node IDs.
 */
export function packVectorClips(clips: readonly VectorClipPath[] = []): Float32Array {
  const rawCount = clips.reduce((total, clip) => total + clip.edges.length / 4, clips.length);
  if (rawCount > MAX_VECTOR_CLIP_TEXELS) throw new RangeError("Vector clip storage exceeds its limit.");
  const rectangles: (ClipRectangle | undefined)[] = [];
  const parents = new Int32Array(clips.length);
  let count = clips.length;
  for (let index = 0; index < clips.length; index++) {
    const clip = clips[index];
    const rectangle = clipRectangle(clip.edges);
    const parentRectangle = rectangles[clip.parent];
    parents[index] = clip.parent;
    if (rectangle && parentRectangle) {
      rectangle[0] = Math.max(rectangle[0], parentRectangle[0]);
      rectangle[1] = Math.max(rectangle[1], parentRectangle[1]);
      rectangle[2] = Math.min(rectangle[2], parentRectangle[2]);
      rectangle[3] = Math.min(rectangle[3], parentRectangle[3]);
      parents[index] = parents[clip.parent];
    }
    rectangles.push(rectangle);
    count += rectangle ? 1 : clip.edges.length / 4;
  }
  const data = new Float32Array(Math.max(1, count) * 4);
  let edgeOffset = clips.length;
  for (let index = 0; index < clips.length; index++) {
    const clip = clips[index];
    const rectangle = rectangles[index];
    data.set([parents[index], edgeOffset, rectangle ? -1 : clip.edges.length / 4, clip.fillRule], index * 4);
    data.set(rectangle ?? clip.edges, edgeOffset * 4);
    edgeOffset += rectangle ? 1 : clip.edges.length / 4;
  }
  return data;
}
