import assert from "node:assert/strict";
import { registerHooks } from "node:module";

const hooks = registerHooks({ resolve(specifier, context, next) {
  return next(context.parentURL?.includes("/src/") && /^\.\.?\//.test(specifier) &&
    !/\.[a-z0-9]+$/i.test(specifier) ? `${specifier}.ts` : specifier, context);
} });
const globals = Object.fromEntries(["GPUBufferUsage", "GPUTextureUsage", "GPUShaderStage"]
  .map(key => [key, globalThis[key]]));
globalThis.GPUBufferUsage = { UNIFORM: 1, COPY_DST: 2, STORAGE: 4 };
globalThis.GPUTextureUsage = { TEXTURE_BINDING: 1, COPY_DST: 2, RENDER_ATTACHMENT: 4 };
globalThis.GPUShaderStage = { VERTEX: 1, FRAGMENT: 2 };

try {
  const { WebGpuFloorplanRenderer } = await import("../src/webGpuFloorplanRenderer.ts");
  const { createEmptyVectorScene } = await import("../src/emptyVectorScene.ts");
  const create = () => {
    const device = makeDevice();
    const canvas = { width: 100, height: 100,
      getBoundingClientRect: () => ({ width: 100, height: 100, left: 0, top: 0 }) };
    const renderer = new WebGpuFloorplanRenderer(canvas, device,
      { configure() {}, getCurrentTexture: () => device.createTexture({}) }, "rgba8unorm");
    Object.assign(renderer, {
      scene: createEmptyVectorScene(), fillPathCount: 5, segmentCount: 10, textInstanceCount: 3,
      fillBindGroup: {}, strokeBindGroupAll: {}, textBindGroup: {},
      vectorClipBindGroups: [{}, {}], usingAllSegments: true,
      pageBackgroundResources: [{ bindGroup: {} }], rasterLayerResources: [{ bindGroup: {} }],
      orderedGradientPaintCommands: [{ kind: "raster", index: 0 }],
      needsVisibleSetUpdate: false,
      requestFrame() {}, updateStrokeVisibleSet() {},
      resolveClientToPixelScale: () => ({ x: 1, y: 1 }),
      shouldUseVectorMinifyPath: () => false
    });
    let report;
    renderer.setFrameListener(stats => { report = stats; });
    const frame = () => {
      const start = device.draws;
      report = undefined;
      renderer.render(1);
      assert(report, "every completed render reports its statistics");
      assert.equal(report.drawCalls, device.draws - start, "statistics count actual commands across all frame passes");
      return report.drawCalls;
    };
    return { renderer, device, frame };
  };

  {
    const { renderer, device, frame } = create();
    const banded = device.shaders.filter(source => source.includes("heprFillBandInfo"));
    assert.equal(banded.length, 2, "solid and gradient native pipelines include the shared band lookup");
    for (const source of banded) {
      assert.match(source, /heprBandRows\(bandInfo, band, bandCount, box\)/, "each band integrates only its own rows, so neighbouring bands cannot duplicate winding");
      assert.match(source, /packedIndex & 3/, "band entries use packed component addressing");
      assert.match(source, /heprFillCellInfo\(f32\(pathIndex\), uCamera\.fillCells\.[xy]/, "each path loads its cell header");
      assert.match(source, /heprCellWinding\(inData\.cells, inData\.origin, box, footprint/,
        "an indexed path reads only the cells under the pixel");
      assert.match(source, /fn heprUnfoldedPaint\(inData: \w+\) -> vec4f/, "a folded group chain scales the paint itself");
    }
    assert.deepEqual(banded.map(source => /@group\((\d)\) @binding\(0\) var<uniform> uPaintFold/.exec(source)?.[1]), ["2", "3"],
      "fills take their fold in group 2, gradient fills after their colour override in group 3");
    const text = device.shaders.find(source => source.includes("uTextGlyphSegmentTexA"));
    assert(text, "the actual native text pipeline is generated");
    assert.doesNotMatch(text, /i < 2048/, "valid long outlines have no fixed shader ceiling");
    assert.match(text, /i < inData.segmentCount/, "native text traverses the complete glyph");
    frame();
    assert.deepEqual(device.cameraData.slice(16), [-1, 0, -1, 0, 0, 0, 0, 0], "unindexed fill bindings are disabled");
    Object.assign(renderer, { fillBandBase: 41, fillBandEntries: 87, gradientFillBandBase: 91, gradientFillBandEntries: 125,
      fillCellBase: 140, gradientFillCellBase: 170 });
    frame();
    // Cell headers are uploaded plus one, so zero disables them.
    assert.deepEqual(device.cameraData.slice(16), [41, 87, 91, 125, 141, 171, 0, 0],
      "both fill stores upload distinct band and cell addresses");
  }

  {
    const { renderer, frame } = create();
    assert.equal(frame(), 5, "background, raster, fill, stroke and text each submit one command");
    assert.equal(frame(), 5, "draw-call statistics reset each frame");
    // heprPerf captures native WebGPU too; this device cannot time the GPU.
    const profiler = renderer.getPerformanceProfiler();
    assert.equal(renderer.getPerformanceProfiler(), profiler);
    profiler.start({ maxFrames: 3 });
    frame(); frame();
    const captured = profiler.stop();
    assert.equal(captured.frames, 2);
    assert.equal(captured.counters.drawCalls.p50, 5);
    assert.ok(captured.cpuSections.drawSubmission, "frames record their draw submission");
    assert.equal(captured.gpu.status, "unavailable");
    assert.match(captured.gpu.reason, /timestamp-query/);
    renderer.setPrimitiveHighlights({ count: 2, selectionCount: 1, clipPaths: [],
      segments: new Float32Array(16) });
    Object.assign(renderer, {
      highlightSelectionCount: 2, highlightSelectionBindGroups: [{}],
      highlightOthersCount: 8, highlightOthersBindGroups: [{}],
      highlightCurrentCount: 1, highlightCurrentBindGroups: [{}]
    });
    assert.equal(frame(), 9, "instanced primitive, selection and search highlights each count once");
    renderer.shouldUseVectorMinifyPath = () => true;
    assert.equal(frame(), 10, "offscreen vector draws and final minify composite belong to the same frame");
    renderer.shouldUseVectorMinifyPath = () => false;
    renderer.setPrimitiveHighlights(null);
    renderer.highlightSelectionCount = renderer.highlightOthersCount = renderer.highlightCurrentCount = 0;
    assert.equal(frame(), 5, "direct rendering without highlights submits the scene each frame");
    renderer.rasterRenderingEnabled = renderer.fillRenderingEnabled =
      renderer.strokeRenderingEnabled = renderer.textRenderingEnabled = false;
    assert.equal(frame(), 0, "disabled rendering clears the previous count");
    renderer.scene = null;
    assert.equal(frame(), 0, "clear-only rendering submits no draw calls");
  }

  {
    const { renderer, frame } = create();
    renderer.scene.drawRuns = [
      { kind: "fill", first: 0, count: 5 },
      { kind: "stroke", first: 0, count: 3, blendMode: "Multiply" },
      { kind: "raster", first: 0, count: 3 }
    ];
    renderer.rasterStripResources = new Map([[0, { first: 0, count: 3, bindGroup: {} }]]);
    renderer.rasterStripPipeline = {};
    assert.equal(frame(), 9, "ordered fill, two multiply passes per stroke and one raster strip include the background");
    renderer.orderedRunCuller = { select: () => [] };
    assert.equal(frame(), 1, "culled runs issue no commands");
  }

  {
    const { renderer, device, frame } = create();
    renderer.scene.drawRuns = [{ kind: "fill", first: 0, count: 5 }];
    renderer.scene.paintGraph = { roots: [{ kind: "group", isolated: true, knockout: false,
      alpha: 0.5, blendMode: "Normal", children: [{ kind: "draw", runIndex: 0 }] }] };
    const count = frame();
    assert(count > 3, "transparency adds intermediate compositor commands beyond the background and fill");
    assert(device.copies > 0, "exercise copies which are excluded from the draw-call count");
    assert.equal(frame(), count, "reusing the compositor still reports a fresh frame total");
  }

  {
    const { renderer, frame } = create();
    renderer.gradientData = { gradientFillPathCount: 2, gradientStrokeRunCount: 1,
      gradientStrokeRunMetaA: Float32Array.of(0, 10, 0, 0) };
    renderer.gradientFillBindGroup = {};
    renderer.gradientStrokeBindGroup = {};
    renderer.gradientMeshRanges = Uint32Array.of(0, 0, 0, 6);
    renderer.gradientMeshPipeline = {};
    renderer.gradientMeshBuffer = {};
    renderer.orderedGradientPaintCommands.push({ kind: "gradient-fill", index: 0 },
      { kind: "gradient-fill", index: 1 }, { kind: "gradient-stroke", index: 0 });
    assert.equal(frame(), 8, "analytic gradient, gradient mesh and instanced gradient stroke each count once");
    renderer.vectorLodRuntime = { levels: [{ visibleSegmentCount: 7 }, { visibleSegmentCount: 4 }, { visibleSegmentCount: 0 }] };
    renderer.vectorLodLevelResources = [{ bindGroup: {} }, { bindGroup: {} }, { bindGroup: {} }];
    assert.equal(frame(), 9, "each visible LOD batch adds one call, and empty batches add none");
  }
  {
    // Minified pages hold the paint scheduler's coverage margin. Every path
    // that reports stats forwards that, because neighbour order is relaxed.
    const { renderer } = create();
    let report;
    renderer.setFrameListener(stats => { report = stats; });
    renderer.render(1);
    assert.equal(report.paintOrderApproximated, false, "an exact schedule reports exact paint order");
    renderer.orderedBatches = { paintOrderApproximated: true, culledSegmentCount: 0 };
    renderer.render(1);
    assert.equal(report.paintOrderApproximated, true, "a held margin reaches the frame listener");
    renderer.shouldUseVectorMinifyPath = () => true;
    renderer.render(1);
    assert.equal(report.paintOrderApproximated, true, "including a minified composite");
  }

  console.log("WebGPU draw calls: direct, ordered, culled, multiply, raster strips, gradients, LOD, minify, highlights, compositing and empty frames passed.");
} finally {
  for (const [key, value] of Object.entries(globals)) {
    if (value === undefined) delete globalThis[key]; else globalThis[key] = value;
  }
  hooks.deregister();
}

function makeDevice() {
  const device = {
    draws: 0, copies: 0, shaders: [], cameraData: null,
    limits: { maxTextureDimension2D: 2048 },
    queue: { writeBuffer(_buffer, _offset, data) {
      if (data instanceof Float32Array && data.length === 24) device.cameraData = [...data];
    }, writeTexture() {}, submit() {} },
    createShaderModule: descriptor => { device.shaders.push(descriptor.code); return descriptor; },
    createBindGroupLayout: descriptor => descriptor,
    createPipelineLayout: descriptor => descriptor,
    createSampler: descriptor => descriptor,
    createBindGroup: descriptor => descriptor,
    createRenderPipeline: descriptor => ({ descriptor, getBindGroupLayout: index => descriptor.layout.bindGroupLayouts[index] }),
    createBuffer: () => ({ destroy() {} }),
    createTexture: () => ({ createView() { return { texture: this }; }, destroy() {} }),
    createCommandEncoder: () => ({
      beginRenderPass: () => ({ setPipeline() {}, setBindGroup() {}, setVertexBuffer() {},
        draw() { device.draws++; }, end() {} }),
      copyTextureToTexture() { device.copies++; }, finish() { return {}; }
    })
  };
  return device;
}
