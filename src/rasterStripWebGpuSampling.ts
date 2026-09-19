/** Shared by native WebGPU and Three's WGSL nodes; every atlas row has its own mip chain. */
export const RASTER_STRIP_LEVEL_WGSL = /* wgsl */ `
fn heprRasterStripLevel(
  uRasterTex : texture_2d<f32>,
  uRasterSampler : sampler,
  uv : vec2f,
  row : u32,
  width : u32,
  level : u32
) -> vec4f {
  var offset = 0u;
  var levelWidth = width;
  for (var index = 0u; index < level; index = index + 1u) {
    offset = offset + levelWidth;
    levelWidth = max(levelWidth / 2u, 1u);
  }
  let x = f32(offset) + clamp(uv.x * f32(levelWidth), 0.5, f32(levelWidth) - 0.5);
  let atlasUv = vec2f(x, f32(row) + 0.5) / vec2f(textureDimensions(uRasterTex));
  return textureSampleLevel(uRasterTex, uRasterSampler, atlasUv, 0.0);
}
`;

export const RASTER_STRIP_SAMPLE_WGSL = /* wgsl */ `
fn heprRasterStripSample(
  uRasterTex : texture_2d<f32>,
  uRasterSampler : sampler,
  uv : vec2f,
  row : u32,
  width : u32
) -> vec4f {
  let sourceUv = uv * vec2f(f32(width), 1.0);
  let footprint = max(length(dpdx(sourceUv)), length(dpdy(sourceUv)));
  let maxLevel = firstLeadingBit(width);
  let lod = clamp(log2(max(footprint, 1.0)), 0.0, f32(maxLevel));
  let lowerLevel = u32(floor(lod));
  let upperLevel = u32(ceil(lod));
  return mix(
    heprRasterStripLevel(uRasterTex, uRasterSampler, uv, row, width, lowerLevel),
    heprRasterStripLevel(uRasterTex, uRasterSampler, uv, row, width, upperLevel),
    fract(lod)
  );
}
`;
