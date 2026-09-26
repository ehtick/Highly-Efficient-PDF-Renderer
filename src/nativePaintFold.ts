import type { ScenePaintMask } from "./scenePaintGraph";

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

/**
 * Lets a native paint program draw a leaf that its group chain was folded
 * onto (see `ScenePaintCompositorAdapter.drawFolded`). `uPaintFold.x` is the
 * chain's opacity; when `uPaintFold.y` is set, the mask surface's pixel scales
 * it too, weighted by `uPaintMaskWeights` plus `uPaintFold.z` (see
 * `paintFoldMaskWeights`). Straight-alpha paints scale their alpha only,
 * premultiplied ones every channel, so either composites exactly as the
 * group's surface would have. Programs start at (1, 0), which changes nothing.
 */
export function paintFoldFragmentGlsl(source: string, premultiplied: boolean): string {
  const signature = /void\s+main\s*\(\s*\)/;
  if (!signature.test(source)) throw new Error("Folded paint shader has no main function.");
  return source.replace(signature, "void heprUnfoldedPaint()") + `
uniform vec4 uPaintFold;
uniform vec4 uPaintMaskWeights;
uniform highp sampler2D uPaintMask;
void main() {
  heprUnfoldedPaint();
  float fold = uPaintFold.x;
  if (uPaintFold.y > 0.5) {
    fold *= clamp(dot(texelFetch(uPaintMask, ivec2(gl_FragCoord.xy), 0), uPaintMaskWeights) + uPaintFold.z, 0.0, 1.0);
  }
  ${premultiplied ? "outColor *= fold;" : "outColor.a *= fold;"}
}
`;
}

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
struct HeprPaintFold { fold: vec4f, maskWeights: vec4f };
@group(${group}) @binding(0) var<uniform> uPaintFold : HeprPaintFold;
@group(${group}) @binding(1) var uPaintMask : texture_2d<f32>;

@fragment
fn fsMain(inData: ${match[1]}) -> @location(0) vec4f {
  let color = heprUnfoldedPaint(inData);
  var fold = uPaintFold.fold.x;
  if (uPaintFold.fold.y > 0.5) {
    let mask = textureLoad(uPaintMask, vec2<i32>(inData.position.xy), 0);
    fold *= clamp(dot(mask, uPaintFold.maskWeights) + uPaintFold.fold.z, 0.0, 1.0);
  }
  return vec4f(color.rgb, color.a * fold);
}
`;
}
