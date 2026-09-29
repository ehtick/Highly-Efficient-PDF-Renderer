import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { registerHooks } from "node:module";

const hooks = registerHooks({ resolve(s, c, n) {
  return n(c.parentURL?.includes("/src/") && /^\.\.?\//.test(s) && !/\.[a-z0-9]+$/i.test(s) ? s + ".ts" : s, c);
} });
const fields = ["endpoints", "primitiveMeta", "primitiveBounds", "styles"];
const warnings = [];
const warn = console.warn;
console.warn = message => warnings.push(message);
try {
  const { createEmptyVectorScene } = await import("../src/emptyVectorScene.ts");
  const { buildVectorStrokeLodScenes, prebuildVectorStrokeLodRuntime, takePrebuiltVectorStrokeLodRuntime } =
    await import("../src/vectorStrokeLodCore.ts");
  const { strokePaintOrigins } = await import("../src/vectorStrokePaintOrder.ts");
  const makeScene = count => {
    const scene = { ...createEmptyVectorScene(), segmentCount: count, maxHalfWidth: .06,
      bounds: { minX: 0, minY: 0, maxX: 1100, maxY: 1100 },
      drawRuns: [{ kind: "stroke", first: 0, count }] };
    for (const field of fields) scene[field] = new Float32Array(count * 4);
    return scene;
  };
  const mark = (scene, index, x, y, length, type = 0) => {
    scene.endpoints.set([x, y, x + length, y], index * 4);
    scene.primitiveMeta.set([x + length, y, type, 5], index * 4);
    scene.primitiveBounds.set([x, y, x + length, y], index * 4);
    scene.styles.set([.06, 0, 0, 0], index * 4);
  };
  const digest = scene => {
    const hash = createHash("sha256");
    for (const field of fields) hash.update(scene[field]);
    return hash.digest("hex");
  };
  const verify = async (scene, expectedFineCount) => {
    const original = digest(scene);
    warnings.length = 0;
    const levels = buildVectorStrokeLodScenes(scene);
    assert.equal(levels[0].scene, scene, "retain the canonical scene by reference");
    assert.equal(warnings.length, 0, "memory savings must not skip levels or reduce fidelity");
    assert.equal(levels[1].overview, false, "retain the original fine level");
    assert.equal(levels[1].scene.segmentCount, expectedFineCount);
    assert(levels.some(level => level.overview && level.scene.segmentCount < 50_000),
      "retain useful coarser overview levels too");
    const progress = [];
    const runtime = await prebuildVectorStrokeLodRuntime(scene, "force", "webgl", {
      yieldIntervalMs: 1, onProgress: event => progress.push(event.value)
    });
    assert.equal(takePrebuiltVectorStrokeLodRuntime(scene), runtime);
    assert.deepEqual(runtime.levels.map(level => [level.tolerance, level.overview, level.segmentCount]),
      levels.map(level => [level.tolerance, level.overview, level.scene.segmentCount]));
    runtime.levels.forEach((level, index) => {
      assert.equal(digest(level.scene), digest(levels[index].scene), "sync/async geometry is byte-identical");
      assert.deepEqual(strokePaintOrigins(level.scene), strokePaintOrigins(levels[index].scene));
    });
    assert(progress.every((value, index) => index === 0 || value >= progress[index - 1]),
      "loading progress remains monotonic");
    assert.equal(progress.at(-1), 1);
    const selectionCapacity = () => runtime.levels.reduce((sum, level) => sum + level.visibleSegmentIds.byteLength, 0);
    assert(selectionCapacity() <= runtime.levels.length * 4096 * 4,
      "visibility scratch starts small even when exact geometry is large");
    runtime.updateForLocalUnitsPerPixel(32);
    const view = { cameraCenterX: 550, cameraCenterY: 550, zoom: 1 / 32 };
    const viewport = { width: 1000, height: 1000 };
    runtime.update(view, viewport);
    assert(runtime.getRenderedSegmentCount() > 0 && runtime.getRenderedSegmentCount() < scene.segmentCount,
      "the completed hierarchy still reduces visible work");
    runtime.setForceExact(true);
    runtime.update(view, viewport);
    assert.equal(runtime.getRenderedSegmentCount(), scene.segmentCount, "exact identity remains available");
    assert.equal(runtime.levels[0].visibleSegmentIds.length, scene.segmentCount,
      "visibility scratch grows without dropping exact strokes");
    const exactIds = runtime.levels[0].visibleSegmentIds.slice(0, scene.segmentCount).sort();
    for (let index = 0; index < exactIds.length; index++) assert.equal(exactIds[index], index);
    runtime.setForceExact(false);
    runtime.updateForLocalUnitsPerPixel(32);
    runtime.update(view, viewport);
    assert(runtime.getRenderedSegmentCount() < scene.segmentCount, "return to the original overview after exact selection");
    assert.equal(digest(scene), original, "memory optimization cannot rewrite source geometry");
  };

  // More distinct groups than the previous mitigation admitted. Fine detail
  // must be preserved even when all hatches belong to one paint operation.
  const hatches = makeScene(140_000);
  for (let i = 0; i < hatches.segmentCount; i++) mark(hatches, i, 0, Math.floor(i / 2) * .01, 10);
  await verify(hatches, 70_000);

  const partitioned = { ...hatches, drawRuns: [
    { kind: "stroke", first: 0, count: 70_000 },
    { kind: "stroke", first: 70_000, count: 70_000 }
  ] };
  const streamed = buildVectorStrokeLodScenes(partitioned);
  assert.equal(streamed[1].overview, false);
  assert.equal(streamed[1].scene.segmentCount, 70_000);

  // Keep a fine level larger than the old 32 MiB geometry cap. Curves must
  // survive without quantization, dropping levels, or rewriting source data.
  const curves = makeScene(600_000);
  for (let i = 0; i < curves.segmentCount; i++) {
    if (i >= 560_000) mark(curves, i, .01, .01, 0);
    else mark(curves, i, i % 1000, Math.floor(i / 1000),
      i < 300_000 ? .1 : i < 460_000 ? 1 : i < 530_000 ? 4 : i < 550_000 ? 16 : 64, 1);
  }
  await verify(curves, 560_001);

  // Custom draw-run tables can leave a nonconsecutive default paint group.
  // Releasing that group early would split what used to be one merged line.
  const partial = makeScene(9);
  partial.drawRuns = [{ kind: "stroke", first: 3, count: 3 }];
  for (let index = 0; index < 9; index++) mark(partial, index, 0, index >= 3 && index < 6 ? 1 : 0, 10);
  const partialLevels = buildVectorStrokeLodScenes(partial);
  assert.equal(partialLevels[1].scene.segmentCount, 2, "preserve nonconsecutive custom paint groups");
  assert.deepEqual([...strokePaintOrigins(partialLevels[1].scene)], [0, 3]);

  // The old density admission cap is global to an ordered pass, even when
  // completed paint groups release their storage. Resetting it would change
  // the geometry of the last 10,000 coincident pairs.
  const dots = makeScene(520_000);
  dots.drawRuns = [
    { kind: "stroke", first: 0, count: 260_000 },
    { kind: "stroke", first: 260_000, count: 260_000 }
  ];
  for (let index = 0; index < dots.segmentCount; index++) {
    const pair = Math.floor(index / 2);
    mark(dots, index, pair % 1000, Math.floor(pair / 1000), 0);
  }
  const dotLevels = buildVectorStrokeLodScenes(dots);
  assert.equal(dotLevels[1].scene.segmentCount, 270_000, "streaming preserves density group admission");

  let cancel = false;
  await assert.rejects(prebuildVectorStrokeLodRuntime(hatches, "force", "webgl", {
    yieldIntervalMs: 1,
    onProgress: event => { if (event.message.startsWith("Merging")) cancel = true; },
    shouldCancel: () => cancel
  }), /cancel/i);
  assert(cancel, "exercise cancellation during group emission");
  assert.equal(takePrebuiltVectorStrokeLodRuntime(hatches), null, "cancelled builds cannot publish a partial runtime");
  const failure = new Error("progress consumer failed");
  await assert.rejects(prebuildVectorStrokeLodRuntime(hatches, "force", "webgl", {
    onProgress: event => { if (event.message.startsWith("Simplifying tol")) throw failure; }
  }), error => error === failure, "unexpected errors must propagate");
  console.log("Lossless LOD memory: all fine detail, exact source, sync/async parity, growing selection storage and cancellation passed");
} finally {
  console.warn = warn;
  hooks.deregister();
}
