import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import * as THREE from "three";

const hooks = registerHooks({ resolve(specifier, context, next) {
  if (context.parentURL?.includes("/src/") && /^\.\.?\//.test(specifier) && !/\.[a-z0-9]+$/i.test(specifier)) {
    return next(`${specifier}.ts`, context);
  }
  return next(specifier, context);
} });

// A folded paint can compute a soft mask made of one gradient fill at each of
// its fragments. The shader cannot run here, so this mirrors its arithmetic on
// the vectors the compositor hands it and checks the result against the scene
// itself: each pixel centre is unprojected onto the page independently, the
// gradient is sampled the way picking samples it, and the outline and clip are
// hit-tested exactly, away from their antialiased edges.
try {
  const { createEmptyVectorScene } = await import("../src/emptyVectorScene.ts");
  const { threeGradientMaskVectors, THREE_GRADIENT_MASK_VECTORS } = await import("../src/threePaintFold.ts");
  const { sampleSceneGradientChannel } = await import("../src/gradientSampling.ts");
  const { paintFoldMaskWeights } = await import("../src/nativePaintFold.ts");
  const f = values => Float32Array.from(values);
  const rect = (x0, y0, x1, y1) => [[x0, y0, x1, y0], [x1, y0, x1, y1], [x1, y1, x0, y1], [x0, y1, x0, y0]];
  const lut = new Uint8Array(2 * 1024 * 4);
  for (let x = 0; x < 1024; x++) {
    // Gradient 0 runs dark red to light green; gradient 1 fades out in alpha.
    lut.set([Math.round(40 + 180 * x / 1023), Math.round(20 + 200 * x / 1023), 30, 255], x * 4);
    lut.set([200, 100, 50, Math.round(255 * (1 - x / 1023))], (1024 + x) * 4);
  }
  const makeScene = ({ outline = rect(0, 0, 100, 80), clip = rect(10, 5, 70, 60), bounded = false, maskGradient = -1,
    type = 0, curved = false, parent = -1 } = {}) => {
    return Object.assign(createEmptyVectorScene(), {
      gradientCount: 2,
      // Axial from (20, 10) to (80, 50); a bounded gradient paints only inside
      // its box and its background elsewhere.
      gradientMetaA: f([type, bounded ? 1 : 0, 0, bounded ? 0x336699 + 1 : 0, 0, 0, 0, 0]),
      gradientMetaB: f([1, 0, 0, 1, 1, 0, 0, 1]),
      gradientMetaC: f([0, 0, 20, 10, 0, 0, 0, 0]),
      gradientMetaD: f([80, 50, 0, 0, 100, 0, 0, 0]),
      gradientMetaE: f([30, 15, 60, 70, 0, 0, 0, 0]),
      gradientLut: lut,
      gradientFillPathCount: 1, gradientFillSegmentCount: outline.length,
      gradientFillPathMetaA: f([0, outline.length, 0, 0]), gradientFillPathMetaB: f([100, 80, 0, 0]),
      gradientFillPathMetaC: f([0, 0, 0, 0.75]), gradientFillPaintMeta: f([0, maskGradient, 0, 0]),
      gradientFillSegmentsA: f(outline.flatMap(([x0, y0]) => [x0, y0, x0, y0])),
      gradientFillSegmentsB: f(outline.flatMap(([, , x1, y1], index) => [x1, y1, curved && index === 1 ? 1 : 0, 0])),
      clipPaths: [
        { parent: -1, fillRule: 0, edges: f(rect(-50, -50, 150, 150).flat()) },
        { parent, fillRule: 0, edges: f(clip.flat()) }
      ],
      drawRuns: [{ kind: "gradient-fill", first: 0, count: 1, clipIndex: 1 }]
    });
  };
  const maskRun = { kind: "gradient-fill", first: 0, count: 1, clipIndex: 1 };

  // Mirrors heprPaintFoldScale's gradient branch, for fold.y = 2.
  const shade = (vectors, px, py, weights) => {
    const v = index => [...vectors.subarray(index * 4, index * 4 + 4)];
    const p = [px, py, 1], dot3 = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
    const h = [dot3(v(0), p), dot3(v(1), p), dot3(v(2), p)];
    const q = [h[0] / h[2], h[1] / h[2]];
    const [a, ends, extra, box] = [v(3), v(4), v(5), v(6)];
    let color = [0, 0, 0, 0];
    if (a[1] < 0.5 || (q[0] >= box[0] && q[1] >= box[1] && q[0] <= box[2] && q[1] <= box[3])) {
      const axis = [ends[2] - ends[0], ends[3] - ends[1]], offset = [q[0] - ends[0], q[1] - ends[1]];
      const t = (offset[0] * axis[0] + offset[1] * axis[1]) / (axis[0] ** 2 + axis[1] ** 2);
      const row = Math.round(extra[3]);
      const x = Math.min(Math.max(t, 0), 1) * 1023, x0 = Math.floor(x), x1 = Math.min(x0 + 1, 1023);
      color = [0, 1, 2, 3].map(c => (lut[(row * 1024 + x0) * 4 + c] * (1 - (x - x0)) + lut[(row * 1024 + x1) * 4 + c] * (x - x0)) / 255);
    }
    let coverage = extra[2];
    for (let index = 7; index < THREE_GRADIENT_MASK_VECTORS; index++) {
      coverage *= Math.min(1, Math.max(0, 0.5 + dot3(v(index), p)));
    }
    const alpha = coverage * color[3];
    const pixel = [color[0] * alpha, color[1] * alpha, color[2] * alpha, alpha];
    return Math.min(1, Math.max(0, pixel.reduce((sum, value, index) => sum + value * weights[index], weights[4])));
  };
  const inside = (edges, x, y) => {
    let winding = 0;
    for (const [x0, y0, x1, y1] of edges) {
      if ((y0 <= y) !== (y1 <= y) && x < x0 + (y - y0) * (x1 - x0) / (y1 - y0)) winding += y1 > y0 ? 1 : -1;
    }
    return winding !== 0;
  };
  const distance = (edges, x, y) => Math.min(...edges.map(([x0, y0, x1, y1]) => {
    const dx = x1 - x0, dy = y1 - y0, t = Math.min(1, Math.max(0, ((x - x0) * dx + (y - y0) * dy) / (dx * dx + dy * dy)));
    return Math.hypot(x - x0 - t * dx, y - y0 - t * dy);
  }));

  const width = 160, height = 120;
  const views = {
    flat: new THREE.Matrix4().makeScale(2 / 110, 2 / 90, 1).premultiply(new THREE.Matrix4().makeTranslation(-0.9, -0.85, 0)),
    tilted: (() => {
      const camera = new THREE.PerspectiveCamera(50, width / height, 1, 1000);
      camera.position.set(40, -60, 110); camera.lookAt(50, 40, 0); camera.updateMatrixWorld();
      return new THREE.Matrix4().multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    })()
  };
  const content = { subtype: "Luminosity", backdrop: [0.2, 0.3, 0.1], children: [] };
  const weights = paintFoldMaskWeights(content);
  const luminosity = rgba => weights[4] + rgba.reduce((sum, value, index) => sum + value * weights[index], 0);
  for (const bounded of [false, true]) for (const [name, clipFromData] of Object.entries(views)) {
    for (const topDown of [false, true]) {
      const scene = makeScene({ bounded });
      const vectors = threeGradientMaskVectors(scene, maskRun, undefined, clipFromData, width, height, topDown);
      assert.ok(vectors, `${name}: an axial gradient over a rectangle under one rectangular clip is computed`);
      const unproject = clipFromData.clone().invert();
      // Where this pixel's ray meets the page plane.
      const page = (px, py) => {
        const ndc = [px / width * 2 - 1, (topDown ? 1 - py / height : py / height) * 2 - 1];
        const near = new THREE.Vector3(ndc[0], ndc[1], -1).applyMatrix4(unproject);
        const far = new THREE.Vector3(ndc[0], ndc[1], 1).applyMatrix4(unproject);
        const t = near.z / (near.z - far.z);
        return [near.x + (far.x - near.x) * t, near.y + (far.y - near.y) * t];
      };
      let checked = 0, covered = 0;
      for (let py = 0.5; py < height; py += 3) for (let px = 0.5; px < width; px += 3) {
        const [x, y] = page(px, py);
        const outline = rect(0, 0, 100, 80), clip = rect(10, 5, 70, 60);
        // Away from the edges' antialiasing, coverage is exactly in or out.
        const margin = 1.5 * Math.max(Math.hypot(...page(px + 1, py).map((v, i) => v - [x, y][i])),
          Math.hypot(...page(px, py + 1).map((v, i) => v - [x, y][i])));
        if (distance(outline, x, y) < margin || distance(clip, x, y) < margin) continue;
        const shown = inside(outline, x, y) && inside(clip, x, y);
        const color = [0, 1, 2, 3].map(channel => sampleSceneGradientChannel(scene, 0, x, y, channel));
        const alpha = shown ? color[3] * 0.75 : 0;
        const expected = Math.min(1, Math.max(0, luminosity([color[0] * alpha, color[1] * alpha, color[2] * alpha, alpha])));
        const actual = shade(vectors, px, py, weights);
        assert.ok(Math.abs(actual - expected) < 2e-3,
          `${name}${topDown ? " top-down" : ""}${bounded ? " bounded" : ""} pixel (${px}, ${py}) at (${x.toFixed(2)}, ${y.toFixed(2)}): ` +
          `${actual} != ${expected}`);
        checked++; if (shown) covered++;
      }
      assert.ok(checked > 400 && covered > 50, `${name}: the comparison covers the paint (${covered} of ${checked})`);
    }
  }

  // An edge through pixel centres is half covered, as the paint's box filter has it.
  const aligned = new THREE.Matrix4().makeScale(2 / width, 2 / height, 1).premultiply(new THREE.Matrix4().makeTranslation(-1, -1, 0));
  const edgeScene = makeScene({ outline: rect(0, 0, 200, 200), clip: rect(20.5, -10, 300, 300) });
  const edgeVectors = threeGradientMaskVectors(edgeScene, maskRun, undefined, aligned, width, height, false);
  const alphaWeights = paintFoldMaskWeights({ subtype: "Alpha", children: [] });
  const opaque = shade(edgeVectors, 40.5, 30.5, alphaWeights);
  assert.ok(Math.abs(shade(edgeVectors, 20.5, 30.5, alphaWeights) - opaque / 2) < 1e-6, "an edge through a pixel centre covers half of it");
  assert.equal(shade(edgeVectors, 18.5, 30.5, alphaWeights), 0, "a pixel wholly outside the clip is uncovered");

  // A clip the folded paint already applies adds nothing; only the mask paint's
  // one further clip counts, and a chain the fold does not share keeps the surface.
  const shared = threeGradientMaskVectors(makeScene(), maskRun, 1, aligned, width, height, false);
  assert.equal(shared.slice(4 * 11).every((value, index) => index % 4 === 2 ? value === 1 : value === 0), true,
    "the folded paint's own clip leaves only the outline's four planes");
  assert.ok(threeGradientMaskVectors(makeScene({ parent: 0 }), maskRun, 0, aligned, width, height, false),
    "a clip nested in the folded paint's chain is computed");
  assert.equal(threeGradientMaskVectors(makeScene({ parent: 0 }), maskRun, undefined, aligned, width, height, false), null,
    "a clip whose parent the folded paint does not apply keeps the rendered mask");

  // Anything else keeps the rendered mask.
  const refused = {
    "a curved outline": makeScene({ curved: true }),
    "a concave clip": makeScene({ clip: [[10, 5, 70, 5], [70, 5, 40, 30], [40, 30, 70, 60], [70, 60, 10, 60], [10, 60, 10, 5]] }),
    "an open clip": makeScene({ clip: rect(10, 5, 70, 60).slice(0, 3) }),
    "a gradient under another gradient's mask": makeScene({ maskGradient: 1 }),
    "a patch-mesh gradient": makeScene({ type: 2 })
  };
  for (const [reason, scene] of Object.entries(refused)) {
    assert.equal(threeGradientMaskVectors(scene, maskRun, undefined, aligned, width, height, false), null, reason);
  }
  const behind = new THREE.Matrix4().set(1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0.02, 0, 0, -1);
  assert.equal(threeGradientMaskVectors(makeScene(), maskRun, undefined, behind, width, height, false), null,
    "a paint reaching behind the camera keeps the rendered mask");
  console.log("Three gradient mask folds: projected gradient, outline and clip coverage, clip chains and refusals passed");
} finally { hooks.deregister(); }
