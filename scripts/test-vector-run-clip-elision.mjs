import assert from "node:assert/strict";
import { registerHooks } from "node:module";

const hooks = registerHooks({ resolve(s, c, n) {
  return n(c.parentURL?.includes("/src/") && /^\.\.?\//.test(s) && !/\.[a-z0-9]+$/i.test(s) ? `${s}.ts` : s, c);
} });
try {
  const { createEmptyVectorScene } = await import("../src/emptyVectorScene.ts");
  const { VectorOrderedBatches } = await import("../src/vectorOrderedBatches.ts");
  const { VectorRunClipElision } = await import("../src/vectorRunClipElision.ts");
  const { setStrokePaintOrigins } = await import("../src/vectorStrokePaintOrder.ts");
  const rectangle = (x0, y0, x1, y1, parent = -1) => ({ parent, fillRule: 0,
    edges: new Float32Array([x0,y0,x1,y0,x1,y0,x1,y1,x1,y1,x0,y1,x0,y1,x0,y0]) });
  const strokeScene = (clips = [rectangle(-100, -100, 100, 100)], clipIndex = clips.length - 1) => Object.assign(createEmptyVectorScene(), {
    segmentCount: 1, endpoints: new Float32Array([-5,0,5,0]), primitiveMeta: new Float32Array([5,0,0,1]),
    primitiveBounds: new Float32Array([-5,-1,5,1]), styles: new Float32Array([1,0,0,0]),
    drawRuns: [{ kind: "stroke", first: 0, count: 1, clipIndex }], clipPaths: clips
  });
  const codes = plan => Array.from({ length: plan.instanceCount }, (_, index) => plan.uintInstances[index * 2 + 1]);

  const scene = strokeScene(), original = structuredClone(scene);
  const plan = new VectorOrderedBatches(scene, null);
  assert(plan.update(scene.drawRuns, 1));
  assert.deepEqual(codes(plan), [0], "strictly interior geometry skips shader clip fetches");
  assert.equal(plan.update(scene.drawRuns, 0.75), false, "the same AA bucket reuses instance data");
  assert(plan.update(scene.drawRuns, 32), "a larger AA footprint restores clipping and forces upload without a scheduler");
  assert.deepEqual(codes(plan), [1]);
  assert(plan.update(scene.drawRuns, 1));
  assert.deepEqual(codes(plan), [0]);
  assert(plan.update(scene.drawRuns, null), "unknown projection restores the canonical clip root");
  assert.deepEqual(codes(plan), [1]);
  assert.equal(plan.update(scene.drawRuns, null), false);
  for (const unknown of [NaN, Infinity, 0, -1]) {
    plan.update(scene.drawRuns, unknown);
    assert.deepEqual(codes(plan), [1]);
  }
  plan.update(scene.drawRuns, 1);
  plan.setColorCommutationEnabled(false); plan.update(scene.drawRuns, 1);
  assert.deepEqual(codes(plan), [0], "temporary colors do not change clip containment");
  plan.setColorCommutationEnabled(true); plan.update(scene.drawRuns, 1);
  assert.deepEqual(codes(plan), [0]);
  plan.update([], 1); assert.equal(plan.instanceCount, 0);
  plan.update(scene.drawRuns, 1); assert.deepEqual(codes(plan), [0], "layer reappearance retains the applied clip proof");
  assert.deepEqual(scene, original, "geometry and original clip references remain unchanged");

  const chain = strokeScene([rectangle(-100,-100,100,100), rectangle(-20,-20,20,20,0)]);
  const chainedPlan = new VectorOrderedBatches(chain, null);
  chainedPlan.update(chain.drawRuns, 1); assert.deepEqual(codes(chainedPlan), [0]);
  chainedPlan.update(chain.drawRuns, 4); assert.deepEqual(codes(chainedPlan), [2], "every rectangle ancestor participates in the proof");
  const disjoint = strokeScene([rectangle(-100,-100,-50,-50), rectangle(-20,-20,20,20,0)]);
  const disjointPlan = new VectorOrderedBatches(disjoint, null);
  disjointPlan.update(disjoint.drawRuns, 1); assert.deepEqual(codes(disjointPlan), [2], "empty clip intersections must remain active");

  const diamond = { parent: -1, fillRule: 0, edges: new Float32Array([-100,0,0,-100,0,-100,100,0,100,0,0,100,0,100,-100,0]) };
  const sheared = rectangle(-100,-100,100,100); sheared.edges[2] = sheared.edges[4] = 99.99;
  const open = rectangle(-100,-100,100,100); open.edges[15] = -99;
  const hole = { parent: -1, fillRule: 1, edges: new Float32Array([...rectangle(-100,-100,100,100).edges, ...rectangle(-2,-2,2,2).edges]) };
  for (const clips of [[diamond], [diamond, rectangle(-20,-20,20,20,0)], [sheared], [open], [hole], [rectangle(0,-100,0,100)]]) {
    const guarded = strokeScene(clips), guardedPlan = new VectorOrderedBatches(guarded, null);
    guardedPlan.update(guarded.drawRuns, 1);
    assert.deepEqual(codes(guardedPlan), [clips.length], "polygon bounds, holes, shear, open and degenerate loops do not prove rectangle containment");
  }

  const hairline = strokeScene([rectangle(-20,-20,20,20)]);
  hairline.styles[0] = 0; hairline.endpoints.set([-19,0,-10,0]); hairline.primitiveMeta.set([-10,0,0,3]);
  const hairlinePlan = new VectorOrderedBatches(hairline, null);
  hairlinePlan.update(hairline.drawRuns, 1); assert.deepEqual(codes(hairlinePlan), [1], "device hairlines near the clip retain their screen-space margin");
  hairlinePlan.update(hairline.drawRuns, 0.125); assert.deepEqual(codes(hairlinePlan), [0]);
  const wide = strokeScene([rectangle(-20,-20,20,20)]); wide.styles[0] = 20;
  const widePlan = new VectorOrderedBatches(wide, null); widePlan.update(wide.drawRuns, 0.01);
  assert.deepEqual(codes(widePlan), [1], "stroke widths and caps are included before AA padding");
  const quadratic = strokeScene([rectangle(-20,-20,20,20)]); quadratic.endpoints.set([-5,0,0,80]); quadratic.primitiveMeta[2] = 1;
  const curvePlan = new VectorOrderedBatches(quadratic, null); curvePlan.update(quadratic.drawRuns, 1);
  assert.deepEqual(codes(curvePlan), [1], "quadratic control hulls are retained rather than testing endpoints alone");
  const fragmentClipped = strokeScene(); fragmentClipped.primitiveMeta[3] = 9;
  fragmentClipped.primitiveBounds.set([-3,-1,3,1]);
  const fragmentOriginal = fragmentClipped.primitiveBounds.slice();
  const fragmentPlan = new VectorOrderedBatches(fragmentClipped, null); fragmentPlan.update(fragmentClipped.drawRuns, 1);
  assert.deepEqual(codes(fragmentPlan), [0]);
  assert.equal(fragmentClipped.primitiveMeta[3], 9, "primitive rectangular clipping remains active independently");
  assert.deepEqual(fragmentClipped.primitiveBounds, fragmentOriginal);

  const mixed = strokeScene(); mixed.fillPathCount = 1; mixed.textInstanceCount = 2;
  mixed.fillPathMetaA = new Float32Array([0,4,-4,-4]); mixed.fillPathMetaB = new Float32Array([4,4,0,0]); mixed.fillPathMetaC = new Float32Array([0,0,0,1]);
  mixed.textGlyphMetaA = new Float32Array([0,4,-2,-1]); mixed.textGlyphMetaB = new Float32Array([2,1,0,0]);
  mixed.textInstanceA = new Float32Array([2,1,-1,3, 2,1,-1,3]);
  mixed.textInstanceB = new Float32Array([40,30,0,0, 99,30,0,0]);
  mixed.textInstanceC = new Float32Array([0,0,0,1,0,0,0,1]);
  mixed.rasterLayers = [{ matrix: new Float32Array([1,0,0,1,0,0]), width: 1, height: 1, data: new Uint8Array(4) }];
  mixed.drawRuns.push({kind:"fill",first:0,count:1,clipIndex:0}, {kind:"text",first:0,count:1,clipIndex:0},
    {kind:"text",first:1,count:1,clipIndex:0}, {kind:"raster",first:0,count:1,clipIndex:0},
    {kind:"gradient-fill",first:0,count:1,clipIndex:0}, {kind:"gradient-stroke",first:0,count:1,clipIndex:0});
  const mixedPlan = new VectorOrderedBatches(mixed, null); mixedPlan.update(mixed.drawRuns, 1);
  assert.deepEqual(codes(mixedPlan), [0,0,0,1], "fill bounds and fully transformed glyph corners prove only interior instances");
  for (const run of mixedPlan.batches.filter(run => ["raster","gradient-fill","gradient-stroke"].includes(run.kind))) assert.equal(run.clipIndex, 0);

  const lodScene = strokeScene([rectangle(-20,-20,20,20)]);
  const coarse = structuredClone(lodScene); coarse.primitiveMeta[0] = 30; coarse.endpoints[2] = 30;
  setStrokePaintOrigins(coarse, new Uint32Array([0]));
  const runtime = { levels: [
    { scene: lodScene, segmentCount: 1, tolerance: 0, visibleSegmentCount: 1, visibleSegmentIds: new Uint32Array([0]) },
    { scene: coarse, segmentCount: 1, tolerance: 1, visibleSegmentCount: 0, visibleSegmentIds: new Uint32Array([0]) }
  ] };
  const lodPlan = new VectorOrderedBatches(lodScene, runtime); lodPlan.update(lodScene.drawRuns, 1);
  assert.deepEqual(codes(lodPlan), [1], "the proof includes dormant coarse LOD geometry");
  runtime.levels[0].visibleSegmentCount = 0; runtime.levels[1].visibleSegmentCount = 1;
  lodPlan.invalidate(); lodPlan.update(lodScene.drawRuns, 1);
  assert.deepEqual(codes(lodPlan), [1]);
  assert.equal(lodPlan.uintInstances[0], 1, "combined texture indices and canonical LOD mapping remain unchanged");
  const noClips = strokeScene(); delete noClips.clipPaths; delete noClips.drawRuns[0].clipIndex;
  assert.equal(VectorRunClipElision.create(noClips, {scene:noClips,sourceRuns:new Uint32Array([0])}), null, "unclipped scenes allocate no elision resources");
  console.log("Vector run clip elision preserves rectangle chains, AA margins, transformed and LOD geometry, projection fallback, and canonical data");
} finally { hooks.deregister(); }
