import { MAX_VECTOR_CLIP_DEPTH, MAX_VECTOR_CLIP_EDGES } from "./vectorClips";

// The width is supplied by the caller so derivatives can be taken before any
// divergent control flow or discard. A distance probe limits supersampling to
// boundary pixels; winding samples preserve holes and overlapping subpaths,
// whose internal edges must not become translucent distance-field seams.
function vectorClipGlsl(antialias: boolean): string {
  return `${antialias ? VECTOR_CLIP_SAMPLE_GLSL : ""}
float ${antialias ? "heprVectorClipAA(vec2 point, float aaWidth)" : "heprVectorClip(vec2 point)"} {
  ${antialias ? "" : "const float aaWidth = 0.0;"}
  bool needsSampling = false;
  float radius = aaWidth * 0.75;${antialias ? `
  // A 4x4 grid of samples, one bit each (4 * row + column); nodes near the
  // pixel clear the bits of samples outside them.
  vec4 sampleX = point.x + VECTOR_CLIP_SAMPLE_OFFSETS * aaWidth;
  vec4 sampleY = point.y + VECTOR_CLIP_SAMPLE_OFFSETS * aaWidth;
  uint samples = 0xFFFFu;` : ""}
  highp int index = int(uVectorClipIndex);
  for (highp int depth = 0; depth < ${MAX_VECTOR_CLIP_DEPTH}; depth++) {
    if (index < 0) break;
    vec4 node = heprClipTexel(index);
    if (node.z < 0.0) {
      vec4 bounds = heprClipTexel(int(node.y));
      if (aaWidth > 0.0) {
        if (any(greaterThanEqual(bounds.xy, bounds.zw))) return 0.0;
        vec2 inset = min(point - bounds.xy, bounds.zw - point);
        if (min(inset.x, inset.y) <= -radius) return 0.0;${antialias ? `
        if (min(inset.x, inset.y) < radius) {
          needsSampling = true;
          samples &= heprClipRectSamples(bounds, sampleX, sampleY);
        }` : `
        needsSampling = needsSampling || min(inset.x, inset.y) < radius;`}
      } else {
        // Match polygon winding at boundaries: include min, exclude max.
        if (any(lessThan(point, bounds.xy)) || any(greaterThanEqual(point, bounds.zw))) return 0.0;
      }
      index = int(node.x);
      continue;
    }
    highp int flags = int(node.w);
    highp int winding = 0;
    float minDistance = radius;
    if ((flags & 4) != 0) {
      // Cell storage (vectorCellIndex.ts). The winding comes from the cell
      // holding the point: its pieces, plus closures standing in for all
      // geometry right of the cell's column. The distance probe reads the
      // finest level whose cells span its diameter, so at most four hold every
      // edge within reach; point tests read the finest level.
      vec4 cells = heprClipTexel(int(node.y));
      vec4 origin = heprClipTexel(int(node.y) + 1);
      float level = radius > 0.0 ? heprClipCellLevel(cells, 2.0 * radius) : 0.0;
      float size = cells.z * exp2(level * cells.w);
      vec4 grid = heprClipTexel(int(cells.x + level));
      vec2 lastCell = grid.yz - 1.0;
      vec2 home = clamp(floor((point - origin.xy) / size), vec2(0.0), lastCell);
      vec4 cell = heprClipTexel(int(grid.x + home.y * grid.y + home.x));
      for (highp int piece = 0; piece < ${MAX_VECTOR_CLIP_EDGES}; piece++) {
        if (piece >= int(cell.y)) break;
        vec4 line = heprClipTexel(int(cell.x) + piece);
        if ((line.y > point.y) != (line.w > point.y)) {
          float x = line.x + (point.y - line.y) / (line.w - line.y) * (line.z - line.x);
          if (x > point.x) winding += line.w > line.y ? 1 : -1;
        }
      }
      for (highp int closure = 0; closure < ${MAX_VECTOR_CLIP_EDGES}; closure++) {
        if (closure >= int(cell.w)) break;
        vec4 pair = heprClipTexel(int(cell.z) + closure);
        if (pair.x <= point.y) winding -= int(pair.y);
        if (pair.z <= point.y) winding -= int(pair.w);
      }
      if (aaWidth > 0.0) {
        vec2 near = clamp(floor((point - vec2(radius) - origin.xy) / size), vec2(0.0), lastCell);
        vec2 far = clamp(floor((point + vec2(radius) - origin.xy) / size), vec2(0.0), lastCell);
        for (highp int row = int(near.y); row <= int(far.y); row++) {
          for (highp int column = int(near.x); column <= int(far.x); column++) {
            vec4 probe = heprClipTexel(int(grid.x) + row * int(grid.y) + column);
            for (highp int piece = 0; piece < ${MAX_VECTOR_CLIP_EDGES}; piece++) {
              if (piece >= int(probe.y)) break;
              vec4 line = heprClipTexel(int(probe.x) + piece);
              if (all(greaterThanEqual(point, min(line.xy, line.zw) - vec2(radius))) &&
                  all(lessThanEqual(point, max(line.xy, line.zw) + vec2(radius)))) {
                vec2 delta = line.zw - line.xy;
                float squaredLength = dot(delta, delta);
                float t = squaredLength > 0.0 ? clamp(dot(point - line.xy, delta) / squaredLength, 0.0, 1.0) : 0.0;
                minDistance = min(minDistance, length(point - (line.xy + t * delta)));
              }
            }
          }
        }
      }
    } else {
      highp int firstBand = 0;
      highp int lastBand = 0;
      highp int rowBand = 0;
      vec4 bands = vec4(0.0);
      if ((flags & 2) != 0) {
        bands = heprClipTexel(int(node.y));
        // Clamp in float before converting: far-offscreen points can exceed i32.
        rowBand = int(clamp(floor((point.y - bands.y) / bands.z), 0.0, bands.w - 1.0));
        firstBand = int(clamp(floor((point.y - radius - bands.y) / bands.z), 0.0, bands.w - 1.0));
        lastBand = int(clamp(floor((point.y + radius - bands.y) / bands.z), 0.0, bands.w - 1.0));
      }
      for (highp int band = firstBand; band <= lastBand; band++) {
        highp int firstEdge = int(node.y);
        highp int edgeCount = int(node.z);
        if ((flags & 2) != 0) {
          vec4 range = heprClipTexel(int(bands.x) + band);
          firstEdge = int(range.x);
          edgeCount = int(range.y);
        }
        for (highp int edge = 0; edge < ${MAX_VECTOR_CLIP_EDGES}; edge++) {
          if (edge >= edgeCount) break;
          vec4 line = heprClipTexel(firstEdge + edge);
          // An edge can appear in several bands; only the center row counts it.
          if (band == rowBand && (line.y > point.y) != (line.w > point.y)) {
            float x = line.x + (point.y - line.y) / (line.w - line.y) * (line.z - line.x);
            if (x > point.x) winding += line.w > line.y ? 1 : -1;
          }
          // Distant edges affect winding only. Keep distance work at the boundary.
          if (aaWidth > 0.0 && all(greaterThanEqual(point, min(line.xy, line.zw) - vec2(radius))) &&
              all(lessThanEqual(point, max(line.xy, line.zw) + vec2(radius)))) {
            vec2 delta = line.zw - line.xy;
            float squaredLength = dot(delta, delta);
            float t = squaredLength > 0.0 ? clamp(dot(point - line.xy, delta) / squaredLength, 0.0, 1.0) : 0.0;
            minDistance = min(minDistance, length(point - (line.xy + t * delta)));
          }
        }
      }
    }
    bool inside = (flags & 1) != 0 ? (abs(winding) % 2 != 0) : winding != 0;
    if (aaWidth > 0.0) {
      if (minDistance < radius) {
        needsSampling = true;${antialias ? `
        samples &= heprClipPolygonSamples(node, flags, sampleX, sampleY, radius);
        if (samples == 0u) return 0.0;` : ""}
      } else if (!inside) return 0.0;
    } else if (!inside) return 0.0;
    index = int(node.x);
  }
  if (index >= 0) return 0.0;
  ${antialias ? `
  // The samples lie within the probe radius, so a node without an edge in
  // reach holds all of them or none. The mask covers the whole intersection,
  // so coincident ancestors do not fade twice.
  if (needsSampling) return heprSampleCoverage(samples);` : ""}
  return 1.0;
}
`;
}

// Sample offsets in pixels: the centres of a 4x4 grid over the pixel. The
// farthest lies 0.53 pixels from the centre, inside the 0.75-pixel probe.
const VECTOR_CLIP_SAMPLE_GLSL = `
const vec4 VECTOR_CLIP_SAMPLE_OFFSETS = vec4(-0.375, -0.125, 0.125, 0.375);

uint heprSampleBits(vec4 inside) {
  return (inside.x > 0.5 ? 1u : 0u) | (inside.y > 0.5 ? 2u : 0u) |
    (inside.z > 0.5 ? 4u : 0u) | (inside.w > 0.5 ? 8u : 0u);
}

uint heprSampleGrid(uint row0, uint row1, uint row2, uint row3) {
  return row0 | (row1 << 4) | (row2 << 8) | (row3 << 12);
}

float heprSampleCoverage(uint samples) {
  uint count = samples - ((samples >> 1) & 0x5555u);
  count = (count & 0x3333u) + ((count >> 2) & 0x3333u);
  count = (count + (count >> 4)) & 0x0F0Fu;
  return float((count + (count >> 8)) & 0x1Fu) * 0.0625;
}

// The point test's rule: include min, exclude max.
uint heprClipRectSamples(vec4 bounds, vec4 sampleX, vec4 sampleY) {
  uint columns = heprSampleBits(step(bounds.xxxx, sampleX) * (1.0 - step(bounds.zzzz, sampleX)));
  vec4 rows = step(bounds.yyyy, sampleY) * (1.0 - step(bounds.wwww, sampleY));
  return heprSampleGrid(rows.x > 0.5 ? columns : 0u, rows.y > 0.5 ? columns : 0u,
    rows.z > 0.5 ? columns : 0u, rows.w > 0.5 ? columns : 0u);
}

// One edge's ray crossings, with the point test's arithmetic, for the samples
// whose edge list this is: rows and columns select them.
void heprClipSampleCrossings(vec4 line, vec4 sampleX, vec4 sampleY, vec4 rows, vec4 columns,
    inout vec4 winding0, inout vec4 winding1, inout vec4 winding2, inout vec4 winding3) {
  vec4 crossing = abs(vec4(greaterThan(vec4(line.y), sampleY)) - vec4(greaterThan(vec4(line.w), sampleY))) * rows;
  if (any(greaterThan(crossing, vec4(0.0)))) {
    vec4 x = line.x + (sampleY - line.y) / (line.w - line.y) * (line.z - line.x);
    crossing *= line.w > line.y ? 1.0 : -1.0;
    winding0 += crossing.x * columns * vec4(greaterThan(x.xxxx, sampleX));
    winding1 += crossing.y * columns * vec4(greaterThan(x.yyyy, sampleX));
    winding2 += crossing.z * columns * vec4(greaterThan(x.zzzz, sampleX));
    winding3 += crossing.w * columns * vec4(greaterThan(x.wwww, sampleX));
  }
}

uint heprSampleInside(vec4 winding, bool evenOdd) {
  return heprSampleBits(evenOdd ? mod(abs(winding), 2.0) : abs(winding));
}

// Samples inside one polygon node. Only called near its boundary, so every
// sample lies within the distance probe's cells or bands.
uint heprClipPolygonSamples(vec4 node, highp int flags, vec4 sampleX, vec4 sampleY, float radius) {
  vec4 winding0 = vec4(0.0);
  vec4 winding1 = vec4(0.0);
  vec4 winding2 = vec4(0.0);
  vec4 winding3 = vec4(0.0);
  if ((flags & 4) != 0) {
    vec4 cells = heprClipTexel(int(node.y));
    vec4 origin = heprClipTexel(int(node.y) + 1);
    float level = heprClipCellLevel(cells, 2.0 * radius);
    float size = cells.z * exp2(level * cells.w);
    vec4 grid = heprClipTexel(int(cells.x + level));
    // As in the point test, each sample takes its own cell's pieces and
    // closures; the samples span at most two cells each way.
    vec4 columnOf = clamp(floor((sampleX - origin.x) / size), 0.0, grid.y - 1.0);
    vec4 rowOf = clamp(floor((sampleY - origin.y) / size), 0.0, grid.z - 1.0);
    for (highp int row = int(rowOf.x); row <= int(rowOf.w); row++) {
      vec4 rows = vec4(equal(rowOf, vec4(float(row))));
      for (highp int column = int(columnOf.x); column <= int(columnOf.w); column++) {
        vec4 columns = vec4(equal(columnOf, vec4(float(column))));
        vec4 cell = heprClipTexel(int(grid.x) + row * int(grid.y) + column);
        for (highp int piece = 0; piece < ${MAX_VECTOR_CLIP_EDGES}; piece++) {
          if (piece >= int(cell.y)) break;
          heprClipSampleCrossings(heprClipTexel(int(cell.x) + piece), sampleX, sampleY, rows, columns,
            winding0, winding1, winding2, winding3);
        }
        for (highp int closure = 0; closure < ${MAX_VECTOR_CLIP_EDGES}; closure++) {
          if (closure >= int(cell.w)) break;
          vec4 pair = heprClipTexel(int(cell.z) + closure);
          vec4 below = (pair.y * step(vec4(pair.x), sampleY) + pair.w * step(vec4(pair.z), sampleY)) * rows;
          winding0 -= below.x * columns;
          winding1 -= below.y * columns;
          winding2 -= below.z * columns;
          winding3 -= below.w * columns;
        }
      }
    }
  } else {
    vec4 bands = vec4(0.0);
    vec4 bandOf = vec4(0.0);
    if ((flags & 2) != 0) {
      bands = heprClipTexel(int(node.y));
      bandOf = clamp(floor((sampleY - bands.y) / bands.z), 0.0, bands.w - 1.0);
    }
    for (highp int band = int(bandOf.x); band <= int(bandOf.w); band++) {
      highp int firstEdge = int(node.y);
      highp int edgeCount = int(node.z);
      if ((flags & 2) != 0) {
        vec4 range = heprClipTexel(int(bands.x) + band);
        firstEdge = int(range.x);
        edgeCount = int(range.y);
      }
      // An edge can appear in several bands; each sample row counts its own.
      vec4 rows = vec4(equal(bandOf, vec4(float(band))));
      for (highp int edge = 0; edge < ${MAX_VECTOR_CLIP_EDGES}; edge++) {
        if (edge >= edgeCount) break;
        heprClipSampleCrossings(heprClipTexel(firstEdge + edge), sampleX, sampleY, rows, vec4(1.0),
          winding0, winding1, winding2, winding3);
      }
    }
  }
  bool evenOdd = (flags & 1) != 0;
  return heprSampleGrid(heprSampleInside(winding0, evenOdd), heprSampleInside(winding1, evenOdd),
    heprSampleInside(winding2, evenOdd), heprSampleInside(winding3, evenOdd));
}
`;

export const VECTOR_CLIP_GLSL = `
uniform highp sampler2D uVectorClipTex;
uniform float uVectorClipIndex;
vec4 heprClipTexel(highp int index) {
  highp int width = textureSize(uVectorClipTex, 0).x;
  return texelFetch(uVectorClipTex, ivec2(index % width, index / width), 0);
}

// The finest level whose cells span a probe of the given diameter.
float heprClipCellLevel(vec4 cells, float reach) {
  float level = clamp(ceil(log2(max(reach / cells.z, 1.0)) / cells.w), 0.0, cells.y - 1.0);
  if (cells.z * exp2(level * cells.w) < reach && level < cells.y - 1.0) level += 1.0;
  return level;
}
` + vectorClipGlsl(false) + vectorClipGlsl(true);

function vectorClipWgsl(antialias: boolean): string {
  return `
fn ${antialias ? "heprVectorClipAA" : "heprVectorClip"}(point: vec2<f32>, clipIndex: f32, clipTexture: texture_2d<f32>${antialias ? ", aaWidth: f32" : ""}) -> f32 {
  ${antialias ? "" : "let aaWidth = 0.0;"}
  let width = i32(textureDimensions(clipTexture).x);
  var needsSampling = false;
  let radius = aaWidth * 0.75;
  var index = i32(clipIndex);
  for (var depth = 0; depth < ${MAX_VECTOR_CLIP_DEPTH}; depth++) {
    if (index < 0) { break; }
    let node = textureLoad(clipTexture, vec2<i32>(index % width, index / width), 0);
    if (node.z < 0.0) {
      let offset = i32(node.y);
      let bounds = textureLoad(clipTexture, vec2<i32>(offset % width, offset / width), 0);
      if (aaWidth > 0.0) {
        if (any(bounds.xy >= bounds.zw)) { return 0.0; }
        let inset = min(point - bounds.xy, bounds.zw - point);
        if (min(inset.x, inset.y) <= -radius) { return 0.0; }
        needsSampling = needsSampling || min(inset.x, inset.y) < radius;
      } else {
        if (any(point < bounds.xy) || any(point >= bounds.zw)) { return 0.0; }
      }
      index = i32(node.x);
      continue;
    }
    var firstBand = 0;
    var lastBand = 0;
    var rowBand = 0;
    var bands = vec4<f32>(0.0);
    if (node.w >= 2.0) {
      let offset = i32(node.y);
      bands = textureLoad(clipTexture, vec2<i32>(offset % width, offset / width), 0);
      rowBand = i32(clamp(floor((point.y - bands.y) / bands.z), 0.0, bands.w - 1.0));
      firstBand = i32(clamp(floor((point.y - radius - bands.y) / bands.z), 0.0, bands.w - 1.0));
      lastBand = i32(clamp(floor((point.y + radius - bands.y) / bands.z), 0.0, bands.w - 1.0));
    }
    var winding = 0;
    var minDistance = radius;
    for (var band = firstBand; band <= lastBand; band++) {
      var firstEdge = i32(node.y);
      var edgeCount = i32(node.z);
      if (node.w >= 2.0) {
        let tableOffset = i32(bands.x) + band;
        let range = textureLoad(clipTexture, vec2<i32>(tableOffset % width, tableOffset / width), 0);
        firstEdge = i32(range.x);
        edgeCount = i32(range.y);
      }
      for (var edge = 0; edge < ${MAX_VECTOR_CLIP_EDGES}; edge++) {
        if (edge >= edgeCount) { break; }
        let offset = firstEdge + edge;
        let line = textureLoad(clipTexture, vec2<i32>(offset % width, offset / width), 0);
        if (band == rowBand && (line.y > point.y) != (line.w > point.y)) {
          let x = line.x + (point.y - line.y) / (line.w - line.y) * (line.z - line.x);
          if (x > point.x) { winding += select(-1, 1, line.w > line.y); }
        }
        if (aaWidth > 0.0 && all(point >= min(line.xy, line.zw) - vec2<f32>(radius)) &&
            all(point <= max(line.xy, line.zw) + vec2<f32>(radius))) {
          let delta = line.zw - line.xy;
          let squaredLength = dot(delta, delta);
          var t = 0.0;
          if (squaredLength > 0.0) { t = clamp(dot(point - line.xy, delta) / squaredLength, 0.0, 1.0); }
          minDistance = min(minDistance, length(point - (line.xy + t * delta)));
        }
      }
    }
    let inside = select(winding != 0, abs(winding) % 2 != 0, (i32(node.w) & 1) != 0);
    if (aaWidth > 0.0) {
      if (minDistance < radius) { needsSampling = true; }
      else if (!inside) { return 0.0; }
    } else if (!inside) { return 0.0; }
    index = i32(node.x);
  }
  if (index >= 0) { return 0.0; }
  ${antialias ? `
  if (needsSampling) {
    var coverage = 0.0;
    for (var y = 0; y < 4; y++) {
      for (var x = 0; x < 4; x++) {
        let offset = (vec2<f32>(f32(x), f32(y)) + vec2<f32>(0.5)) * 0.25 - vec2<f32>(0.5);
        coverage += heprVectorClip(point + offset * aaWidth, clipIndex, clipTexture);
      }
    }
    return coverage * 0.0625;
  }` : ""}
  return 1.0;
}
`;
}

export const VECTOR_CLIP_WGSL = vectorClipWgsl(false);
export const VECTOR_CLIP_AA_WGSL = vectorClipWgsl(true) + VECTOR_CLIP_WGSL;

export const VECTOR_INSTANCE_CLIP_GLSL = `flat in float vVectorClipIndex;\n` +
  VECTOR_CLIP_GLSL.replaceAll("int(uVectorClipIndex)", "int(uVectorClipIndex < -1.5 ? vVectorClipIndex : uVectorClipIndex)");
