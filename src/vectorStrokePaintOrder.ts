import type { VectorScene } from "./pdfVectorExtractor";

// Runtime metadata only: never serialized into a PDF/HEP scene.
const origins = new WeakMap<VectorScene, Uint32Array>();
const groups = new WeakMap<VectorScene, Uint32Array>();

export function strokePaintOrigins(scene: VectorScene): Uint32Array | undefined {
  if (!scene.drawRuns) return origins.get(scene);
  let result = origins.get(scene);
  if (!result) {
    result = Uint32Array.from({ length: scene.segmentCount }, (_, index) => index);
    origins.set(scene, result);
  }
  return result;
}

export function setStrokePaintOrigins(scene: VectorScene, values?: Uint32Array): void {
  if (values) origins.set(scene, values);
}

/** Merge only within one paint operation, clip, and consecutive opaque color. */
export function strokePaintGroups(scene: VectorScene): Uint32Array | undefined {
  if (!scene.drawRuns) return undefined;
  let result = groups.get(scene);
  if (result) return result;
  result = new Uint32Array(scene.segmentCount);
  for (const run of scene.drawRuns) {
    if (run.kind !== "stroke") continue;
    let group = run.first;
    for (let index = run.first; index < run.first + run.count; index++) {
      const offset = index * 4;
      const packed = scene.primitiveMeta[offset + 3];
      const alpha = packed - Math.floor(packed / 2 + 1e-6) * 2;
      if (index > run.first && (alpha < 0.999 || packed !== scene.primitiveMeta[offset - 1] ||
          scene.styles[offset + 1] !== scene.styles[offset - 3] ||
          scene.styles[offset + 2] !== scene.styles[offset - 2] ||
          scene.styles[offset + 3] !== scene.styles[offset - 1])) group = index;
      result[index] = group;
    }
  }
  groups.set(scene, result);
  return result;
}
