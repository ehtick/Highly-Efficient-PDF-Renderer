import assert from "node:assert/strict";
import { registerHooks } from "node:module";

const hooks = registerHooks({ resolve(s, c, n) {
  return n(c.parentURL?.includes("/src/") && /^\.\.?\//.test(s) && !/\.[a-z0-9]+$/i.test(s) ? `${s}.ts` : s, c);
} });
try {
  const { createEmptyVectorScene } = await import("../src/emptyVectorScene.ts");
  const { VectorStrokeRedundancy } = await import("../src/vectorStrokeRedundancy.ts");
  const line = (a, b, extras = {}) => ({ a: [a, 0], b: [b, 0], ...extras });
  const makeScene = (lines, runs) => {
    const scene = createEmptyVectorScene();
    scene.segmentCount = lines.length;
    for (const key of ["endpoints", "primitiveMeta", "primitiveBounds", "styles"]) scene[key] = new Float32Array(lines.length * 4);
    lines.forEach((line, id) => {
      scene.endpoints.set([...line.a, ...(line.control ?? line.b)], id * 4);
      scene.primitiveMeta.set([...line.b, line.control ? 1 : 0, (line.flags ?? 0) * 2 + (line.alpha ?? 1)], id * 4);
      scene.styles.set([line.width ?? 1, ...(line.color ?? [0, 0, 0])], id * 4);
      scene.primitiveBounds.set(line.clip ?? [-100, -100, 100, 100], id * 4);
    });
    scene.drawRuns = runs ?? [{ kind: "stroke", first: 0, count: lines.length }];
    return scene;
  };
  const retained = (core, ids) => { core.update(ids); return ids.filter(id => core.isRetained(id)); };

  const basic = makeScene([line(0, 10), line(2, 8), line(10, 0), line(9, 12)]);
  const original = structuredClone(basic);
  const core = new VectorStrokeRedundancy(basic);
  assert(core.isRetained(1), "before the first selection nothing is suppressed");
  assert.deepEqual(retained(core, [0, 1, 2, 3]), [2, 3], "later duplicate covers contained and reversed lines");
  assert.equal(core.culledCount, 2);
  assert.deepEqual(retained(core, [1, 3]), [1, 3], "a hidden or viewport-culled cover must immediately reveal its source");
  assert.equal(core.culledCount, 0);
  assert.deepEqual(retained(core, [3, 1, 0]), [3, 0], "caller selection traversal does not establish paint order");
  core.update(new Uint32Array([1, 2, 3]), 1);
  assert(core.isRetained(1), "unused capacity cannot cover selected geometry");
  core.update([]);
  assert.equal(core.culledCount, 0);
  assert.deepEqual(basic, original, "no source arrays, ranges, conditions, or counts are compacted");

  const layers = makeScene([line(0, 10), line(0, 10)], [
    { kind: "stroke", first: 0, count: 1, optionalContent: 0 },
    { kind: "stroke", first: 1, count: 1, optionalContent: 1 }
  ]);
  const layerCore = new VectorStrokeRedundancy(layers);
  assert.deepEqual(retained(layerCore, [0, 1]), [1], "currently visible OCGs may share a render representative");
  for (const id of [0, 1, 0]) assert.deepEqual(retained(layerCore, [id]), [id]);

  const widths = makeScene([line(0, 10), line(2, 8, { width: 2 }), line(2, 8, { width: 0.5 }),
    line(0, 10, { flags: 2 }), line(0, 10, { flags: 1 }), line(0, 10, { flags: 1, width: 500 })]);
  assert.deepEqual(retained(new VectorStrokeRedundancy(widths), [0, 1, 2, 3, 4, 5]), [0, 1, 3, 5],
    "wider children and cap/hairline differences survive; hairline source width does not affect screen coverage");
  const alpha = makeScene([line(0, 10, { alpha: 0.5 }), line(0, 10, { alpha: 0.5 }), line(0, 10)]);
  assert.deepEqual(retained(new VectorStrokeRedundancy(alpha), [0, 1, 2]), [0, 1, 2]);
  const curves = makeScene([line(0, 10, { control: [5, 0] }), line(0, 10), line(0, 0), line(0, 0)]);
  assert.deepEqual(retained(new VectorStrokeRedundancy(curves), [0, 1, 2, 3]), [0, 1, 2, 3], "curves and point caps remain untouched");
  const noEpsilon = makeScene([line(0, 10), line(-0.01, 10), line(0, 10, { a: [0, 0.001], b: [10, 0.001] }),
    line(0, 10, { a: [0, 0.001], b: [10, 0.002] })]);
  assert.deepEqual(retained(new VectorStrokeRedundancy(noEpsilon), [0, 2, 3]), [0, 2, 3], "nearby and nearly parallel lines are not duplicates");
  assert.deepEqual(retained(new VectorStrokeRedundancy(noEpsilon), [0, 1]), [1], "containment never shortens the covering interval");
  const diagonal = makeScene([line(0, 0, { a: [0, 0], b: [10, 20] }), line(0, 0, { a: [1, 2], b: [8, 16] })]);
  assert.deepEqual(retained(new VectorStrokeRedundancy(diagonal), [0, 1]), [0], "exact non-axis-aligned containment is supported");

  const clipped = makeScene([line(0, 10, { flags: 4 }), line(0, 10, { flags: 4, clip: [-1, -1, 5, 1] }),
    line(0, 10, { flags: 4 })]);
  assert.deepEqual(retained(new VectorStrokeRedundancy(clipped), [0, 1, 2]), [1, 2], "primitive clip rectangles must match exactly");
  const differentClips = makeScene([line(0, 10), line(0, 10)], [
    { kind: "stroke", first: 0, count: 1, clipIndex: 0 }, { kind: "stroke", first: 1, count: 1, clipIndex: 1 }
  ]);
  assert.deepEqual(retained(new VectorStrokeRedundancy(differentClips), [0, 1]), [0, 1], "geometric clip roots also fence coverage");

  const withBarrier = (kind, color = [1, 0, 0]) => {
    const scene = makeScene([line(0, 10), line(0, 10)], [
      { kind: "stroke", first: 0, count: 1 }, { kind, first: 0, count: 1 }, { kind: "stroke", first: 1, count: 1 }
    ]);
    scene.fillPathMetaB = new Float32Array([0, 0, color[0], color[1]]);
    scene.fillPathMetaC = new Float32Array([0, 0, color[2], 1]);
    scene.textInstanceC = new Float32Array([...color, 1]);
    return scene;
  };
  for (const kind of ["fill", "text", "raster", "gradient-fill", "gradient-stroke"]) {
    assert.deepEqual(retained(new VectorStrokeRedundancy(withBarrier(kind)), [0, 1]), [0, 1], `${kind} preserves the overlapping painter-order dependency`);
  }
  for (const kind of ["fill", "text"]) {
    assert.deepEqual(retained(new VectorStrokeRedundancy(withBarrier(kind, [0, 0, 0])), [0, 1]), [1],
      `same uploaded RGB ${kind} coverage can commute within a monochrome domain`);
  }
  const quantizedText = withBarrier("text", [0.5, 0.5, 0.5]);
  for (let id = 0; id < 2; id++) quantizedText.styles.set([1, 0.5, 0.5, 0.5], id * 4);
  assert.deepEqual(retained(new VectorStrokeRedundancy(quantizedText), [0, 1]), [0, 1], "text RGBA8 rounding must match the float stroke RGB");
  const blend = makeScene([line(0, 10), line(0, 10)], [{ kind: "stroke", first: 0, count: 2, blendMode: "Multiply" }]);
  assert.deepEqual(retained(new VectorStrokeRedundancy(blend), [0, 1]), [0, 1]);
  const mixed = makeScene([line(0, 10), line(0, 10, { color: [1, 0, 0] }), line(0, 10)]);
  assert.deepEqual(retained(new VectorStrokeRedundancy(mixed), [0, 1, 2]), [0, 1, 2], "mixed-color source runs are conservative barriers");

  const group = { kind: "group", children: [{ kind: "draw", runIndex: 0 }], alpha: 1,
    isolated: false, knockout: false, blendMode: "Normal" };
  for (const effect of [{ alpha: 0.5 }, { knockout: true }, { blendMode: "Multiply" },
    { softMask: { children: [], subtype: "Alpha" } }]) {
    const scene = makeScene([line(0, 10), line(0, 10)]);
    scene.paintGraph = { roots: [{ ...group, ...effect }] };
    assert.deepEqual(retained(new VectorStrokeRedundancy(scene), [0, 1]), [0, 1], "compositing scenes retain canonical submissions");
  }
  const flatGraph = makeScene([line(0, 10), line(0, 10)]);
  flatGraph.paintGraph = { roots: [{ ...group, isolated: true }] };
  assert.deepEqual(retained(new VectorStrokeRedundancy(flatGraph), [0, 1]), [1], "an equivalent flat Normal group needs no special barrier");

  const lodGeometry = makeScene([line(0, 10), line(0, 10), line(0, 10), line(1, 9)]);
  const lodCore = new VectorStrokeRedundancy(layers, { scene: lodGeometry, sourceRuns: new Uint32Array([0, 1, 0, 1]) });
  assert.deepEqual(retained(lodCore, [1, 2, 3]), [1], "combined LOD stores compare only the currently selected primitives");
  assert.deepEqual(retained(lodCore, [3]), [3], "a dormant exact or LOD cover cannot suppress the current level");

  const incrementalScene = makeScene([line(0, 10), line(2, 8),
    line(0, 10, { a: [0, 2], b: [10, 2] }), line(2, 8, { a: [2, 2], b: [8, 2] }),
    line(0, 10, { a: [0, 5], b: [10, 5] })]);
  const incremental = new VectorStrokeRedundancy(incrementalScene);
  assert.deepEqual(retained(incremental, [0, 1, 2, 3, 4]), [0, 2, 4]);
  const clearCoverage = incremental.coverage.fill.bind(incremental.coverage);
  let rebuilt = 0;
  incremental.coverage.fill = (...args) => { rebuilt++; return clearCoverage(...args); };
  assert.deepEqual(retained(incremental, [4, 3, 2, 1, 0]), [4, 2, 0]);
  assert.equal(rebuilt, 0, "a changed traversal order reuses every group's coverage decisions");
  assert.equal(incremental.culledCount, 2);
  assert.deepEqual(retained(incremental, [0, 2, 3, 4]), [0, 2, 4]);
  assert.equal(rebuilt, 1, "removing one member rebuilds only that member's coverage group");
  assert.equal(incremental.culledCount, 1);
  rebuilt = 0;
  assert.deepEqual(retained(incremental, [0, 2, 3]), [0, 2]);
  assert.equal(rebuilt, 0, "changes to singleton geometry require no containment work");
  assert.equal(incremental.culledCount, 1);
  assert.deepEqual(retained(incremental, [0, 0, 2, 2]), [0, 0, 2, 2]);
  assert.equal(rebuilt, 1, "duplicate input IDs do not invent extra group membership");
  assert.equal(incremental.culledCount, 0);
  rebuilt = 0;
  assert.deepEqual(retained(incremental, []), []);
  assert.equal(rebuilt, 2, "empty selections clear every formerly active group");
  assert.equal(incremental.culledCount, 0);
  assert([0, 1, 2, 3, 4].every(id => incremental.isRetained(id)), "inactive groups retain no stale suppression flags");
  assert.deepEqual(retained(incremental, [0, 1, 2, 3, 4]), [0, 2, 4]);
  incremental.revision = 0xffffffff;
  rebuilt = 0;
  assert.deepEqual(retained(incremental, [0, 1, 2, 3, 4]), [0, 2, 4]);
  assert.equal(rebuilt, 2, "generation overflow fully reconstructs active groups");
  assert.equal(incremental.culledCount, 2);
  assert.deepEqual(retained(incremental, [1, 3]), [1, 3], "after overflow hidden covers still restore all remaining members");
  assert.equal(incremental.culledCount, 0);

  // A bounded independent quadratic oracle checks the packed dominance index.
  const many = Array.from({ length: 384 }, (_, i) => line((i * 17) % 60, 61 + (i * 37) % 70, { width: 1 + i % 7 }));
  const manyScene = makeScene(many), manyCore = new VectorStrokeRedundancy(manyScene);
  for (let selection = 0; selection < 6; selection++) {
    const ids = many.map((_, id) => id).filter(id => id % 7 !== selection);
    const sorted = [...ids].sort((a, b) => many[b].width - many[a].width || many[a].a[0] - many[b].a[0] || many[b].b[0] - many[a].b[0] || b - a);
    const covers = [];
    for (const id of sorted) {
      if (!covers.some(other => many[other].width >= many[id].width && many[other].a[0] <= many[id].a[0] && many[other].b[0] >= many[id].b[0])) covers.push(id);
    }
    const originalSort = Array.prototype.sort;
    Array.prototype.sort = () => { throw new Error("Visibility updates must not comparison-sort geometry."); };
    try { manyCore.update(ids); } finally { Array.prototype.sort = originalSort; }
    assert.deepEqual(ids.filter(id => manyCore.isRetained(id)), ids.filter(id => covers.includes(id)));
    assert.equal(manyCore.culledCount, ids.length - covers.length);
  }
  const incomplete = makeScene([line(0, 10)]);
  incomplete.segmentCount = 4096;
  assert(new VectorStrokeRedundancy(incomplete).isRetained(4095), "missing primitive data is never used as covering geometry");
  console.log("vector stroke redundancy: visible containment, layer restoration, geometry/style/paint barriers, LOD mapping, and unchanged canonical data passed");
} finally { hooks.deregister(); }
