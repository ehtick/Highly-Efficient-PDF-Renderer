import * as THREE from "three";
import { NodeMaterial, TSL } from "three/webgpu";
import type { VectorScene } from "./pdfVectorExtractor";
import { packVectorClips } from "./vectorClips";
import { VECTOR_CLIP_WGSL } from "./vectorClipShaders";
import { copyThreePdfShapeUniform } from "./threePdfShape";

const nodeWorldPositions = new WeakMap<THREE.Material, unknown>();
const materialTextures = new WeakMap<THREE.Material, THREE.DataTexture>();
const clipFn: unknown = TSL.wgslFn(VECTOR_CLIP_WGSL);

export function registerThreeNodeClipPosition(material: THREE.Material, world: unknown): void {
  nodeWorldPositions.set(material, world);
}

export function createThreeVectorClipTexture(scene: VectorScene): THREE.DataTexture {
  const data = packVectorClips(scene.clipPaths);
  const width = Math.min(4096, Math.max(1, Math.ceil(Math.sqrt(data.length / 4))));
  const height = Math.ceil(data.length / 4 / width);
  if (height > 4096) throw new RangeError("Vector clip texture exceeds material capacity.");
  const padded = new Float32Array(width * height * 4); padded.set(data);
  const texture = new THREE.DataTexture(padded, width, height, THREE.RGBAFormat, THREE.FloatType);
  texture.minFilter = texture.magFilter = THREE.NearestFilter;
  texture.generateMipmaps = false;
  texture.needsUpdate = true;
  return texture;
}

export function initializeThreeVectorClip(material: THREE.Material, texture: THREE.DataTexture): void {
  materialTextures.set(material, texture);
  if (material instanceof THREE.RawShaderMaterial) {
    material.uniforms.uPdfShapeOnly ??= { value: 0 };
    material.uniforms.uVectorClipTex = { value: texture };
    material.uniforms.uVectorClipIndex = { value: -1 };
  }
}

/** Each clip gets its own constant uniform; camera/color/geometry nodes remain shared. */
export function createThreeVectorClipMaterial(source: THREE.Material, clipIndex?: number): THREE.Material {
  if (clipIndex === undefined || clipIndex < 0) return source;
  const texture = materialTextures.get(source);
  if (!texture) throw new Error("Clipped material has no vector clip texture.");
  const material = source.clone();
  copyThreePdfShapeUniform(source, material);
  if (source instanceof THREE.RawShaderMaterial && material instanceof THREE.RawShaderMaterial) {
    material.uniforms = { ...source.uniforms, uVectorClipIndex: { value: clipIndex } };
  } else if (source instanceof NodeMaterial && material instanceof NodeMaterial) {
    const world = nodeWorldPositions.get(source);
    if (!world || !source.fragmentNode) throw new Error("Clipped node material has no page-space position.");
    const coverage = (clipFn as (params: Record<string, unknown>) => unknown)({
      point: world, clipIndex: TSL.uniform(clipIndex), clipTexture: TSL.textureLoad(texture)
    });
    material.fragmentNode = TSL.mul(source.fragmentNode as never, coverage as never);
  } else {
    throw new Error("Unsupported vector clip material.");
  }
  return material;
}
