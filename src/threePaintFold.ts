import * as THREE from "three";
import { NodeMaterial, TSL } from "three/webgpu";
import { GRADIENT_BACKGROUND_GLSL, GRADIENT_BACKGROUND_WGSL, GRADIENT_PARAMETER_GLSL,
  GRADIENT_PARAMETER_WGSL } from "./gradientSampling";
import { paintFoldMaskWeights } from "./nativePaintFold";
import type { VectorDrawRun, VectorScene } from "./pdfVectorExtractor";
import type { ScenePaintMask } from "./scenePaintGraph";

/**
 * Folded group chains in Three (see `ScenePaintCompositorAdapter.drawFolded`):
 * a paint material that can draw a leaf scaled by its chain's opacity and,
 * optionally, a soft mask's value at each fragment. `fold` holds (opacity,
 * mask mode, mask bias, 0) and `weights` the mask weights (see
 * `paintFoldMaskWeights`); materials start at (1, 0), which changes nothing.
 * The mask mode is one of `PaintFoldMode`: a mask surface's pixel, or a
 * gradient mask the fragment computes itself from `gradient`.
 */
interface PaintFoldInputs {
  fold: { value: THREE.Vector4 };
  weights: { value: THREE.Vector4 };
  mask: { value: THREE.Texture | null };
  /** A gradient mask's description; see `THREE_GRADIENT_MASK_VECTORS`. */
  gradient: THREE.Vector4[];
  /** What `mask` holds while no mask applies. */
  neutral: THREE.Texture | null;
}

/** How a folded paint reads its soft mask; `fold.y` holds it. */
const PaintFoldMode = { None: 0, Surface: 1, Gradient: 2, LinearGradient: 3 } as const;

/**
 * A soft mask made of one analytic gradient fill, which a folded paint then
 * computes at each of its fragments instead of reading a rendered surface:
 * - 0-2: rows of the homography from a fragment's pixel to gradient space;
 * - 3: the gradient's metadata A (type, bounded, extension flags, background);
 * - 4: its start and end points; 5: its start and end radii, the paint's
 *   alpha and the gradient's row in the colour table;
 * - 6: the gradient-space bounds a bounded gradient paints inside;
 * - 7-14: the half-planes, in pixels, whose intersection the paint covers:
 *   its outline and its own clip. Coverage is the product of
 *   `clamp(0.5 + dot(plane.xyz, (x, y, 1)), 0, 1)`; unused planes are (0, 0, 1).
 */
export const THREE_GRADIENT_MASK_VECTORS = 15;
export const THREE_GRADIENT_MASK_PLANES = 8;
const PLANE_BASE = 7;

const foldInputs = new WeakMap<THREE.Material, PaintFoldInputs>();

// The paint's own shader may already define the gradient helpers.
const foldGradientGlsl = (GRADIENT_PARAMETER_GLSL + GRADIENT_BACKGROUND_GLSL).replace(/heprGradient/g, "heprFoldGradient");
const foldGradientWgsl = (GRADIENT_PARAMETER_WGSL + GRADIENT_BACKGROUND_WGSL).replace(/heprGradient/g, "heprFoldGradient");

/**
 * A straight-alpha raw paint material's fragment shader, with the fold applied
 * to its alpha. `uPaintMask` holds the mask surface, or the gradient colour
 * table while a gradient mask applies.
 */
export function threePaintFoldFragmentGlsl(source: string): string {
  const signature = /void\s+main\s*\(\s*\)/;
  if (!signature.test(source)) throw new Error("Folded paint shader has no main function.");
  const planes = Array.from({ length: THREE_GRADIENT_MASK_PLANES }, (_, index) =>
    `  coverage *= clamp(0.5 + dot(uPaintMaskGradient[${PLANE_BASE + index}].xyz, p), 0.0, 1.0);`).join("\n");
  return source.replace(signature, "void heprUnfoldedPaint()") + `
uniform vec4 uPaintFold;
uniform vec4 uPaintMaskWeights;
uniform vec4 uPaintMaskGradient[${THREE_GRADIENT_MASK_VECTORS}];
uniform highp sampler2D uPaintMask;
${foldGradientGlsl}
vec4 heprFoldGradientMask(vec2 pixel) {
  vec3 p = vec3(pixel, 1.0);
  vec3 h = vec3(dot(uPaintMaskGradient[0].xyz, p), dot(uPaintMaskGradient[1].xyz, p), dot(uPaintMaskGradient[2].xyz, p));
  vec2 q = h.xy / h.z;
  vec4 a = uPaintMaskGradient[3], ends = uPaintMaskGradient[4], extra = uPaintMaskGradient[5], box = uPaintMaskGradient[6];
  vec4 color = vec4(0.0);
  if (a.y < 0.5 || (q.x >= box.x && q.y >= box.y && q.x <= box.z && q.y <= box.w)) {
    vec2 parameter = heprFoldGradientParameter(a, vec4(0.0, 0.0, ends.xy), vec4(ends.zw, extra.xy), q);
    if (parameter.y < 0.5) {
      color = heprFoldGradientBackground(a.w);
    } else {
      float x = clamp(parameter.x, 0.0, 1.0) * 1023.0;
      int x0 = int(floor(x));
      int row = int(extra.w + 0.5);
      color = mix(texelFetch(uPaintMask, ivec2(x0, row), 0), texelFetch(uPaintMask, ivec2(min(x0 + 1, 1023), row), 0),
        x - float(x0));
    }
  }
  float coverage = extra.z;
${planes}
  vec3 rgb = clamp(color.rgb, 0.0, 1.0);
  if (uPaintFold.y > 2.5) rgb = mix(pow((rgb + 0.055) / 1.055, vec3(2.4)), rgb / 12.92, lessThanEqual(rgb, vec3(0.04045)));
  float alpha = coverage * color.a;
  return vec4(rgb * alpha, alpha);
}
void main() {
  heprUnfoldedPaint();
  if (uPaintFold.y < 0.5) {
    outColor.a *= uPaintFold.x;
    return;
  }
  vec4 mask = uPaintFold.y < 1.5 ? texelFetch(uPaintMask, ivec2(gl_FragCoord.xy), 0) : heprFoldGradientMask(gl_FragCoord.xy);
  outColor.a *= uPaintFold.x * clamp(dot(mask, uPaintMaskWeights) + uPaintFold.z, 0.0, 1.0);
}
`;
}

/** Gives a raw paint material built with `threePaintFoldFragmentGlsl` its fold inputs. */
export function enableThreeRawPaintFold(material: THREE.RawShaderMaterial): void {
  const fold = material.uniforms.uPaintFold = { value: new THREE.Vector4(1, 0, 0, 0) };
  const weights = material.uniforms.uPaintMaskWeights = { value: new THREE.Vector4() };
  const gradient = neutralGradient();
  material.uniforms.uPaintMaskGradient = { value: gradient };
  const mask = material.uniforms.uPaintMask = { value: null };
  foldInputs.set(material, { fold, weights, mask, gradient, neutral: null });
}

// The mask input's placeholder: read only while no mask applies, where the
// fold ignores it, and never a surface a pass could write. Three WebGPU
// rebinds a texture input only when the new texture's version differs, and
// the compositor numbers its surfaces' versions upwards from 2^20, so the
// placeholder takes a version no surface reaches.
const NEUTRAL_MASK_VERSION = 2 ** 30;
let neutralMask: THREE.DataTexture | null = null;

const planeParameters = Array.from({ length: THREE_GRADIENT_MASK_VECTORS }, (_, index) => `d${index}: vec4f`).join(", ");
const planeProducts = Array.from({ length: THREE_GRADIENT_MASK_PLANES }, (_, index) =>
  `    coverage *= clamp(0.5 + dot(d${PLANE_BASE + index}.xyz, p), 0.0, 1.0);`).join("\n");
const paintFoldScaleFn: unknown = TSL.wgslFn(`
fn heprPaintFoldScale(pixel: vec2f, mask: texture_2d<f32>, fold: vec4f, weights: vec4f, ${planeParameters}) -> f32 {
  if (fold.y < 0.5) { return fold.x; }
  var value: vec4f;
  if (fold.y < 1.5) {
    // Integer loads do not clamp, and the placeholder is a single texel.
    let size = vec2<i32>(textureDimensions(mask));
    value = textureLoad(mask, clamp(vec2<i32>(pixel), vec2<i32>(0), size - vec2<i32>(1)), 0);
  } else {
    let p = vec3f(pixel, 1.0);
    let h = vec3f(dot(d0.xyz, p), dot(d1.xyz, p), dot(d2.xyz, p));
    let q = h.xy / h.z;
    var color = vec4f(0.0);
    if (d3.y < 0.5 || (q.x >= d6.x && q.y >= d6.y && q.x <= d6.z && q.y <= d6.w)) {
      let parameter = heprFoldGradientParameter(d3, vec4f(0.0, 0.0, d4.xy), vec4f(d4.zw, d5.xy), q);
      if (parameter.y < 0.5) {
        color = heprFoldGradientBackground(d3.w);
      } else {
        let x = clamp(parameter.x, 0.0, 1.0) * 1023.0;
        let x0 = i32(floor(x));
        let row = i32(d5.w + 0.5);
        color = mix(textureLoad(mask, vec2<i32>(x0, row), 0), textureLoad(mask, vec2<i32>(min(x0 + 1, 1023), row), 0),
          x - f32(x0));
      }
    }
    var coverage = d5.z;
${planeProducts}
    var rgb = clamp(color.rgb, vec3f(0.0), vec3f(1.0));
    if (fold.y > 2.5) { rgb = select(pow((rgb + 0.055) / 1.055, vec3f(2.4)), rgb / 12.92, rgb <= vec3f(0.04045)); }
    let alpha = coverage * color.a;
    value = vec4f(rgb * alpha, alpha);
  }
  return fold.x * clamp(dot(value, weights) + fold.z, 0.0, 1.0);
}
`, [TSL.wgslFn(foldGradientWgsl.slice(0, foldGradientWgsl.indexOf("fn heprFoldGradientBackground"))),
  TSL.wgslFn(foldGradientWgsl.slice(foldGradientWgsl.indexOf("fn heprFoldGradientBackground")))] as never);

/**
 * Scales a straight-alpha node paint's alpha by the fold. A mask surface is
 * read at this fragment's pixel of the destination-sized surface.
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
  const fold = TSL.uniform(new THREE.Vector4(1, 0, 0, 0));
  const weights = TSL.uniform(new THREE.Vector4());
  const gradient = neutralGradient();
  // A texture-valued function argument must stay a texture node rather than a sampled vec4.
  const mask = TSL.textureLoad(neutralMask);
  // Three keys texture bindings by the texture a node holds when the shader
  // is built; a fixed hash keeps this input its own binding whatever it holds.
  (mask as unknown as { getUniformHash: () => string }).getUniformHash = () => "hepr-paint-fold-mask";
  const parameters: Record<string, unknown> = { pixel: TSL.screenCoordinate, mask, fold, weights };
  gradient.forEach((vector, index) => { parameters[`d${index}`] = TSL.uniform(vector); });
  const scale = (paintFoldScaleFn as (params: Record<string, unknown>) => unknown)(parameters);
  const source = material.fragmentNode;
  material.fragmentNode = TSL.Fn(() => {
    const color = TSL.property("vec4", "heprFoldSource");
    color.assign(source as never);
    return TSL.vec4(color.rgb, TSL.mul(color.a, scale as never));
  })() as never;
  foldInputs.set(material, { fold: fold as unknown as PaintFoldInputs["fold"],
    weights: weights as unknown as PaintFoldInputs["weights"],
    mask: mask as unknown as PaintFoldInputs["mask"], gradient, neutral: neutralMask });
}

function neutralGradient(): THREE.Vector4[] {
  return Array.from({ length: THREE_GRADIENT_MASK_VECTORS }, (_, index) =>
    new THREE.Vector4(0, 0, index >= PLANE_BASE ? 1 : 0, 0));
}

/** Clip clones share the fold inputs of the material they wrap. */
export function copyThreePaintFold(source: THREE.Material, target: THREE.Material): void {
  const inputs = foldInputs.get(source);
  if (inputs) foldInputs.set(target, inputs);
}

export function canFoldThreePaint(material: THREE.Material): boolean {
  return foldInputs.has(material);
}

/** A soft mask made of one gradient paint, as a folded paint computes it; see `THREE_GRADIENT_MASK_VECTORS`. */
export interface ThreeGradientMaskFold {
  /** The scene's gradient colour table, which holds a row per gradient. */
  lut: THREE.Texture;
  vectors: Float32Array;
  /** Whether the mask's paint writes linear rather than display values. */
  linear: boolean;
}

/**
 * Applies a fold to a paint material until the returned callback restores it.
 * `content` is the soft mask that `mask` holds unconverted, or that
 * `gradient` describes. Materials sharing inputs must be restored in reverse
 * order.
 */
export function setThreePaintFold(material: THREE.Material, opacity: number, mask: THREE.Texture | null,
  content?: ScenePaintMask, gradient?: ThreeGradientMaskFold): () => void {
  const inputs = foldInputs.get(material);
  if (!inputs) throw new Error("PDF material cannot draw a folded paint.");
  const fold = inputs.fold.value.clone(), weights = inputs.weights.value.clone(), texture = inputs.mask.value;
  const vectors = gradient ? inputs.gradient.map(vector => vector.clone()) : null;
  const [red, green, blue, alpha, bias] = paintFoldMaskWeights(content);
  const mode = gradient ? (gradient.linear ? PaintFoldMode.LinearGradient : PaintFoldMode.Gradient)
    : mask ? PaintFoldMode.Surface : PaintFoldMode.None;
  inputs.fold.value.set(opacity, mode, bias, 0);
  inputs.weights.value.set(red, green, blue, alpha);
  inputs.mask.value = gradient?.lut ?? mask ?? inputs.neutral;
  if (gradient) inputs.gradient.forEach((vector, index) => vector.fromArray(gradient.vectors, index * 4));
  return () => {
    inputs.fold.value.copy(fold); inputs.weights.value.copy(weights); inputs.mask.value = texture;
    if (vectors) inputs.gradient.forEach((vector, index) => vector.copy(vectors[index]));
  };
}

/**
 * The fold a paint material would draw with now, for diagnostics; null if it
 * cannot fold. `weights` are the mask weights and bias, as `paintFoldMaskWeights`
 * gives them, while masked. `gradient` is the gradient mask's description while
 * the paint computes its mask itself.
 */
export function threePaintFoldState(material: THREE.Material): { opacity: number; masked: boolean;
  mask: THREE.Texture | null; weights: number[] | null; gradient?: number[] } | null {
  const inputs = foldInputs.get(material);
  if (!inputs) return null;
  const mode = Math.round(inputs.fold.value.y);
  const masked = mode !== PaintFoldMode.None;
  const state = { opacity: inputs.fold.value.x, masked, mask: masked ? inputs.mask.value : null,
    weights: masked ? [...inputs.weights.value.toArray(), inputs.fold.value.z] : null };
  return mode >= PaintFoldMode.Gradient
    ? { ...state, gradient: inputs.gradient.flatMap(vector => vector.toArray()) } : state;
}

/**
 * What a folded paint needs to compute a soft mask made of this gradient
 * fill material's paint: its colour table and the domain it writes colour
 * in. Registered by the layer that builds the material.
 */
export interface ThreeGradientMaskSource {
  lut: THREE.Texture;
  linear: boolean;
  /** Whole-document colour override; a mask paint under one keeps its surface. */
  vectorOverride: THREE.Vector4;
  /** Per-paint highlight colour; likewise. */
  primitiveColor: THREE.Vector4;
}

const gradientMaskSources = new WeakMap<THREE.Material, ThreeGradientMaskSource>();

export function registerThreeGradientMaskSource(material: THREE.Material, source: ThreeGradientMaskSource): void {
  gradientMaskSources.set(material, source);
}

export function threeGradientMaskSource(material: THREE.Material): ThreeGradientMaskSource | undefined {
  return gradientMaskSources.get(material);
}

/** Clip chains deeper than this are treated as cyclic. */
const MAX_CLIP_DEPTH = 256;

function clipChainIncludes(scene: VectorScene, from: number | undefined, clip: number): boolean {
  for (let index = from ?? -1, depth = 0; index >= 0 && depth < MAX_CLIP_DEPTH; depth++) {
    if (index === clip) return true;
    index = scene.clipPaths?.[index]?.parent ?? -1;
  }
  return false;
}

/**
 * Describes the soft mask that a gradient fill paints alone, for a folded
 * paint to compute at its fragments (see `THREE_GRADIENT_MASK_VECTORS`). Null
 * when that paint needs its rendered surface instead: a patch-mesh gradient,
 * a gradient under another gradient's mask, a curved or non-convex outline or
 * clip, a clip chain other than the folded paint's own plus one clip, or a
 * paint reaching behind the camera.
 *
 * The folded paint is already clipped by `foldedClip`'s chain, so only the
 * mask paint's clips beyond that chain count. `clipFromData` projects scene
 * coordinates into clip space, and the surface is `width` by `height` pixels,
 * with rows counted from the top when `topDown`, as WebGPU fragments count
 * them.
 */
export function threeGradientMaskVectors(scene: VectorScene, maskRun: VectorDrawRun, foldedClip: number | undefined,
  clipFromData: THREE.Matrix4, width: number, height: number, topDown: boolean): Float32Array | null {
  const path = maskRun.first, paint = scene.gradientFillPaintMeta, pathMetaA = scene.gradientFillPathMetaA;
  if (maskRun.kind !== "gradient-fill" || maskRun.count !== 1 || !paint || !pathMetaA || !scene.gradientFillPathMetaC ||
    path < 0 || path * 4 + 3 >= paint.length) return null;
  const gradient = paint[path * 4], g = gradient * 4;
  if (!(gradient >= 0 && gradient < scene.gradientCount) || paint[path * 4 + 1] >= 0) return null;
  const { gradientMetaA: a, gradientMetaB: b, gradientMetaC: c, gradientMetaD: d, gradientMetaE: e } = scene;
  if (!a || !b || !c || !d || !e || g + 3 >= a.length || a[g] > 1.5) return null;

  const polygons: number[][] = [];
  const outline: number[] = [];
  const segmentsA = scene.gradientFillSegmentsA, segmentsB = scene.gradientFillSegmentsB;
  for (let segment = pathMetaA[path * 4], end = segment + pathMetaA[path * 4 + 1]; segment < end; segment++) {
    const offset = segment * 4;
    if (!segmentsA || !segmentsB || offset + 3 >= segmentsA.length || segmentsB[offset + 2] >= 1) return null;
    outline.push(segmentsA[offset], segmentsA[offset + 1], segmentsB[offset], segmentsB[offset + 1]);
  }
  polygons.push(outline);
  const clipIndex = maskRun.clipIndex ?? -1;
  if (clipIndex >= 0 && !clipChainIncludes(scene, foldedClip, clipIndex)) {
    const clip = scene.clipPaths?.[clipIndex];
    if (!clip || (clip.parent >= 0 && !clipChainIncludes(scene, foldedClip, clip.parent))) return null;
    polygons.push(Array.from(clip.edges));
  }

  // Scene point to homogeneous surface pixel.
  const m = clipFromData.elements, halfWidth = width / 2, halfHeight = height / 2, flip = topDown ? -1 : 1;
  const project = new THREE.Matrix3().set(
    (m[0] + m[3]) * halfWidth, (m[4] + m[7]) * halfWidth, (m[12] + m[15]) * halfWidth,
    (m[3] + flip * m[1]) * halfHeight, (m[7] + flip * m[5]) * halfHeight, (m[15] + flip * m[13]) * halfHeight,
    m[3], m[7], m[15]);
  const pixel = (x: number, y: number): [number, number] | null => {
    const w = m[3] * x + m[7] * y + m[15];
    if (!(w > 1e-6)) return null;
    const p = project.elements;
    return [(p[0] * x + p[3] * y + p[6]) / w, (p[1] * x + p[4] * y + p[7]) / w];
  };

  const vectors = new Float32Array(THREE_GRADIENT_MASK_VECTORS * 4);
  let plane = PLANE_BASE;
  for (const edges of polygons) {
    // One closed convex loop, projected: a projection keeps a polygon convex
    // while it stays in front of the camera.
    const points: [number, number][] = [];
    for (let index = 0; index < edges.length; index += 4) {
      const from = pixel(edges[index], edges[index + 1]);
      const next = (index + 4) % edges.length;
      if (!from || Math.hypot(edges[index + 2] - edges[next], edges[index + 3] - edges[next + 1]) >
        1e-5 * (1 + Math.abs(edges[next]) + Math.abs(edges[next + 1]))) return null;
      points.push(from);
    }
    if (points.length < 3) return null;
    const centre = points.reduce((sum, point) => [sum[0] + point[0] / points.length, sum[1] + point[1] / points.length],
      [0, 0]);
    let turn = 0;
    for (let index = 0; index < points.length; index++) {
      const [x0, y0] = points[index], [x1, y1] = points[(index + 1) % points.length];
      const [x2, y2] = points[(index + 2) % points.length];
      const cross = (x1 - x0) * (y2 - y1) - (y1 - y0) * (x2 - x1);
      const scale = Math.hypot(x1 - x0, y1 - y0) * Math.hypot(x2 - x1, y2 - y1);
      if (Math.abs(cross) <= 1e-6 * scale) continue;
      if (turn && Math.sign(cross) !== turn) return null;
      turn = Math.sign(cross);
    }
    if (!turn) return null;
    for (let index = 0; index < points.length; index++) {
      const [x0, y0] = points[index], [x1, y1] = points[(index + 1) % points.length];
      const length = Math.hypot(x1 - x0, y1 - y0);
      if (length < 1e-9) continue;
      if (plane >= THREE_GRADIENT_MASK_VECTORS) return null;
      let nx = (y0 - y1) / length, ny = (x1 - x0) / length, offset = -(nx * x0 + ny * y0);
      // A convex loop's centre is inside whichever way it winds.
      if (nx * centre[0] + ny * centre[1] + offset < 0) { nx = -nx; ny = -ny; offset = -offset; }
      vectors.set([nx, ny, offset, 0], plane++ * 4);
    }
  }
  for (; plane < THREE_GRADIENT_MASK_VECTORS; plane++) vectors.set([0, 0, 1, 0], plane * 4);

  // Surface pixel to gradient space: the inverse projection, then the
  // gradient's own affine map from scene coordinates.
  const unproject = project.clone();
  if (!(Math.abs(unproject.determinant()) > 0)) return null;
  unproject.invert();
  const toGradient = new THREE.Matrix3().set(b[g], b[g + 2], c[g], b[g + 1], b[g + 3], c[g + 1], 0, 0, 1)
    .multiply(unproject).elements;
  const largest = Math.max(...toGradient.map(Math.abs));
  if (!(largest > 0) || !Number.isFinite(largest)) return null;
  // Rows of a column-major matrix, scaled for float precision; the shader divides it back out.
  for (let row = 0; row < 3; row++) {
    vectors.set([toGradient[row] / largest, toGradient[row + 3] / largest, toGradient[row + 6] / largest, 0], row * 4);
  }
  vectors.set(a.subarray(g, g + 4), 12);
  vectors.set([c[g + 2], c[g + 3], d[g], d[g + 1]], 16);
  vectors.set([d[g + 2], d[g + 3], scene.gradientFillPathMetaC[path * 4 + 3], gradient], 20);
  vectors.set(e.subarray(g, g + 4), 24);
  return vectors;
}
