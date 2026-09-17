import { MAX_VECTOR_CLIP_DEPTH, MAX_VECTOR_CLIP_EDGES } from "./vectorClips";

export const VECTOR_CLIP_GLSL = `
uniform highp sampler2D uVectorClipTex;
uniform float uVectorClipIndex;
vec4 heprClipTexel(int index) {
  int width = textureSize(uVectorClipTex, 0).x;
  return texelFetch(uVectorClipTex, ivec2(index % width, index / width), 0);
}
float heprVectorClip(vec2 point) {
  int index = int(uVectorClipIndex);
  for (int depth = 0; depth < ${MAX_VECTOR_CLIP_DEPTH}; depth++) {
    if (index < 0) return 1.0;
    vec4 node = heprClipTexel(index);
    if (node.z < 0.0) {
      vec4 bounds = heprClipTexel(int(node.y));
      // Match polygon winding at boundaries: include min, exclude max.
      if (any(lessThan(point, bounds.xy)) || any(greaterThanEqual(point, bounds.zw))) return 0.0;
      index = int(node.x);
      continue;
    }
    int winding = 0;
    for (int edge = 0; edge < ${MAX_VECTOR_CLIP_EDGES}; edge++) {
      if (edge >= int(node.z)) break;
      vec4 line = heprClipTexel(int(node.y) + edge);
      if ((line.y > point.y) != (line.w > point.y)) {
        float x = line.x + (point.y - line.y) / (line.w - line.y) * (line.z - line.x);
        if (x > point.x) winding += line.w > line.y ? 1 : -1;
      }
    }
    if (node.w > 0.5 ? (abs(winding) % 2 == 0) : winding == 0) return 0.0;
    index = int(node.x);
  }
  return index < 0 ? 1.0 : 0.0;
}
`;

export const VECTOR_CLIP_WGSL = `
fn heprVectorClip(point: vec2<f32>, clipIndex: f32, clipTexture: texture_2d<f32>) -> f32 {
  let width = i32(textureDimensions(clipTexture).x);
  var index = i32(clipIndex);
  for (var depth = 0; depth < ${MAX_VECTOR_CLIP_DEPTH}; depth++) {
    if (index < 0) { return 1.0; }
    let node = textureLoad(clipTexture, vec2<i32>(index % width, index / width), 0);
    if (node.z < 0.0) {
      let offset = i32(node.y);
      let bounds = textureLoad(clipTexture, vec2<i32>(offset % width, offset / width), 0);
      if (any(point < bounds.xy) || any(point >= bounds.zw)) { return 0.0; }
      index = i32(node.x);
      continue;
    }
    var winding = 0;
    for (var edge = 0; edge < ${MAX_VECTOR_CLIP_EDGES}; edge++) {
      if (edge >= i32(node.z)) { break; }
      let offset = i32(node.y) + edge;
      let line = textureLoad(clipTexture, vec2<i32>(offset % width, offset / width), 0);
      if ((line.y > point.y) != (line.w > point.y)) {
        let x = line.x + (point.y - line.y) / (line.w - line.y) * (line.z - line.x);
        if (x > point.x) { winding += select(-1, 1, line.w > line.y); }
      }
    }
    if (select(winding == 0, abs(winding) % 2 == 0, node.w > 0.5)) { return 0.0; }
    index = i32(node.x);
  }
  return select(0.0, 1.0, index < 0);
}
`;

export const VECTOR_INSTANCE_CLIP_GLSL = `flat in float vVectorClipIndex;\n` +
  VECTOR_CLIP_GLSL.replace("int(uVectorClipIndex)", "int(uVectorClipIndex < -1.5 ? vVectorClipIndex : uVectorClipIndex)");
