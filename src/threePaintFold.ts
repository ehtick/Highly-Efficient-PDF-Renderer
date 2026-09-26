import * as THREE from "three";
import { NodeMaterial, TSL } from "three/webgpu";
import { paintFoldFragmentGlsl } from "./nativePaintFold";

/**
 * Folded group chains in Three (see `ScenePaintCompositorAdapter.drawFolded`):
 * a paint material that can draw a leaf scaled by its chain's opacity and,
 * optionally, a mask surface's red channel at each pixel. `fold` holds
 * (opacity, masked); materials start at (1, 0), which changes nothing.
 */
interface PaintFoldInputs {
  fold: { value: THREE.Vector2 };
  mask: { value: THREE.Texture | null };
  /** What `mask` holds while no mask applies. */
  neutral: THREE.Texture | null;
}

const foldInputs = new WeakMap<THREE.Material, PaintFoldInputs>();

/** A straight-alpha raw paint material's fragment shader, with the fold applied to its alpha. */
export function threePaintFoldFragmentGlsl(source: string): string {
  return paintFoldFragmentGlsl(source, false);
}

/** Gives a raw paint material built with `threePaintFoldFragmentGlsl` its fold inputs. */
export function enableThreeRawPaintFold(material: THREE.RawShaderMaterial): void {
  const fold = material.uniforms.uPaintFold = { value: new THREE.Vector2(1, 0) };
  const mask = material.uniforms.uPaintMask = { value: null };
  foldInputs.set(material, { fold, mask, neutral: null });
}

// The mask input's placeholder: read only while no mask applies, where the
// fold ignores it, and never a surface a pass could write. Three WebGPU
// rebinds a texture input only when the new texture's version differs, and
// the compositor numbers its surfaces' versions upwards from one, so the
// placeholder takes a version no surface reaches.
const NEUTRAL_MASK_VERSION = 2 ** 30;
let neutralMask: THREE.DataTexture | null = null;

/**
 * Scales a straight-alpha node paint's alpha by the fold. The mask is read at
 * this fragment's pixel of the destination-sized mask surface.
 */
export function enableThreeNodePaintFold(material: THREE.Material): void {
  if (!(material instanceof NodeMaterial) || !material.fragmentNode) {
    throw new Error("Folded paint material has no node fragment output.");
  }
  if (!neutralMask) {
    neutralMask = new THREE.DataTexture(Uint8Array.of(255, 255, 255, 255), 1, 1);
    neutralMask.needsUpdate = true;
    neutralMask.version = NEUTRAL_MASK_VERSION;
  }
  const fold = TSL.uniform(new THREE.Vector2(1, 0));
  const mask = TSL.textureLoad(neutralMask, TSL.screenCoordinate);
  // Keep the load inside the texture while the 1x1 placeholder is bound.
  mask.uvNode = TSL.clamp(TSL.screenCoordinate, TSL.vec2(0), TSL.vec2(TSL.textureSize(mask) as never).sub(1)) as never;
  // Three keys texture bindings by the texture a node holds when the shader
  // is built; a fixed hash keeps this input its own binding whatever it holds.
  (mask as unknown as { getUniformHash: () => string }).getUniformHash = () => "hepr-paint-fold-mask";
  const source = material.fragmentNode;
  material.fragmentNode = TSL.Fn(() => {
    const color = TSL.property("vec4", "heprFoldSource");
    color.assign(source as never);
    const scale = TSL.mul(fold.x, TSL.mix(1, (mask as unknown as { r: never }).r, fold.y));
    return TSL.vec4(color.rgb, TSL.mul(color.a, scale));
  })() as never;
  foldInputs.set(material, { fold: fold as unknown as PaintFoldInputs["fold"],
    mask: mask as unknown as PaintFoldInputs["mask"], neutral: neutralMask });
}

/** Clip clones share the fold inputs of the material they wrap. */
export function copyThreePaintFold(source: THREE.Material, target: THREE.Material): void {
  const inputs = foldInputs.get(source);
  if (inputs) foldInputs.set(target, inputs);
}

export function canFoldThreePaint(material: THREE.Material): boolean {
  return foldInputs.has(material);
}

/**
 * Applies a fold to a paint material until the returned callback restores it.
 * Materials sharing inputs must be restored in reverse order.
 */
export function setThreePaintFold(material: THREE.Material, opacity: number, mask: THREE.Texture | null): () => void {
  const inputs = foldInputs.get(material);
  if (!inputs) throw new Error("PDF material cannot draw a folded paint.");
  const fold = inputs.fold.value.clone(), texture = inputs.mask.value;
  inputs.fold.value.set(opacity, mask ? 1 : 0);
  inputs.mask.value = mask ?? inputs.neutral;
  return () => { inputs.fold.value.copy(fold); inputs.mask.value = texture; };
}

/** The fold a paint material would draw with now, for diagnostics; null if it cannot fold. */
export function threePaintFoldState(material: THREE.Material): { opacity: number; masked: boolean; mask: THREE.Texture | null } | null {
  const inputs = foldInputs.get(material);
  if (!inputs) return null;
  const masked = inputs.fold.value.y > 0.5;
  return { opacity: inputs.fold.value.x, masked, mask: masked ? inputs.mask.value : null };
}
