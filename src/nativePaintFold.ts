import { GRADIENT_MASK_VECTORS, GRADIENT_MASK_PLANES } from "./gradientMaskFold";
import { GRADIENT_BACKGROUND_GLSL, GRADIENT_BACKGROUND_WGSL, GRADIENT_PARAMETER_GLSL,
  GRADIENT_PARAMETER_WGSL } from "./gradientSampling";
import type { ScenePaintMask } from "./scenePaintGraph";

const PLANE_BASE = 7;

/**
 * The texture unit native WebGL paint programs read a folded paint's soft mask
 * from: above the paint units (0-18) and the compositor's (19-25).
 */
export const PAINT_FOLD_MASK_UNIT = 27;

/**
 * How a folded paint turns its mask surface's pixel into a scale, as
 * (weights, bias) for `clamp(dot(pixel, weights) + bias, 0, 1)`. A converted
 * mask holds its value in red. Given the soft mask whose rendered content the
 * surface holds instead, this converts that content exactly as the soft-mask
 * pass (operation 4) would, since both conversions are linear in the
 * premultiplied pixel: alpha is `a`, and luminosity over a backdrop B is
 * lum(rgb + (1 - a) B) = lum(rgb) - a lum(B) + lum(B). A transfer function is
 * not linear, so a mask with one is always converted by its pass first.
 */
export function paintFoldMaskWeights(content?: ScenePaintMask): [number, number, number, number, number] {
  if (!content) return [1, 0, 0, 0, 0];
  if (content.subtype !== "Luminosity") return [0, 0, 0, 1, 0];
  const [r, g, b] = content.backdrop ?? [0, 0, 0];
  const backdrop = 0.3 * r + 0.59 * g + 0.11 * b;
  return [0.3, 0.59, 0.11, -backdrop, backdrop];
}

// The paint's own shader may already define the gradient helpers.
const foldGradientGlsl = (GRADIENT_PARAMETER_GLSL + GRADIENT_BACKGROUND_GLSL).replace(/heprGradient/g, "heprFoldGradient");
export const foldGradientWgsl = (GRADIENT_PARAMETER_WGSL + GRADIENT_BACKGROUND_WGSL).replace(/heprGradient/g, "heprFoldGradient");

/**
 * Applies the fold to a paint shader: alpha for straight-alpha output, all
 * channels for premultiplied output. `uPaintMask` holds the mask surface, or the gradient colour
 * table while a gradient mask applies.
 */
export function paintFoldFragmentGlsl(source: string, premultiplied = false): string {
  const signature = /void\s+main\s*\(\s*\)/;
  if (!signature.test(source)) throw new Error("Folded paint shader has no main function.");
  const planes = Array.from({ length: GRADIENT_MASK_PLANES }, (_, index) =>
    `  coverage *= clamp(0.5 + dot(uPaintMaskGradient[${PLANE_BASE + index}].xyz, p), 0.0, 1.0);`).join("\n");
  return source.replace(signature, "void heprUnfoldedPaint()") + `
uniform vec4 uPaintFold;
uniform vec4 uPaintMaskWeights;
uniform vec4 uPaintMaskGradient[${GRADIENT_MASK_VECTORS}];
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
    ${premultiplied ? "outColor" : "outColor.a"} *= uPaintFold.x;
    return;
  }
  vec4 mask = uPaintFold.y < 1.5 ? texelFetch(uPaintMask, ivec2(gl_FragCoord.xy), 0) : heprFoldGradientMask(gl_FragCoord.xy);
  ${premultiplied ? "outColor" : "outColor.a"} *= uPaintFold.x * clamp(dot(mask, uPaintMaskWeights) + uPaintFold.z, 0.0, 1.0);
}
`;
}

const planeParameters = Array.from({ length: GRADIENT_MASK_VECTORS }, (_, index) => `d${index}: vec4f`).join(", ");
const planeProducts = Array.from({ length: GRADIENT_MASK_PLANES }, (_, index) =>
  `    coverage *= clamp(0.5 + dot(d${PLANE_BASE + index}.xyz, p), 0.0, 1.0);`).join("\n");
export const PAINT_FOLD_SCALE_WGSL = `
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
`;

/**
 * `paintFoldFragmentGlsl` for a straight-alpha WGSL paint pipeline: `fsMain`
 * becomes a helper, and the new entry scales its alpha by `fold.x` and, when
 * `fold.y` is set, by the mask surface's pixel weighted by `maskWeights` plus
 * `fold.z`. The inputs sit in bind group `group`; the neutral fold (1, 0)
 * changes nothing.
 */
export function paintFoldFragmentWgsl(source: string, group: number): string {
  const signature = /@fragment\s+fn fsMain\(inData\s*:\s*(\w+)\)\s*->\s*@location\(0\)\s*vec4f/;
  const match = source.match(signature);
  if (!match) throw new Error("Folded paint shader has no supported fragment entry point.");
  return source.replace(signature, `fn heprUnfoldedPaint(inData: ${match[1]}) -> vec4f`) + `
struct HeprPaintFold { fold: vec4f, maskWeights: vec4f, gradient: array<vec4f, ${GRADIENT_MASK_VECTORS}> };
${foldGradientWgsl}
${PAINT_FOLD_SCALE_WGSL}
@group(${group}) @binding(0) var<uniform> uPaintFold : HeprPaintFold;
@group(${group}) @binding(1) var uPaintMask : texture_2d<f32>;

@fragment
fn fsMain(inData: ${match[1]}) -> @location(0) vec4f {
  let color = heprUnfoldedPaint(inData);
  let fold = heprPaintFoldScale(inData.position.xy, uPaintMask, uPaintFold.fold, uPaintFold.maskWeights,
    ${Array.from({ length: GRADIENT_MASK_VECTORS }, (_, index) => `uPaintFold.gradient[${index}]`).join(", ")});
  return vec4f(color.rgb, color.a * fold);
}
`;
}
