import assert from "node:assert/strict";
import { registerHooks } from "node:module";

const hooks = registerHooks({ resolve(s, c, n) {
  return n(c.parentURL?.includes("/src/") && /^\.\.?\//.test(s) && !/\.[a-z0-9]+$/i.test(s) ? s + ".ts" : s, c);
} });
try {
  const { createEmptyVectorScene } = await import("../src/emptyVectorScene.ts");
  const { getCombinedVectorStrokeLodStorage, sharedVectorStrokeLodTextureData } = await import("../src/vectorStrokeLodStorage.ts");
  const { VectorOrderedBatches } = await import("../src/vectorOrderedBatches.ts");
  const { VectorStrokeLodRuntime, storePrebuiltVectorStrokeLodRuntime } = await import("../src/vectorStrokeLodCore.ts");
  const { strokePaintOrigins, setStrokePaintOrigins } = await import("../src/vectorStrokePaintOrder.ts");
  const { ThreeVectorLodStrokeLayer } = await import("../src/vectorStrokeLod.ts");
  const fields = ["endpoints", "primitiveMeta", "primitiveBounds", "styles"];
  const scene = { ...createEmptyVectorScene(), segmentCount: 320, maxHalfWidth: .5,
    bounds: { minX: 0, minY: 0, maxX: 100, maxY: 100 },
    drawRuns: [{ kind: "stroke", first: 160, count: 160 }, { kind: "stroke", first: 0, count: 160 }] };
  for (const field of fields) scene[field] = new Float32Array(scene.segmentCount * 4);
  for (let index = 0; index < scene.segmentCount; index++) {
    const y = Math.floor(index / 40) * 10;
    scene.endpoints.set([0, y, 100, y], index * 4);
    scene.primitiveMeta.set([100, y, 0, 1], index * 4);
    scene.primitiveBounds.set([0, y, 100, y], index * 4);
    scene.styles.set([.5, .25, .5, .75], index * 4);
  }
  const canonical = fields.map(field => scene[field]);
  const original = structuredClone(scene);
  const runtime = new VectorStrokeLodRuntime(scene);
  assert(runtime.levels.length > 1);
  const snapshots = runtime.levels.map(level => fields.map(field => level.scene[field].slice()));
  const origins = runtime.levels.map(level => strokePaintOrigins(level.scene));
  const oldDerived = new Set(runtime.levels.slice(1).flatMap(level => fields.map(field => level.scene[field].buffer)));
  const combined = getCombinedVectorStrokeLodStorage(scene, runtime.levels);
  assert.equal(getCombinedVectorStrokeLodStorage(scene, runtime.levels), combined, "one immutable store per hierarchy");
  let offset = 0;
  runtime.levels.forEach((level, index) => {
    assert.equal(combined.offsets[index], offset);
    assert.equal(strokePaintOrigins(level.scene), origins[index], "paint metadata keeps scene identity");
    fields.forEach((field, component) => {
      assert.deepEqual(level.scene[field], snapshots[index][component]);
      assert.deepEqual(combined.scene[field].subarray(offset * 4, (offset + level.segmentCount) * 4), snapshots[index][component]);
      if (index > 0) {
        assert.equal(level.scene[field].buffer, combined.scene[field].buffer, "derived geometry is a view, not a retained copy");
        assert(!oldDerived.has(level.scene[field].buffer));
      } else assert.equal(level.scene[field], canonical[component], "canonical arrays retain their identity");
    });
    offset += level.segmentCount;
  });
  const buffers = new Set([scene, combined.scene, ...runtime.levels.map(level => level.scene)]
    .flatMap(value => fields.map(field => value[field].buffer)));
  assert.equal([...buffers].reduce((sum, buffer) => sum + buffer.byteLength, 0),
    (scene.segmentCount + Math.ceil(Math.sqrt(offset)) * Math.ceil(offset / Math.ceil(Math.sqrt(offset)))) * 64,
    "derived LOD storage has no duplicate geometry allocation, only a partial texture row");

  runtime.levels.forEach((level, index) => {
    level.visibleSegmentCount = index === runtime.levels.length - 1 ? level.segmentCount : 0;
    if (level.visibleSegmentIds.length < level.visibleSegmentCount) level.visibleSegmentIds = new Uint32Array(level.visibleSegmentCount);
    for (let id = 0; id < level.visibleSegmentCount; id++) level.visibleSegmentIds[id] = id;
  });
  const plan = new VectorOrderedBatches(scene, runtime);
  const secondPlan = new VectorOrderedBatches(scene, runtime);
  assert.equal(plan.strokeScene, combined.scene);
  assert.equal(secondPlan.strokeScene, combined.scene, "independent consumers reuse immutable geometry");
  const allOrigins = runtime.levels.flatMap(level => [...strokePaintOrigins(level.scene)]);
  const sourceRuns = new Uint32Array(scene.segmentCount);
  scene.drawRuns.forEach((run, index) => sourceRuns.fill(index, run.first, run.first + run.count));
  const expectedRanks = Array.from({ length: offset }, (_, id) => id).sort((a, b) =>
    sourceRuns[allOrigins[a]] - sourceRuns[allOrigins[b]] || allOrigins[a] - allOrigins[b] || a - b);
  assert.deepEqual([...plan.rankToId], expectedRanks, "linear counting ranks exactly match canonical paint/origin/ID sorting");
  assert.equal(plan.selectedRanks.length, 0, "dormant levels do not reserve selection scratch");
  assert.equal(plan.previousSelectedIds.length, 0);
  assert.equal(plan.redundancyIds.length, 0);
  assert.equal(plan.floatInstanceData.length, 0, "WebGPU does not reserve unused float instances");
  assert.equal(plan.uintInstances.length, 2);
  plan.update(scene.drawRuns);
  secondPlan.update(scene.drawRuns);
  assert(plan.selectedRanks.length < offset, "selection scratch follows visible strokes");
  assert.equal(plan.floatInstanceData.length, 0, "integer submission does not generate float instance data");
  assert.deepEqual([...plan.floatInstances.subarray(0, plan.instanceCount * 2)],
    [...plan.uintInstances.subarray(0, plan.instanceCount * 2)], "WebGL lazily gets the same IDs and clips");
  assert(plan.floatInstances.length < offset * 2);
  assert.deepEqual(plan.batches, secondPlan.batches);
  assert.deepEqual(plan.uintInstances, secondPlan.uintInstances);
  const firstCapacity = plan.uintInstances.length;
  // An exact frame grows the buffers, then coarse and empty frames must discard
  // stale selection data without changing paint ordering or float conversion.
  plan.setColorCommutationEnabled(false);
  secondPlan.setColorCommutationEnabled(false);
  for (const exact of [true, false, true, false]) {
    runtime.levels.forEach((level, index) => {
      const selected = exact ? index === 0 : index === runtime.levels.length - 1;
      level.visibleSegmentCount = selected ? level.segmentCount : 0;
      if (level.visibleSegmentIds.length < level.visibleSegmentCount) level.visibleSegmentIds = new Uint32Array(level.visibleSegmentCount);
      for (let id = 0; id < level.visibleSegmentCount; id++) level.visibleSegmentIds[id] = id;
    });
    plan.invalidate(); secondPlan.invalidate();
    plan.update(scene.drawRuns); secondPlan.update(scene.drawRuns);
    assert.deepEqual(plan.uintInstances.subarray(0, plan.instanceCount * 2),
      secondPlan.uintInstances.subarray(0, secondPlan.instanceCount * 2));
    assert.deepEqual([...plan.floatInstances.subarray(0, plan.instanceCount * 2)],
      [...plan.uintInstances.subarray(0, plan.instanceCount * 2)]);
    if (exact) {
      assert.equal(plan.instanceCount, scene.segmentCount);
      assert.deepEqual(Array.from({ length: plan.instanceCount }, (_, index) => plan.uintInstances[index * 2]),
        [...Array.from({ length: 160 }, (_, index) => index + 160), ...Array.from({ length: 160 }, (_, index) => index)],
        "growing instance storage retains reversed canonical paint order");
    }
  }
  assert(plan.uintInstances.length > firstCapacity);
  runtime.levels.forEach(level => { level.visibleSegmentCount = 0; });
  plan.invalidate(); plan.update(scene.drawRuns);
  assert.equal(plan.instanceCount, 0, "empty selection discards prior exact IDs");
  assert.deepEqual(scene, original);

  const options = { materialBackend: "webgl", strokeCurveEnabled: true, vectorOverride: [0, 0, 0, 0] };
  storePrebuiltVectorStrokeLodRuntime(scene, runtime);
  const layer = new ThreeVectorLodStrokeLayer(scene, options);
  try {
    assert.equal(layer.runtime, runtime);
    const sourceColors = combined.scene.styles.slice();
    const material = layer.layers[0];
    assert.equal(material.segmentTextureA.image.data.buffer, combined.scene.endpoints.buffer);
    assert.equal(material.segmentTextureB.image.data.buffer, combined.scene.primitiveMeta.buffer);
    assert.equal(material.segmentBoundsTexture.image.data.buffer, combined.scene.primitiveBounds.buffer);
    assert.equal(material.segmentStyleTexture.image.data.buffer, combined.scene.styles.buffer,
      "all immutable texture data shares the LOD store before recoloring");
    assert.equal(material.segmentMarks.length + material.segmentMinX.length + material.segmentMinY.length +
      material.segmentMaxX.length + material.segmentMaxY.length + material.allSegmentIds.length, 0,
      "externally culled LOD does not duplicate unused spatial scratch");
    assert.equal(layer.combinedIds.length, 0, "Three LOD reserves selection IDs on demand");
    const sharedStyle = sharedVectorStrokeLodTextureData(combined.scene.styles);
    assert(sharedStyle.length >= combined.scene.styles.length);
    assert(sharedStyle.subarray(combined.scene.styles.length).every(value => value === 0));
    layer.setPrimitiveColorUpdates([{ ref: { kind: "stroke", index: 0 }, color: [1, 0, 0] }]);
    assert.notEqual(material.segmentStyleTexture.image.data.buffer, combined.scene.styles.buffer,
      "recoloring creates a private style texture on first write");
    assert.deepEqual(combined.scene.styles, sourceColors, "temporary colors do not alter shared storage");
    assert.deepEqual(scene, original, "temporary colors do not alter the canonical scene");
    layer.setPrimitiveColorUpdates([{ ref: { kind: "stroke", index: 0 }, color: null }]);
    assert.deepEqual(layer.layers[0].segmentStyleTexture.image.data.subarray(0, sourceColors.length), sourceColors,
      "clearing a temporary color restores its exact original value");
  } finally { layer.dispose(); }
  const reopened = new ThreeVectorLodStrokeLayer(scene, options);
  try {
    assert.equal(reopened.runtime, runtime);
    assert.equal(getCombinedVectorStrokeLodStorage(scene, reopened.runtime.levels), combined,
      "backend reuse does not retain another combined geometry copy");
  } finally { reopened.dispose(); }

  // Typed copies preserve signed zero and NaN payload bits, not just numeric equality.
  const edge = { ...createEmptyVectorScene(), segmentCount: 1 };
  for (const field of fields) edge[field] = new Float32Array(Uint32Array.of(0x80000000, 0x7fc00001, 0x3f800000, 0).buffer);
  const derived = { ...edge };
  setStrokePaintOrigins(derived, Uint32Array.of(0));
  const edgeLevels = [{ scene: edge, segmentCount: 1 }, { scene: derived, segmentCount: 1 }];
  const edgeStore = getCombinedVectorStrokeLodStorage(edge, edgeLevels);
  for (const field of fields) {
    assert.deepEqual(new Uint32Array(edgeStore.scene[field].buffer),
      Uint32Array.of(0x80000000, 0x7fc00001, 0x3f800000, 0, 0x80000000, 0x7fc00001, 0x3f800000, 0));
  }
  assert.equal(getCombinedVectorStrokeLodStorage(scene, [{ scene, segmentCount: scene.segmentCount }]).scene, scene,
    "a hierarchy with only exact geometry needs no combined copy");

  // Preserve the original default-run behavior for holes, overlapping runs,
  // and a simplified level whose paint origins are in arbitrary order.
  const sparse = { ...createEmptyVectorScene(), segmentCount: 9,
    drawRuns: [{ kind: "stroke", first: 4, count: 2 }, { kind: "stroke", first: 1, count: 2 },
      { kind: "stroke", first: 5, count: 1 }] };
  for (const field of fields) sparse[field] = new Float32Array(36);
  const sparseDerived = { ...sparse };
  const shuffled = Uint32Array.of(8, 2, 4, 0, 5, 1, 2, 7, 4);
  setStrokePaintOrigins(sparseDerived, shuffled);
  const sparseLevels = [sparse, sparseDerived].map((source, index) => ({ scene: source,
    segmentCount: source.segmentCount, tolerance: index, visibleSegmentCount: 0, visibleSegmentIds: new Uint32Array(0) }));
  const sparsePlan = new VectorOrderedBatches(sparse, { levels: sparseLevels });
  const sparseRun = new Uint32Array(9);
  sparse.drawRuns.forEach((run, index) => sparseRun.fill(index, run.first, run.first + run.count));
  const sparseOrigins = [...strokePaintOrigins(sparse), ...shuffled];
  const sparseRanks = Array.from({ length: 18 }, (_, id) => id).sort((a, b) =>
    sparseRun[sparseOrigins[a]] - sparseRun[sparseOrigins[b]] || sparseOrigins[a] - sparseOrigins[b] || a - b);
  assert.deepEqual([...sparsePlan.rankToId], sparseRanks, "counting ranks preserve holes, overlap, shuffled origins and ID ties");
  console.log("Shared LOD storage: exact bits, released derived copies, canonical identity, paint metadata, color isolation and reuse passed");
} finally { hooks.deregister(); }
