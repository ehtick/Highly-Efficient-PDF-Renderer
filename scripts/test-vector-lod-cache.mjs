import assert from "node:assert/strict";
import { registerHooks } from "node:module";

const hooks = registerHooks({ resolve(s, c, n) {
  return n(c.parentURL?.includes("/src/") && /^\.\.?\//.test(s) && !/\.[a-z0-9]+$/i.test(s) ? s + ".ts" : s, c);
} });
try {
  const { createEmptyVectorScene } = await import("../src/emptyVectorScene.ts");
  const { prebuildVectorStrokeLodRuntime, reserveVectorStrokeLodRuntime, takePrebuiltVectorStrokeLodRuntime,
    storePrebuiltVectorStrokeLodRuntime, resetVectorStrokeLodBuildTiming,
    consumeVectorStrokeLodBuildTiming } = await import("../src/vectorStrokeLodCore.ts");
  const { ThreeVectorLodStrokeLayer } = await import("../src/vectorStrokeLod.ts");
  const count = 128;
  const scene = { ...createEmptyVectorScene(), segmentCount: count, maxHalfWidth: .1,
    bounds: { minX: 0, minY: 0, maxX: count, maxY: 1 },
    drawRuns: [{ kind: "stroke", first: 0, count }] };
  const fields = ["endpoints", "primitiveMeta", "primitiveBounds", "styles"];
  for (const key of fields) scene[key] = new Float32Array(count * 4);
  for (let index = 0; index < count; index++) {
    scene.endpoints.set([index, 0, index + 1, 0], index * 4);
    scene.primitiveMeta.set([index + 1, 0, 0, 1], index * 4);
    scene.primitiveBounds.set([index, 0, index + 1, 0], index * 4);
    scene.styles.set([.1, 0, 0, 0], index * 4);
  }
  const original = fields.map(key => scene[key].slice());
  const options = { strokeCurveEnabled: true, vectorOverride: [0, 0, 0, 0], materialBackend: "webgl" };
  resetVectorStrokeLodBuildTiming();
  await prebuildVectorStrokeLodRuntime(scene, "force", "webgl");
  let current = new ThreeVectorLodStrokeLayer(scene, options);
  const firstLayer = current;
  const runtimes = new Set([current.runtime]);
  try {
    // Same prepare/new-object/dispose-old-object order as backend replacement.
    for (let index = 0; index < 6; index++) {
      const progress = [];
      const runtime = await prebuildVectorStrokeLodRuntime(scene, "force", "webgl", {
        onProgress: event => progress.push(event)
      });
      assert.notEqual(runtime, current.runtime, "preparation cannot reuse the active viewer's mutable runtime");
      const next = new ThreeVectorLodStrokeLayer(scene, options);
      assert.equal(next.runtime, runtime);
      current.dispose();
      current = next;
      runtimes.add(runtime);
      assert.equal(progress.at(-1).value, 1);
      assert(progress.every((event, i) => i === 0 || event.value >= progress[i - 1].value));
      if (index > 0) assert(progress.some(event => event.message === "Reusing Vector LOD"));
    }
    assert.equal(runtimes.size, 2, "repeated replacements alternate active and idle hierarchies");
    assert.equal(consumeVectorStrokeLodBuildTiming().buildCount, 2, "cache hits do not perform another LOD build");
    const idle = takePrebuiltVectorStrokeLodRuntime(scene);
    assert(idle);
    assert.notEqual(idle, current.runtime);
    assert.equal(takePrebuiltVectorStrokeLodRuntime(scene), null, "at most one unused hierarchy is retained");

    // This old layer's runtime has since been reacquired by the active viewer.
    assert.equal(firstLayer.runtime, current.runtime);
    firstLayer.dispose();
    assert.equal(takePrebuiltVectorStrokeLodRuntime(scene), null, "double disposal cannot return a borrowed runtime");

    storePrebuiltVectorStrokeLodRuntime(scene, idle);
    assert.equal(await prebuildVectorStrokeLodRuntime(scene, "off", "webgl"), null);
    await assert.rejects(prebuildVectorStrokeLodRuntime(scene, "force", "webgl", {
      shouldCancel: () => true
    }), /cancel/i);
    assert.equal(takePrebuiltVectorStrokeLodRuntime(scene), idle, "cancelling a cache hit retains the completed hierarchy");
    storePrebuiltVectorStrokeLodRuntime(scene, idle);
    const failure = new Error("progress failed");
    await assert.rejects(prebuildVectorStrokeLodRuntime(scene, "force", "webgl", {
      onProgress: event => { if (event.message === "Reusing Vector LOD") throw failure; }
    }), error => error === failure);
    assert.equal(takePrebuiltVectorStrokeLodRuntime(scene), idle, "callback failure cannot lose or duplicate the idle hierarchy");

    storePrebuiltVectorStrokeLodRuntime(scene, idle);
    const [reserved, parallel] = await Promise.all([
      prebuildVectorStrokeLodRuntime(scene, "force", "webgl"),
      prebuildVectorStrokeLodRuntime(scene, "force", "webgpu")
    ]);
    assert.equal(reserved, idle);
    assert.notEqual(reserved, parallel, "concurrent preparations reserve separate mutable runtimes");
    assert.notEqual(parallel, current.runtime);
    assert(takePrebuiltVectorStrokeLodRuntime(scene));
    assert.equal(takePrebuiltVectorStrokeLodRuntime(scene), null);
    // Both async preparations finish before either constructor is allowed to
    // run, as when text LOD or backend initialization delays same-scene viewers.
    consumeVectorStrokeLodBuildTiming();
    const reservations = await Promise.all([
      reserveVectorStrokeLodRuntime(scene, "force", "webgl"),
      reserveVectorStrokeLodRuntime(scene, "force", "webgpu")
    ]);
    assert(reservations.every(Boolean));
    assert.equal(takePrebuiltVectorStrokeLodRuntime(scene), null, "reserved runtimes are never idle");
    assert.equal(consumeVectorStrokeLodBuildTiming().buildCount, 2);
    const delayedFirst = new ThreeVectorLodStrokeLayer(scene, options, reservations[1]);
    const delayedSecond = new ThreeVectorLodStrokeLayer(scene, options, reservations[0]);
    try {
      assert.notEqual(delayedFirst.runtime, delayedSecond.runtime);
      assert.notEqual(delayedFirst.runtime, current.runtime);
      assert.notEqual(delayedSecond.runtime, current.runtime);
      assert.equal(consumeVectorStrokeLodBuildTiming().buildCount, 0,
        "delayed constructors consume their completed preparation without rebuilding");
      for (const reservation of reservations) {
        reservation.release();
        assert.throws(() => reservation.take(scene), /consumed|released/);
      }
      assert.equal(takePrebuiltVectorStrokeLodRuntime(scene), null,
        "releasing consumed reservations cannot return active runtimes");
    } finally {
      delayedFirst.dispose();
      delayedSecond.dispose();
    }
    const released = takePrebuiltVectorStrokeLodRuntime(scene);
    assert(released);
    assert.equal(takePrebuiltVectorStrokeLodRuntime(scene), null, "disposal still retains only one idle hierarchy");
    storePrebuiltVectorStrokeLodRuntime(scene, released);

    const abandoned = await reserveVectorStrokeLodRuntime(scene, "force", "webgl");
    assert.throws(() => abandoned.take({ ...scene }), /different scene/);
    assert.equal(takePrebuiltVectorStrokeLodRuntime(scene), null);
    abandoned.release();
    assert.equal(takePrebuiltVectorStrokeLodRuntime(scene), released,
      "cancelling after preparation returns its unconsumed runtime");
    abandoned.release();
    assert.equal(takePrebuiltVectorStrokeLodRuntime(scene), null, "release is idempotent");
    storePrebuiltVectorStrokeLodRuntime(scene, released);

    let cancelReservation = false;
    await assert.rejects(reserveVectorStrokeLodRuntime(scene, "force", "webgl", {
      shouldCancel: () => cancelReservation,
      onProgress: event => { if (event.message === "Reusing Vector LOD") cancelReservation = true; }
    }), /cancel/i);
    assert.equal(takePrebuiltVectorStrokeLodRuntime(scene), released,
      "cancellation during the reservation yield preserves completed geometry");
    storePrebuiltVectorStrokeLodRuntime(scene, released);

    const failedConstruction = await reserveVectorStrokeLodRuntime(scene, "force", "webgl");
    const constructionError = new Error("stroke plan failed");
    assert.throws(() => new ThreeVectorLodStrokeLayer(scene, {
      ...options, drawPlan: { setStrokeSource: () => { throw constructionError; } }
    }, failedConstruction), error => error === constructionError);
    failedConstruction.release();
    assert.equal(takePrebuiltVectorStrokeLodRuntime(scene), released,
      "a constructor failure returns the runtime through its partial owner");
    assert.equal(takePrebuiltVectorStrokeLodRuntime(scene), null);
    assert.equal(await reserveVectorStrokeLodRuntime(scene, "off", "webgl"), null);
    fields.forEach((key, index) => assert.deepEqual(scene[key], original[index]));
  } finally {
    current.dispose();
    takePrebuiltVectorStrokeLodRuntime(scene);
  }
  console.log("LOD cache: bounded replacement, reuse, active ownership, double disposal, cancellation, delayed constructors and concurrency passed");
} finally {
  hooks.deregister();
}
