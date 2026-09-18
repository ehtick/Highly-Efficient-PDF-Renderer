import * as THREE from "three";

const shapeUniforms = new WeakMap<THREE.Material, { value: number }>();

export function registerThreePdfShapeUniform(material: THREE.Material, uniform: { value: number }): void {
  shapeUniforms.set(material, uniform);
}

export function copyThreePdfShapeUniform(source: THREE.Material, target: THREE.Material): void {
  const uniform = shapeUniforms.get(source);
  if (uniform) shapeUniforms.set(target, uniform);
}

/** Returns a restoration callback; cloned clip materials share the same shape input. */
export function setThreePdfShapeOnly(material: THREE.Material, enabled: boolean): () => void {
  let uniform = shapeUniforms.get(material);
  if (material instanceof THREE.RawShaderMaterial) {
    uniform = material.uniforms.uPdfShapeOnly ??= { value: 0 };
  }
  if (!uniform) {
    if (enabled) throw new Error("PDF material has no geometric shape coverage input.");
    return () => undefined;
  }
  const previous = uniform.value;
  uniform.value = enabled ? 1 : 0;
  return () => { uniform.value = previous; };
}
