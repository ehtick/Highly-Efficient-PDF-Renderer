import assert from "node:assert/strict";
import { registerHooks } from "node:module";

const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    return nextResolve(
      context.parentURL?.includes("/src/") && /^\.\.?\//.test(specifier) && !specifier.endsWith(".ts")
        ? `${specifier}.ts` : specifier,
      context
    );
  }
});

try {
  const [{ compileDensePdfContent, DENSE_PDF_PAINT_RUN_STROKE }, { createHeprPageDataFromDense }, { validateHeprPageData }] =
    await Promise.all([
      import("../src/pdf/nativeContentCompiler.ts"),
      import("../src/densePdfPageData.ts"),
      import("../src/heprDocumentDataValidation.ts")
    ]);
  const pageInfo = {
    sourcePageIndex: 0, mediaBox: [0, 0, 1000, 1000], cropBox: [0, 0, 1000, 1000],
    bleedBox: null, trimBox: null, artBox: null,
    rotation: 0, userUnit: 1, width: 1000, height: 1000
  };
  const compile = content => compileDensePdfContent(new TextEncoder().encode(content), {
    pageMatrix: [1, 0, 0, 1, 0, 0],
    pageBounds: { minX: 0, minY: 0, maxX: 1000, maxY: 1000 },
    output: "display-program", enableSegmentMerge: false, enableInvisibleCull: false
  });
  const empty = await compile("");
  const root = await compile("/Root BMC 1 0 0 rg 2 3 4 5 re f 0 0 m 20 10 l S EMC");
  const first = await compile("/First BMC 0 1 0 RG 0 2 m 20 10 l S 3 4 5 6 re f EMC");
  const second = await compile("/Second BMC 1 2 3 4 re f 4 5 6 7 re f 1 1 m 8 9 l S EMC");
  const third = await compile("/Third BMC 0 0 1 RG 5 5 m 20 30 l S 8 9 m 12 13 l S EMC");
  // Preserve the sign bit even in components that compare numerically equal.
  first.endpoints[0] = -0;
  first.styles[2] = -0;
  first.fillPathMetaA[0] = -0;
  const fields = [
    ["strokes", "endpoints"], ["strokes", "primitiveMeta"],
    ["strokes", "primitiveBounds"], ["strokes", "styles"],
    ["paths", "fillPathMetaA"], ["paths", "fillPathMetaB"], ["paths", "fillPathMetaC"],
    ["paths", "fillSegmentsA"], ["paths", "fillSegmentsB"]
  ];
  const bits = values => new Uint32Array(values.buffer, values.byteOffset, values.length);
  const program = (compiled, resourceName) => ({
    compiled, resourceName, glyphOffset: 0, invocationProgramIndices: new Uint32Array(0),
    matrix: [1, 0, 0, 1, 0, 0], bounds: [0, 0, 1000, 1000]
  });
  const forms = programs => ({
    rootInvocationProgramIndices: new Uint32Array(0), annotations: [], programs
  });

  // Interleaved empty and repeated resources exercise each independent offset
  // space, including the same compiled program reused in different categories.
  const formSources = [empty, first, first];
  const type3Sources = [second, empty];
  const patternSources = [third, first];
  const sources = [root, ...formSources, ...type3Sources, ...patternSources];
  const unchanged = sources.map(source => fields.map(([, field]) => bits(source[field]).slice()));
  const patternCount = patternSources.length;
  const options = {
    forms: forms(formSources.map((source, index) => program(source, `Form${index}`))),
    type3: {
      glyphProgramIndices: new Int32Array(0),
      programs: type3Sources.map((source, index) => ({
        ...program(source, `Type3${index}`), colored: true, inheritedPaintRole: "none"
      }))
    },
    patterns: {
      matrices: new Float32Array(Array.from({ length: patternCount }, () => [1, 0, 0, 1, 0, 0]).flat()),
      programs: patternSources.map((source, patternIndex) => ({
        ...program(source, `Pattern${patternIndex}`), patternIndex, colored: true
      })),
      store: {
        kinds: new Uint8Array(patternCount), paintTypes: new Uint8Array(patternCount).fill(1),
        tilingTypes: new Uint8Array(patternCount).fill(1),
        bounds: new Float32Array(Array.from({ length: patternCount }, () => [0, 0, 1000, 1000]).flat()),
        xSteps: new Float32Array(patternCount).fill(1000), ySteps: new Float32Array(patternCount).fill(1000),
        matrixIndices: Uint32Array.from({ length: patternCount }, (_, index) => index),
        programIndices: new Int32Array(patternCount).fill(-1),
        gradientIndices: new Int32Array(patternCount).fill(-1),
        underlyingColorSpaceIndices: new Int32Array(patternCount).fill(-1)
      }
    }
  };
  const page = createHeprPageDataFromDense(pageInfo, root, options);
  validateHeprPageData(page);
  for (const [store, field] of fields) {
    // Independent reference for the previous repeated-concatenation layout.
    let expected = root[field];
    let segmentOffset = root.fillSegmentsA.length / 4;
    for (const source of sources.slice(1)) {
      let values = source[field];
      if (field === "fillPathMetaA" && segmentOffset !== 0 && values.length > 0) {
        values = values.slice();
        for (let offset = 0; offset < values.length; offset += 4) values[offset] += segmentOffset;
      }
      const next = new Float32Array(expected.length + values.length);
      next.set(expected);
      next.set(values, expected.length);
      expected = next;
      segmentOffset += source.fillSegmentsA.length / 4;
    }
    assert.deepEqual(bits(page.stores[store][field]), bits(expected), `${field} keeps every bit and resource offset`);
  }
  let strokeOffset = root.endpoints.length / 4;
  let fillOffset = root.fillPathMetaA.length / 4;
  let markedOffset = root.markedContent.length;
  for (let index = 1; index < sources.length; index++) {
    const source = sources[index];
    const expected = [];
    for (let offset = 0; offset < source.paintRuns.length; offset += 3) {
      const kind = source.paintRuns[offset];
      const isStroke = kind === DENSE_PDF_PAINT_RUN_STROKE;
      expected.push([
        isStroke ? "stroke-segments" : "fill-paths",
        source.paintRuns[offset + 1] + (isStroke ? strokeOffset : fillOffset),
        source.paintRuns[offset + 2],
        source.paintRunMarkedContentIndices[offset / 3] < 0 ? -1
          : source.paintRunMarkedContentIndices[offset / 3] + markedOffset
      ]);
    }
    assert.deepEqual(page.displayProgram.programs[index - 1].commands.map(command => [
      command.source, command.first, command.count, command.markedContentIndex
    ]), expected, "reusable commands retain source paint order and relocated geometry/scopes");
    strokeOffset += source.endpoints.length / 4;
    fillOffset += source.fillPathMetaA.length / 4;
    markedOffset += source.markedContent.length;
  }
  sources.forEach((source, index) => fields.forEach(([, field], fieldIndex) => {
    assert.deepEqual(bits(source[field]), unchanged[index][fieldIndex], `${field} source remains reusable`);
  }));
  assert.deepEqual(createHeprPageDataFromDense(pageInfo, root, options), page,
    "assembling shared resources again does not accumulate fill offsets");

  for (const [source, extra] of [
    [root, {}],
    [empty, { forms: forms([program(first, "Only")]) }],
    [root, { forms: forms([program(empty, "Empty")]) }]
  ]) {
    const result = createHeprPageDataFromDense(pageInfo, source, extra);
    const owner = source === empty ? first : source;
    for (const [store, field] of fields) {
      assert.equal(result.stores[store][field], owner[field], "one nonempty payload stays zero-copy");
    }
  }

  // Count actual Float32 copy traffic, not elapsed time or GC-dependent memory.
  // The former 64-way concatenation copied 64.96875 MiB to produce 2 MiB.
  const strokeCount = 512;
  const resource = await compile(Array.from({ length: strokeCount }, (_, index) =>
    `0 ${index + .125} m 100 ${index + .125} l S`).join("\n"));
  const resourceCount = 64;
  const copyOptions = { forms: forms(Array.from({ length: resourceCount }, (_, index) =>
    program(resource, `Repeated${index}`))) };
  const originalSet = Float32Array.prototype.set;
  let copiedBytes = 0;
  let copiedPage;
  try {
    Float32Array.prototype.set = function(source, offset) {
      if (source.length >= strokeCount * 4) copiedBytes += source.length * 4;
      return originalSet.call(this, source, offset);
    };
    copiedPage = createHeprPageDataFromDense(pageInfo, empty, copyOptions);
  } finally {
    Float32Array.prototype.set = originalSet;
  }
  validateHeprPageData(copiedPage);
  const geometryBytes = fields.reduce((sum, [store, field]) => sum + copiedPage.stores[store][field].byteLength, 0);
  assert.equal(geometryBytes, 2 * 1024 * 1024);
  assert.equal(copiedBytes, geometryBytes, "each resource payload is copied exactly once, regardless of program count");
  assert.equal(copiedPage.stores.strokes.endpoints.length / 4, strokeCount * resourceCount);
  console.log("Dense resource assembly tests passed (64 resources: 2 MiB copied for 2 MiB output).");
} finally {
  hooks.deregister();
}
