import type { VectorScene } from "./pdfVectorExtractor";

interface StrokeLodStorageLevel {
  scene: VectorScene;
  segmentCount: number;
}

interface CombinedStrokeLodStorage {
  scene: VectorScene;
  offsets: readonly number[];
}

const combinedStores = new WeakMap<readonly StrokeLodStorageLevel[], CombinedStrokeLodStorage>();
const textureData = new WeakMap<Float32Array, Float32Array>();

/** A texture-ready immutable view, available only for owned combined stores. */
export function sharedVectorStrokeLodTextureData(source: Float32Array): Float32Array | undefined {
  return textureData.get(source);
}

/**
 * Immutable stroke storage shared by LOD selection and ordered rendering.
 * Derived levels become views into this store, instead of retaining a second
 * complete copy of every simplified stroke. Keep the caller's canonical scene
 * and its arrays untouched: picking, exports, and independent viewers own that
 * identity. Temporary colors belong to renderer-owned textures, never here.
 */
export function getCombinedVectorStrokeLodStorage(
  canonicalScene: VectorScene, levels: readonly StrokeLodStorageLevel[]
): CombinedStrokeLodStorage {
  const cached = combinedStores.get(levels);
  if (cached) return cached;
  const offsets: number[] = [];
  let count = 0;
  for (const level of levels) { offsets.push(count); count += level.segmentCount; }
  if (levels.length === 1 && levels[0].scene === canonicalScene) {
    const storage = { scene: canonicalScene, offsets };
    combinedStores.set(levels, storage);
    return storage;
  }
  const scene = { ...canonicalScene, segmentCount: count };
  // Match Three's square texture layout. One partial row of zeroes lets it
  // upload this immutable store directly instead of retaining four padded copies.
  const width = Math.max(1, Math.ceil(Math.sqrt(count)));
  const paddedCount = width * Math.max(1, Math.ceil(count / width));
  // Rebase one field at a time so each old derived allocation can be collected
  // before allocating the next combined field. Preserve every float bit.
  for (const key of ["endpoints", "primitiveMeta", "primitiveBounds", "styles"] as const) {
    const data = new Float32Array(paddedCount * 4);
    const values = data.subarray(0, count * 4);
    textureData.set(values, data);
    for (let index = 0; index < levels.length; index++) {
      const level = levels[index];
      values.set(level.scene[key], offsets[index] * 4);
    }
    scene[key] = values;
    for (let index = 0; index < levels.length; index++) {
      const level = levels[index];
      if (level.scene !== canonicalScene) {
        level.scene[key] = values.subarray(offsets[index] * 4, (offsets[index] + level.segmentCount) * 4);
      }
    }
  }
  const storage = { scene, offsets };
  combinedStores.set(levels, storage);
  return storage;
}
