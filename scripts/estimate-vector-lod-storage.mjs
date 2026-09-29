import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFileSync, statSync, writeFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { constants, deflateSync, inflateSync } from "node:zlib";

// Read-only size estimate from an EXISTING HEP. The PDF is stat'ed, never read
// or parsed. No HEP archives are written. All generated LODs and Float32 bits
// are preserved: this does not use the HEP codec's coordinate quantization.
// Estimates exclude container/codec/index metadata and runtime tile/bucket
// arrays; those indexes would have to be rebuilt when loading stored geometry.
// Each invocation runs in a child with a hard 90-second default deadline.
// Native zlib-wrapped DEFLATE includes its 2-byte header and 4-byte checksum,
// matching CompressionStream("deflate") framing (compressed sizes can differ).
const usage = "Usage: node scripts/estimate-vector-lod-storage.mjs existing.hep source.pdf " +
  "[--output=report.json] [--timeout-ms=90000]";
const args = process.argv.slice(2);
const option = name => args.find(value => value.startsWith(`--${name}=`))?.slice(name.length + 3);
if (args.includes("--help")) {
  console.log(`${usage}\nPDF input is used only for its file size. No PDF conversion or archive writes.\n` +
    "Lossless native zlib-wrapped DEFLATE level 6; excludes container/index metadata and runtime tile/bucket arrays.");
  process.exit(0);
}
const inputs = args.filter(value => !value.startsWith("--"));
const timeoutMs = Number(option("timeout-ms") ?? 90_000);
try {
  assert(args.every(value => !value.startsWith("--") || value === "--worker" ||
    /^--(?:output|timeout-ms)=.+$/.test(value)), "Unknown or empty option");
  assert.equal(inputs.length, 2, "Specify an existing HEP and its source PDF");
  assert(Number.isSafeInteger(timeoutMs) && timeoutMs > 0 && timeoutMs <= 2_147_483_647,
    "timeout-ms must be a positive integer no larger than 2147483647");
  for (const input of inputs) assert(statSync(resolve(input)).isFile(), `Not a file: ${input}`);
  assert(statSync(resolve(inputs[1])).size > 0, "Source PDF must not be empty");
  if (option("output")) assert(!inputs.some(input => resolve(input) === resolve(option("output"))),
    "Report output must not overwrite either input");
} catch (error) {
  console.error(`${error.message}\n${usage}`);
  process.exit(1);
}

const fields = ["endpoints", "primitiveMeta", "primitiveBounds", "styles"];
const compressionOptions = { level: 6, windowBits: 15, memLevel: 8, strategy: constants.Z_DEFAULT_STRATEGY };

if (!args.includes("--worker")) {
  const child = spawn(process.execPath, ["--expose-gc", "--experimental-strip-types",
    fileURLToPath(import.meta.url), ...args, "--worker"], { stdio: "inherit" });
  let expired = false;
  const timer = setTimeout(() => {
    expired = true;
    console.error(`LOD storage estimate exceeded ${timeoutMs} ms; terminating the child.`);
    child.kill("SIGKILL");
  }, timeoutMs);
  child.once("error", error => { clearTimeout(timer); console.error(error.message); process.exitCode = 1; });
  child.once("exit", code => { clearTimeout(timer); process.exitCode = expired ? 124 : code ?? 1; });
} else {
  await estimate();
}


async function estimate() {
  const hooks = registerHooks({ resolve(specifier, context, next) {
    return next(context.parentURL?.includes("/src/") && /^\.\.?\//.test(specifier) &&
      !/\.[a-z0-9]+$/i.test(specifier) ? `${specifier}.ts` : specifier, context);
  } });
  try {
    const { loadSceneFromHep } = await import("../src/hep.ts");
    const { prebuildVectorStrokeLodRuntime } = await import("../src/vectorStrokeLodCore.ts");
    const { strokePaintOrigins } = await import("../src/vectorStrokePaintOrder.ts");
    const hepPath = resolve(inputs[0]), pdfPath = resolve(inputs[1]);
    const bytes = readFileSync(hepPath), scene = await loadSceneFromHep(bytes);
    const started = performance.now();
    const runtime = await prebuildVectorStrokeLodRuntime(scene, "auto", "webgl", { yieldIntervalMs: 25 });
    assert(runtime, "This scene did not generate a vector LOD runtime");
    const source = fields.map(key => wordView(scene[key])), levels = [];
    for (const level of runtime.levels.slice(1)) {
      const count = level.segmentCount, origins = strokePaintOrigins(level.scene);
      assert(origins?.length === count, "Derived level is missing canonical paint origins");
      const words = fields.map(key => wordView(level.scene[key]));
      const flags = new Uint8Array(Math.ceil(count / 8));
      let identical = 0;
      for (let index = 0; index < count; index++) {
        assert(origins[index] < scene.segmentCount, "Paint origin exceeds canonical geometry");
        const offset = index * 4, sourceOffset = origins[index] * 4;
        let same = true;
        for (let field = 0; field < fields.length && same; field++) for (let c = 0; c < 4; c++) {
          if (words[field][offset + c] !== source[field][sourceOffset + c]) { same = false; break; }
        }
        if (same) identical++;
        else flags[index >> 3] |= 1 << (index & 7);
      }
      const originCompression = bestWords(origins), deltas = deltaVarint(origins);
      originCompression.deltaVarint = compressedSize(deltas);
      validateDeltaVarint(deltas, origins);
      if (originCompression.deltaVarint < originCompression.best) {
        originCompression.best = originCompression.deltaVarint;
        originCompression.selected = "deltaVarint";
      }
      const flagBytes = compressedSize(flags), geometry = {}, literalGeometry = {};
      for (let field = 0; field < fields.length; field++) {
        geometry[fields[field]] = bestWords(words[field]);
        const literals = new Uint32Array((count - identical) * 4);
        let offset = 0;
        for (let index = 0; index < count; index++) if (flags[index >> 3] & (1 << (index & 7))) {
          for (let c = 0; c < 4; c++) literals[offset++] = words[field][index * 4 + c];
        }
        literalGeometry[fields[field]] = bestWords(literals);
        // Check reference/literal reconstruction against every original word.
        offset = 0;
        for (let index = 0; index < count; index++) for (let c = 0; c < 4; c++) {
          const value = flags[index >> 3] & (1 << (index & 7))
            ? literals[offset++] : source[field][origins[index] * 4 + c];
          assert.equal(value, words[field][index * 4 + c], "Reference reconstruction changed a Float32 bit pattern");
        }
      }
      const total = values => Object.values(values).reduce((sum, entry) => sum + entry.best, 0);
      levels.push({ tolerance: level.tolerance, overview: level.overview, count, identical, rawBytes: count * 68,
        origins: originCompression, flagBytes, geometry, literalGeometry,
        fullBestBytes: total(geometry) + originCompression.best,
        referenceLiteralBytes: total(literalGeometry) + originCompression.best + flagBytes });
      console.error(`Estimated ${count} strokes at tolerance ${level.tolerance}, overview=${level.overview}.`);
      globalThis.gc?.();
    }
    const sum = key => levels.reduce((total, level) => total + level[key], 0);
    const hepBytes = bytes.byteLength, pdfBytes = statSync(pdfPath).size;
    const report = { version: 1, hepPath, pdfPath, node: process.version, zlib: process.versions.zlib,
      compression: { method: "zlib-wrapped DEFLATE", ...compressionOptions },
      sourceStrokes: scene.segmentCount, levelCount: runtime.levels.length, derivedStrokes: sum("count"),
      identicalDerived: sum("identical"), hepBytes, pdfBytes, rawAdditionalBytes: sum("rawBytes"),
      fullBestAdditionalBytes: sum("fullBestBytes"), referenceLiteralAdditionalBytes: sum("referenceLiteralBytes"),
      fullBestTotalBytes: hepBytes + sum("fullBestBytes"), referenceLiteralTotalBytes: hepBytes + sum("referenceLiteralBytes"),
      fullBestPdfRatio: (hepBytes + sum("fullBestBytes")) / pdfBytes,
      referenceLiteralPdfRatio: (hepBytes + sum("referenceLiteralBytes")) / pdfBytes,
      milliseconds: performance.now() - started, levels,
      validation: "Raw bytes, shuffled/XOR words, delta origins, flags and reference/literal reconstruction roundtrip exactly.",
      exclusions: "Container/codec/index metadata and runtime tile/bucket arrays; indexes must be rebuilt. No archive written or PDF parsed." };
    const json = `${JSON.stringify(report, null, 2)}\n`;
    if (option("output")) writeFileSync(resolve(option("output")), json);
    console.log(json);
  } finally { hooks.deregister(); }
}

function wordView(values) {
  return new Uint32Array(values.buffer, values.byteOffset, values.length);
}

function compressedSize(bytes) {
  const packed = deflateSync(bytes, compressionOptions), restored = inflateSync(packed);
  assert(restored.equals(Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength)), "DEFLATE changed input bytes");
  return packed.byteLength;
}

function bestWords(words) {
  const counts = { raw: compressedSize(new Uint8Array(words.buffer, words.byteOffset, words.byteLength)) };
  for (const [key, predict] of [["shuffle", false], ["xorShuffle", true]]) {
    const length = words.length, planes = new Uint8Array(length * 4);
    for (let index = 0; index < length; index++) {
      // XOR with the prior float4's same component, then separate byte planes.
      const value = predict ? words[index] ^ (index >= 4 ? words[index - 4] : 0) : words[index];
      for (let byte = 0; byte < 4; byte++) planes[byte * length + index] = value >>> (byte * 8);
    }
    counts[key] = compressedSize(planes);
    const restored = new Uint32Array(length);
    for (let index = 0; index < length; index++) {
      let value = 0;
      for (let byte = 0; byte < 4; byte++) value |= planes[byte * length + index] << (byte * 8);
      restored[index] = value ^ (predict && index >= 4 ? restored[index - 4] : 0);
      assert.equal(restored[index], words[index], "Shuffle/XOR changed a Float32 bit pattern");
    }
  }
  const selected = Object.keys(counts).reduce((best, key) => counts[key] < counts[best] ? key : best, "raw");
  return { ...counts, best: counts[selected], selected };
}

function deltaVarint(values) {
  const bytes = new Uint8Array(values.length * 5);
  let offset = 0, previous = 0;
  for (const value of values) {
    const delta = value - previous;
    previous = value;
    let code = delta >= 0 ? delta * 2 : -delta * 2 - 1;
    while (code >= 128) { bytes[offset++] = (code % 128) | 128; code = Math.floor(code / 128); }
    bytes[offset++] = code;
  }
  return bytes.subarray(0, offset);
}

function validateDeltaVarint(bytes, values) {
  let offset = 0, previous = 0;
  for (const value of values) {
    let code = 0, factor = 1, byte;
    do { byte = bytes[offset++]; code += (byte & 127) * factor; factor *= 128; } while (byte & 128);
    previous += code % 2 ? -(code + 1) / 2 : code / 2;
    assert.equal(previous, value, "Delta varint changed a canonical paint origin");
  }
  assert.equal(offset, bytes.length);
}
