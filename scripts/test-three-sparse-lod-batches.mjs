import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import * as THREE from "three";

const hooks = registerHooks({ resolve(s, c, n) {
  return n(c.parentURL?.includes("/src/") && /^\.\.?\//.test(s) && !/\.[a-z0-9]+$/i.test(s) ? s + ".ts" : s, c);
} });
try {
  const { createEmptyVectorScene } = await import("../src/emptyVectorScene.ts");
  const { ThreeVectorDrawRuns } = await import("../src/threeVectorDrawRuns.ts");
  const { createThreeVectorClipTexture, initializeThreeVectorClip } = await import("../src/threeVectorClips.ts");
  const { OptionalContentController } = await import("../src/optionalContent.ts");
  const sourceCount = 131_072, count = sourceCount * 3, perRun = sourceCount / 8;
  const origins = Uint32Array.from({ length: count }, (_, id) => id % sourceCount);
  const scene = { ...createEmptyVectorScene(), segmentCount: count,
    drawRuns: Array.from({ length: 8 }, (_, index) => ({ kind: "stroke", first: index * perRun,
      count: perRun, clipIndex: index % 2, optionalContent: index % 2 })),
    optionalContent: { groups: ["a", "b"].map(id => ({ id, name: id, defaultVisible: true, locked: false, usedInView: true })),
      conditions: ["a", "b"].map(groupId => ({ kind: "group", groupId })), order: [], radioGroups: [] },
    clipPaths: [0, 1].map(x => ({ parent: -1, fillRule: 0,
      edges: Float32Array.of(x, 0, x + 1, 0, x + 1, 0, x + 1, 1, x + 1, 1, x, 1, x, 1, x, 0) })) };
  // The batcher consumes an existing schedule; no geometry build is needed to
  // exercise selection from a large hierarchy with sparse visible instances.
  const plan = { version: 0, order: [0, 1, 2, 3, 4, 5, 6, 7], segments: null };
  const geometry = new THREE.InstancedBufferGeometry();
  const attribute = new THREE.InstancedBufferAttribute(new Float32Array(count), 1);
  geometry.setAttribute("aSegmentIndex", attribute); geometry.instanceCount = 0;
  const material = new THREE.RawShaderMaterial();
  const clips = createThreeVectorClipTexture(scene); initializeThreeVectorClip(material, clips);
  const parent = new THREE.Mesh(geometry, material);
  const runs = ThreeVectorDrawRuns.create(scene, "stroke", parent, "aSegmentIndex", plan, origins);
  const controller = new OptionalContentController(scene);
  const select = ids => {
    runs.beginUpdate(); attribute.array.set(ids); attribute.needsUpdate = true;
    geometry.instanceCount = ids.length; runs.finishUpdate();
  };
  const drawn = () => [...parent.children].sort((a, b) => a.renderOrder - b.renderOrder)
    .flatMap(mesh => Array.from({ length: mesh.visible ? mesh.geometry.instanceCount : 0 }, (_, index) => [
      mesh.geometry.getAttribute("aSegmentIndex").getX(index),
      mesh.geometry.getAttribute("aVectorClipIndex")?.getX(index) ?? mesh.material.uniforms.uVectorClipIndex.value + 1
    ]));
  const expected = (ids, hidden = false) => plan.order.flatMap(runIndex => [...ids]
    .filter(id => Math.floor(origins[id] / perRun) === runIndex && (!hidden || runIndex % 2 === 1))
    .sort((a, b) => origins[a] - origins[b] || a - b)
    .map(id => [id, runIndex % 2 + 1]));
  try {
    const selected = [count - 1, sourceCount, 0, 31, 32, 1023, 1024, sourceCount + 32,
      perRun - 1, perRun, perRun * 3 + 17, sourceCount * 2 + perRun * 6 + 5];
    // Count accesses to the canonical per-run lists, not elapsed time: sparse
    // updates must not read hundreds of thousands of invisible candidates.
    let visits = 0;
    for (const entry of runs.entries) for (const range of entry.ranges) {
      const ids = range.ids;
      range.ids = new Proxy(ids, { get(target, key) {
        if (/^\d+$/.test(String(key))) visits++;
        return Reflect.get(target, key, target);
      } });
    }
    select(selected);
    assert.deepEqual(drawn(), expected(selected), "sparse LOD keeps paint order, origin ties and per-instance clips");
    assert(visits <= selected.length, `batch assembly must visit selected LOD IDs only: ${visits} for ${selected.length}`);
    const versions = parent.children.map(mesh => mesh.geometry.getAttribute("aSegmentIndex").version);
    visits = 0; select([...selected].reverse());
    assert.equal(visits, 0, "reordered membership reuses the existing batch buffers");
    assert.deepEqual(parent.children.map(mesh => mesh.geometry.getAttribute("aSegmentIndex").version), versions);
    const next = selected.slice(2).concat([perRun * 2 + 7, sourceCount * 2 + perRun * 4 + 9]);
    select(next);
    assert.deepEqual(drawn(), expected(next), "entering and leaving primitives update sparse ranks");
    await controller.setLayerVisibility("a", false);
    runs.setOptionalContentVisibility(controller.getSnapshot());
    assert.deepEqual(drawn(), expected(next, true), "OCG changes filter the cached sparse selection");
    await controller.setLayerVisibility("a", true);
    runs.setOptionalContentVisibility(controller.getSnapshot());
    assert.deepEqual(drawn(), expected(next), "showing an OCG restores its selected strokes");
    plan.order = [7, 6, 5, 4, 3, 2, 1, 0]; plan.version++;
    runs.beginUpdate(); runs.finishUpdate();
    assert.deepEqual(drawn(), expected(next), "replanning preserves per-run order within a different paint schedule");
    select([]); assert.deepEqual(drawn(), [], "empty selection clears every old batch");
    select(selected); assert.deepEqual(drawn(), expected(selected), "selection can recover from empty");
    runs.setEnabled(false); assert.deepEqual(drawn(), []);
    runs.setEnabled(true); assert.deepEqual(drawn(), expected(selected));
  } finally { runs.dispose(); geometry.dispose(); material.dispose(); clips.dispose(); }
  // Legacy Multiply draws two passes per canonical primitive. Those ranges
  // are slices of a run's rank interval, rather than whole canonical runs.
  const multiplyScene = { ...scene, segmentCount: 6,
    drawRuns: [{ kind: "stroke", first: 0, count: 3, clipIndex: 0, blendMode: "Multiply" }] };
  const multiplyOrigins = Uint32Array.of(0, 1, 2, 0, 1, 2);
  const multiplyGeometry = new THREE.InstancedBufferGeometry();
  const multiplyIds = new THREE.InstancedBufferAttribute(new Float32Array(6), 1);
  multiplyGeometry.setAttribute("aSegmentIndex", multiplyIds); multiplyGeometry.instanceCount = 0;
  const multiplyMaterial = new THREE.RawShaderMaterial();
  const multiplyClips = createThreeVectorClipTexture(multiplyScene);
  initializeThreeVectorClip(multiplyMaterial, multiplyClips);
  const multiplyParent = new THREE.Mesh(multiplyGeometry, multiplyMaterial);
  const multiplyRuns = ThreeVectorDrawRuns.create(multiplyScene, "stroke", multiplyParent, "aSegmentIndex",
    { version: 0, order: [0], segments: null }, multiplyOrigins);
  try {
    multiplyRuns.beginUpdate(); multiplyIds.array.set([4, 2, 3]); multiplyIds.needsUpdate = true;
    multiplyGeometry.instanceCount = 3; multiplyRuns.finishUpdate();
    const ids = [...multiplyParent.children].sort((a, b) => a.renderOrder - b.renderOrder).flatMap(mesh =>
      Array.from({ length: mesh.geometry.instanceCount }, (_, index) => mesh.geometry.getAttribute("aSegmentIndex").getX(index)));
    assert.deepEqual(ids, [3, 3, 4, 4, 2, 2], "sparse subranges preserve both Multiply passes in canonical order");
  } finally { multiplyRuns.dispose(); multiplyGeometry.dispose(); multiplyMaterial.dispose(); multiplyClips.dispose(); }
  console.log("Sparse Three LOD batching: selected-only traversal, paint/clip order, origin ties, OCGs, replanning and empty selections passed");
} finally { hooks.deregister(); }
