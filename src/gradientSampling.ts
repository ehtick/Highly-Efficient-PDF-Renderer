import type { VectorScene } from "./pdfVectorExtractor";
import { GRADIENT_LUT_WIDTH } from "./orderedGradientPaint";
import { sampleGradientMeshChannel } from "./gradientMesh";

/** Metadata A.z disables endpoint extensions; zero preserves legacy HEP behavior. */
export const GRADIENT_DISABLE_START = 1;
export const GRADIENT_DISABLE_END = 2;

/** Shared by native and Three shaders. Result is (parameter, covered). */
export const GRADIENT_PARAMETER_GLSL = `
vec2 heprGradientParameter(vec4 a, vec4 c, vec4 d, vec2 point) {
  int flags = int(a.z + 0.5);
  vec2 axis = d.xy - c.zw;
  vec2 offset = point - c.zw;
  if (a.x < 0.5) {
    float denominator = dot(axis, axis);
    if (denominator <= 1e-12) return vec2(0.0);
    float t = dot(offset, axis) / denominator;
    bool valid = (t >= 0.0 || (flags & 1) == 0) && (t <= 1.0 || (flags & 2) == 0);
    return vec2(t, valid ? 1.0 : 0.0);
  }
  float delta = d.w - d.z;
  float qa = dot(axis, axis) - delta * delta;
  float qb = -2.0 * (dot(offset, axis) + d.z * delta);
  float qc = dot(offset, offset) - d.z * d.z;
  float t0 = -1e20;
  float t1 = -1e20;
  if (abs(qa) <= 1e-10) {
    if (abs(qb) <= 1e-10) return vec2(0.0);
    t0 = -qc / qb;
  } else {
    float discriminant = qb * qb - 4.0 * qa * qc;
    if (discriminant < 0.0) return vec2(0.0);
    float root = sqrt(max(discriminant, 0.0));
    t0 = (-qb - root) / (2.0 * qa);
    t1 = (-qb + root) / (2.0 * qa);
  }
  bool valid0 = t0 > -1e19 && d.z + t0 * delta >= 0.0 &&
    (t0 >= 0.0 || (flags & 1) == 0) && (t0 <= 1.0 || (flags & 2) == 0);
  bool valid1 = t1 > -1e19 && d.z + t1 * delta >= 0.0 &&
    (t1 >= 0.0 || (flags & 1) == 0) && (t1 <= 1.0 || (flags & 2) == 0);
  if (!valid0 && !valid1) return vec2(0.0);
  return vec2(valid0 && (!valid1 || t0 >= t1) ? t0 : t1, 1.0);
}
`;

export const GRADIENT_PARAMETER_WGSL = `
fn heprGradientParameter(a: vec4f, c: vec4f, d: vec4f, point: vec2f) -> vec2f {
  let flags = i32(a.z + 0.5);
  let axis = d.xy - c.zw;
  let offset = point - c.zw;
  if (a.x < 0.5) {
    let denominator = dot(axis, axis);
    if (denominator <= 1e-12) { return vec2f(0.0); }
    let t = dot(offset, axis) / denominator;
    let valid = (t >= 0.0 || (flags & 1) == 0) && (t <= 1.0 || (flags & 2) == 0);
    return vec2f(t, select(0.0, 1.0, valid));
  }
  let delta = d.w - d.z;
  let qa = dot(axis, axis) - delta * delta;
  let qb = -2.0 * (dot(offset, axis) + d.z * delta);
  let qc = dot(offset, offset) - d.z * d.z;
  var t0 = -1e20;
  var t1 = -1e20;
  if (abs(qa) <= 1e-10) {
    if (abs(qb) <= 1e-10) { return vec2f(0.0); }
    t0 = -qc / qb;
  } else {
    let discriminant = qb * qb - 4.0 * qa * qc;
    if (discriminant < 0.0) { return vec2f(0.0); }
    let root = sqrt(max(discriminant, 0.0));
    t0 = (-qb - root) / (2.0 * qa);
    t1 = (-qb + root) / (2.0 * qa);
  }
  let valid0 = t0 > -1e19 && d.z + t0 * delta >= 0.0 &&
    (t0 >= 0.0 || (flags & 1) == 0) && (t0 <= 1.0 || (flags & 2) == 0);
  let valid1 = t1 > -1e19 && d.z + t1 * delta >= 0.0 &&
    (t1 >= 0.0 || (flags & 1) == 0) && (t1 <= 1.0 || (flags & 2) == 0);
  if (!valid0 && !valid1) { return vec2f(0.0); }
  return vec2f(select(t1, t0, valid0 && (!valid1 || t0 >= t1)), 1.0);
}
`;

/** A.w is RGB8 + 1, exactly representable in float32; zero means no background. */
export const GRADIENT_BACKGROUND_GLSL = `
vec4 heprGradientBackground(float encoded) {
  if (encoded < 0.5) return vec4(0.0);
  int rgb = int(encoded) - 1;
  return vec4(float((rgb >> 16) & 255), float((rgb >> 8) & 255), float(rgb & 255), 255.0) / 255.0;
}
`;

export const GRADIENT_BACKGROUND_WGSL = `
fn heprGradientBackground(encoded: f32) -> vec4f {
  if (encoded < 0.5) { return vec4f(0.0); }
  let rgb = i32(encoded) - 1;
  return vec4f(f32((rgb >> 16) & 255), f32((rgb >> 8) & 255), f32(rgb & 255), 255.0) / 255.0;
}
`;

/** Geometry-domain sampling shared by picking and non-GPU inspection/tests. */
export function sampleSceneGradientChannel(scene: VectorScene, index: number, x: number, y: number, channel: number): number {
  if (index < 0) return 1;
  if (index >= scene.gradientCount) return 0;
  const i = index * 4, a = scene.gradientMetaA, b = scene.gradientMetaB, c = scene.gradientMetaC;
  const d = scene.gradientMetaD, e = scene.gradientMetaE;
  const px = b[i] * x + b[i + 2] * y + c[i], py = b[i + 1] * x + b[i + 3] * y + c[i + 1];
  if (a[i + 1] >= 0.5 && (px < e[i] || py < e[i + 1] || px > e[i + 2] || py > e[i + 3])) return 0;
  if (a[i] === 2) {
    const sampled = sampleGradientMeshChannel(scene, index, px, py, channel);
    if (sampled !== null) return sampled;
    const encoded = a[i + 3];
    return encoded < 0.5 ? 0 : channel === 3 ? 1 : (((encoded - 1) >>> ((2 - channel) * 8)) & 255) / 255;
  }
  const ox = px - c[i + 2], oy = py - c[i + 3], dx = d[i] - c[i + 2], dy = d[i + 1] - c[i + 3];
  const flags = Math.round(a[i + 2]);
  const eligible = (t: number): boolean => Number.isFinite(t) &&
    (t >= 0 || (flags & GRADIENT_DISABLE_START) === 0) && (t <= 1 || (flags & GRADIENT_DISABLE_END) === 0);
  let t = NaN;
  if (a[i] < 0.5) {
    const denominator = dx * dx + dy * dy;
    if (denominator > 1e-12) t = (ox * dx + oy * dy) / denominator;
    if (!eligible(t)) t = NaN;
  } else {
    const radius = d[i + 2], delta = d[i + 3] - radius;
    const qa = dx * dx + dy * dy - delta * delta;
    const qb = -2 * (ox * dx + oy * dy + radius * delta), qc = ox * ox + oy * oy - radius * radius;
    let t0 = NaN, t1 = NaN;
    if (Math.abs(qa) <= 1e-10) {
      if (Math.abs(qb) > 1e-10) t0 = -qc / qb;
    } else {
      const discriminant = qb * qb - 4 * qa * qc;
      if (discriminant >= 0) {
        const root = Math.sqrt(discriminant);
        t0 = (-qb - root) / (2 * qa); t1 = (-qb + root) / (2 * qa);
      }
    }
    if (eligible(t0) && radius + t0 * delta >= 0) t = t0;
    if (eligible(t1) && radius + t1 * delta >= 0 && (!Number.isFinite(t) || t1 > t)) t = t1;
  }
  if (!Number.isFinite(t)) {
    const encoded = a[i + 3];
    return encoded < 0.5 ? 0 : channel === 3 ? 1 : (((encoded - 1) >>> ((2 - channel) * 8)) & 255) / 255;
  }
  const sample = Math.max(0, Math.min(1, t)) * (GRADIENT_LUT_WIDTH - 1), lo = Math.floor(sample), fraction = sample - lo;
  const base = index * GRADIENT_LUT_WIDTH * 4;
  const left = scene.gradientLut[base + lo * 4 + channel];
  const right = scene.gradientLut[base + Math.min(lo + 1, GRADIENT_LUT_WIDTH - 1) * 4 + channel];
  return (left * (1 - fraction) + right * fraction) / 255;
}
