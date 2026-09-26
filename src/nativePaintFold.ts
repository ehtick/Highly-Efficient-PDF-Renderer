/**
 * The texture unit native WebGL paint programs read a folded paint's soft mask
 * from: above the paint units (0-18) and the compositor's (19-25).
 */
export const PAINT_FOLD_MASK_UNIT = 27;

/**
 * Lets a native paint program draw a leaf that its group chain was folded
 * onto (see `ScenePaintCompositorAdapter.drawFolded`). `uPaintFold.x` is the
 * chain's opacity; when `uPaintFold.y` is set, the mask surface's red channel
 * at this pixel scales it too. Straight-alpha paints scale their alpha only,
 * premultiplied ones every channel, so either composites exactly as the
 * group's surface would have. Programs start at (1, 0), which changes nothing.
 */
export function paintFoldFragmentGlsl(source: string, premultiplied: boolean): string {
  const signature = /void\s+main\s*\(\s*\)/;
  if (!signature.test(source)) throw new Error("Folded paint shader has no main function.");
  return source.replace(signature, "void heprUnfoldedPaint()") + `
uniform vec2 uPaintFold;
uniform highp sampler2D uPaintMask;
void main() {
  heprUnfoldedPaint();
  float fold = uPaintFold.x;
  if (uPaintFold.y > 0.5) fold *= texelFetch(uPaintMask, ivec2(gl_FragCoord.xy), 0).r;
  ${premultiplied ? "outColor *= fold;" : "outColor.a *= fold;"}
}
`;
}

/**
 * `paintFoldFragmentGlsl` for a straight-alpha WGSL paint pipeline: `fsMain`
 * becomes a helper, and the new entry scales its alpha by `uPaintFold.x` and,
 * when `uPaintFold.y` is set, by the mask surface's red channel at this pixel.
 * The inputs sit in bind group `group`; the neutral fold (1, 0) changes nothing.
 */
export function paintFoldFragmentWgsl(source: string, group: number): string {
  const signature = /@fragment\s+fn fsMain\(inData\s*:\s*(\w+)\)\s*->\s*@location\(0\)\s*vec4f/;
  const match = source.match(signature);
  if (!match) throw new Error("Folded paint shader has no supported fragment entry point.");
  return source.replace(signature, `fn heprUnfoldedPaint(inData: ${match[1]}) -> vec4f`) + `
@group(${group}) @binding(0) var<uniform> uPaintFold : vec4f;
@group(${group}) @binding(1) var uPaintMask : texture_2d<f32>;

@fragment
fn fsMain(inData: ${match[1]}) -> @location(0) vec4f {
  let color = heprUnfoldedPaint(inData);
  var fold = uPaintFold.x;
  if (uPaintFold.y > 0.5) { fold *= textureLoad(uPaintMask, vec2<i32>(inData.position.xy), 0).r; }
  return vec4f(color.rgb, color.a * fold);
}
`;
}
