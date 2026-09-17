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

/** One RGBA texel per node followed by its directed, page-space polygon edges. */
export function packVectorClips(clips: readonly VectorClipPath[] = []): Float32Array {
  const count = clips.reduce((total, clip) => total + clip.edges.length / 4, clips.length);
  if (count > MAX_VECTOR_CLIP_TEXELS) throw new RangeError("Vector clip storage exceeds its limit.");
  const data = new Float32Array(Math.max(1, count) * 4);
  let edgeOffset = clips.length;
  for (let index = 0; index < clips.length; index++) {
    const clip = clips[index];
    data.set([clip.parent, edgeOffset, clip.edges.length / 4, clip.fillRule], index * 4);
    data.set(clip.edges, edgeOffset * 4);
    edgeOffset += clip.edges.length / 4;
  }
  return data;
}
