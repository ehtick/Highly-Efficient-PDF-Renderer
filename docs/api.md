# API reference

[Overview](../README.md) · [Examples](examples.md) · [Manual](manual.md)

This page covers the main integration APIs. The package ships TypeScript declarations;
[the public entry point](../src/index.ts) lists every exported function and type.

## Package entry points

| Import | Purpose |
| --- | --- |
| `@soadzoor/hepr` | Three.js objects, HEP export, search, selection, LOD utilities, and room detection. |
| `@soadzoor/hepr/three` | Alias for the main entry point, with the same exports. |
| `@soadzoor/hepr/node` | Node file sources, PDF worker sessions, and bundled standard-font resolution. |
| `@soadzoor/hepr/experimental/pdf-worker` | Worker entry used by the PDF session infrastructure. |
| `@soadzoor/hepr/experimental/dense-pdf-worker` | Worker entry for the specialized dense-vector parser. |

## `pdfObjectGenerator(source, options?, rendererType?)`

Returns `Promise<HeprThreePdfObject>`. The result is a `THREE.Group` that follows
your Three.js camera through its render hooks. Add it to your scene and render
normally; frame the camera using the object's bounds as shown in the [examples](examples.md).

```ts
import { pdfObjectGenerator } from "@soadzoor/hepr";

const pdf = await pdfObjectGenerator("/drawings/plan.pdf", {
  pages: "1-3, 5",
  onProgress: ({ value, stage }) => console.log(value, stage)
});
scene.add(pdf);
```

`source` accepts PDF or HEP bytes as `Uint8Array` / `ArrayBuffer`, a `File` /
`Blob`, a fetchable URL or browser-relative path, a base64 payload, or a data URL.
For local files in Node, read the file into bytes before calling the shared APIs.

`rendererType` is the **third argument**: `"webgl"` (default) or `"webgpu"`.
Use `"webgpu"` with a WebGPU-capable Three.js renderer and browser/GPU support.

### Loading options

| Option | Default | Behavior |
| --- | --- | --- |
| `signal` | — | `AbortSignal` for source reading, parsing, LOD preparation, and object creation. |
| `sourceKind` | `"auto"` | Infer the format from the source, or force `"pdf"` / `"hep"`. |
| `pages` | All pages | One-based PDF pages: `"2"`, `"1-3, 5"`, `"5-"`, or `"-3"`. |
| `maxPagesPerRow` | Automatic grid | Maximum pages per row when composing a PDF scene. |
| `segmentMerge` | `true` | Merge compatible adjacent vector stroke segments during PDF parsing. |
| `invisibleCull` | `true` | Drop known invisible content during PDF parsing. |
| `pdfFastPath` | `"auto"` | Try the specialized dense-vector parser; `"off"` uses the full parser. |
| `extractText` | `false` | Also populate scene-space text items for tasks such as room-label seeding. |
| `onProgress` | — | Receive overall progress (`value` from 0 to 1) and the current `stage`. |
| `iccTransformResolver` | — | Supply a batched ICC-to-sRGB conversion engine; works through PDF workers. |
| `iccEngine` | `"qcms"` | `"qcms"` or `"lcms"`: try the preferred engine, then the other engine, then alternate colors. `"alternate"`: approximate directly. `"none"`: disable built-in conversion and approximation. |
| `onDiagnostic` | — | Receive PDF diagnostics, including `icc-engine-fallback` and `icc-alternate-used` warnings with zero-based `pageIndex`. |

Page selections are deduplicated and composed in document order. Invalid selections
reject with `RangeError`. HEP files preserve their saved page selection and layout;
PDF parsing options do not reprocess a HEP scene. Search uses the text index and
does not require `extractText: true`.

See [loading option types](../src/pdfObjectGenerator.ts) and
[progress fields and stages](../src/loadProgress.ts). All selected pages are
prepared before the promise resolves. Cancellation is cooperative; after a
successful load, the returned object belongs to the caller and needs disposal.

### Rendering options

| Option | Default | Behavior |
| --- | --- | --- |
| `vectorLod` | `"auto"` | Use stroke LOD for large scenes; `"off"` keeps exact strokes, `"force"` enables it below the usual threshold. |
| `textLod` | `"auto"` | Simplify subpixel text clusters; `"off"` keeps exact glyphs. |
| `curveStrokes` | `true` | Enable curve-aware stroke joins and caps where supported. |
| `vectorOnly` | `false` | Use vector glyph geometry instead of the raster glyph atlas. |
| `pageBackground` | `"#ffffff"` | Page background color. |
| `pageBackgroundOpacity` | `1` | Page background alpha, from 0 to 1. |
| `vectorOverrideColor` | `"#000000"` | Color used to tint or replace vector colors. |
| `vectorOverrideOpacity` | `0` | Override strength: 0 preserves original colors, 1 replaces them. |
| `threeColorCompositing` | `"linear"` | Three/WebGPU alpha-compositing domain; `"display"` requires `renderer.outputColorSpace = THREE.LinearSRGBColorSpace`. |

Colors accept hex strings, numbers such as `0xffffff`, or normalized RGB tuples
such as `[1, 1, 1]`. See [rendering option types](../src/threePdfObject.ts).

## `HeprThreePdfObject`

The object supports normal Three.js transforms. `sceneData` contains its parsed
`VectorScene`; treat it as read-only. `sourceLabel`, `sourceKind`, and
`rendererType` describe the loaded source and backend.

| Member | Purpose |
| --- | --- |
| `hasSearchableText` | Whether the scene has searchable indexed text. |
| `searchText(query, options?)` | Return matches with scene-space and object-local bounds. |
| `setSearchHighlights(matches, { currentIndex }?)` | Highlight matches and emphasize the active one; `null` clears them. |
| `setTextSelectionHighlights(rects)` | Draw scene-space `Bounds[]` or packed `Float32Array` selection rectangles; `null` clears them. |
| `clientToScenePoint(camera, x, y, element)` | Map client CSS pixels to PDF scene coordinates; may return `null`. |
| `sceneToClientPoint(camera, x, y, element)` | Project PDF scene coordinates to client CSS pixels; may return `null`. |
| `setVectorLodMode(mode)` / `setTextLodMode(mode)` | Change LOD at runtime. |
| `setPageBackgroundColor(r, g, b, alpha)` | Set normalized page background components. |
| `setVectorColorOverride(r, g, b, opacity)` | Set normalized vector override components. |
| `getVectorStrokeLodStats()` / `getTextLodStats()` | Inspect LOD statistics; may return `null` before data is available. |
| `prepareFrameForThreeRenderer(renderer, camera)` | Explicit preparation for advanced render pipelines; ordinary loops synchronize automatically. |
| `dispose()` | Release owned GPU resources, textures, geometry, and event listeners. |

Remove the object from its parent when disposing it:

```ts
pdf.removeFromParent();
pdf.dispose();
```

`attachControls()`, `fitToBounds()`, and `setViewState()` manage the internal
fallback viewport. In an ordinary Three.js integration, use your application's
camera and controls. Full method contracts: [HeprThreePdfObject](../src/threePdfObject.ts).

## `buildHep(input, options?)`

Returns `Promise<Blob>` with MIME type `application/x-hep`. Save it with a `.hep`
extension. Import it from `@soadzoor/hepr` in either a browser or Node.

| Input | Options |
| --- | --- |
| PDF source (`PdfObjectSource`) | `BuildHepFromPdfOptions`: shared encoding options, `pages`, `maxPagesPerRow`, `segmentMerge`, `invisibleCull`, `iccTransformResolver`, `iccEngine`, and `onDiagnostic`. |
| Parsed `VectorScene` | `BuildHepFromSceneOptions`: shared encoding options, optional `sourcePdf` and `sourcePdfPages` for image fallback. |

Shared encoding options are `sourceLabel`, `encodeRasterImages` (default `true`),
`compression` (`"deflate"` by default, or `"store"`), `onProgress`, and `signal`.
Compressed writing requires native `CompressionStream("deflate")`; loading
compressed files requires `DecompressionStream("deflate")`.

Pass an already-loaded `pdf.sceneData` to avoid parsing again. `sourcePdf` is
needed only when the scene reports PDF image operations but has no extracted
raster layers; provide the matching `sourcePdfPages` if pages were selected.

Node hosts can install the optional `@napi-rs/canvas` backend for PDF operations
that need Canvas2D, image encoding, and encoded HEP image decoding. See the
[conversion examples](examples.md), [builder types](../src/hepBuilder.ts), and
[HEP format specification](HEP_CONTAINER.md).

### ICC colors

PDF loading and PDF-source `buildHep` calls default to **Mozilla qcms**. Both
engines ship as separate WASM assets with HEPR. The preferred engine loads only
when page compilation needs an ICC profile; the second loads only on fallback.
The choice applies per profile, so one unsupported profile does not change the
preferred engine for other profiles. The available settings are:

| `iccEngine` | Conversion order |
| --- | --- |
| `"qcms"` (default) | qcms → Little CMS → alternate colors |
| `"lcms"` | Little CMS → qcms → alternate colors |
| `"alternate"` | Skip both engines and use alternate colors, with an approximation warning. |
| `"none"` | Disable built-in conversion and approximation; reject ICC content requiring conversion unless a custom resolver is supplied. |

Fallback occurs when an engine cannot load or cannot convert the profile;
metadata-only parsing and PDFs without ICC colors load neither. Browser assets
are fetched relative to the HEPR package, and Node reads the packaged files.
There are no new runtime npm dependencies or third-party CDN requests.

```ts
const hep = await buildHep(pdfBytes, {
  iccEngine: "qcms", // optional; this is the default
  onDiagnostic: diagnostic => console.warn(diagnostic.message)
});
```

These options also apply to `openPdf`, worker sessions, and PDF scene loading.
An `icc-engine-fallback` warning identifies a switch to the other engine; this
alone does not mean alternate colors were used. If both engines fail, or
`"alternate"` was selected, an `icc-alternate-used` warning explains that colors
may differ from the intended appearance. Warnings are emitted once per affected
color space per page, not per pixel or paint operation. Their `details` include
the requested `engine`, `effectiveEngine`, and `qcmsFailureReason` /
`lcmsFailureReason` (`engine-load-failed`, `profile-unsupported`, or `null` when
that engine did not fail).
Selecting `"alternate"` on a PDF without ICC colors produces no ICC warning.

Little CMS supports Gray, RGB, CMYK, and Lab inputs; the bundled qcms adapter
supports Gray, RGB, and CMYK, with ICC Lab profiles falling back to Little CMS.
Both engines use relative-colorimetric sRGB and bounded RGB8 lookup tables, so
this is not a print-proofing pipeline.

For a caller-owned engine, supply `iccTransformResolver`. This overrides
`iccEngine` (including `"none"`) and prevents either built-in engine from loading.
HEPR sends isolated profile bytes and normalized sample batches, and expects
packed sRGB samples; see the exported `NativeIccTransformResolver`,
`NativeIccTransformRequest`, and `NativeIccTransformResult` types. The existing
custom-resolver contract is unchanged: `/Range` endpoints map to zero and one.
Built-in engines instead clip source values to `/Range` and encode the profile's
native color model, including ICC Lab8. Caller-resolver errors, malformed profile
headers, cancellation, and resource-limit failures still reject.

The `PDFtoHEP.js` CLI accepts `--icc-engine=qcms|lcms|alternate|none` and prints
fallback warnings. The former `iccFallback` API option and `--icc-fallback` CLI
flag have been removed; use `iccEngine` alone. Retained page data uses version 8,
which includes prepared ICC transforms and fallback decisions
for gradients and compositing. Version 7 retained pages must be regenerated;
the HEP container and saved scene formats are unchanged. Existing HEP files keep
their saved colors, and opening them never loads an ICC engine.

## Search and selection

`pdf.searchText(query, { caseSensitive, maxMatches })` defaults to
case-insensitive matching with a 5,000-match limit. Whitespace matches across
line breaks. Results use zero-based composed `pageIndex` values and UTF-16 text
offsets. Use `localBounds` for navigation in the object's local space, and
`highlightBounds` / `localHighlightBounds` for tight rectangles around wrapped hits.

For a custom scene pipeline, `createSceneTextSearcher(scene)` returns a searcher
with `hasText` and `search(query, options?)`. `createTextSearchController(options)`
adds query state and next/previous navigation for native renderer integrations.
See [search contracts](../src/textSearch.ts).

`createTextSelectionController(options)` adds mouse and touch selection, copy,
and selection overlays. Supply `getCanvas` and a `TextSelectionAdapter` that
exposes the scene, coordinate conversions, and highlight drawing. The optional
`setCameraInteractionEnabled` adapter callback coordinates selection with camera controls.

Call `updateOverlay()` after rendering to position touch handles and the copy
popup, `refreshHighlights()` after switching backends, and `dispose()` on teardown.
The controller also provides `enable()`, `disable()`, `clearSelection()`,
`getSelectedText()`, and asynchronous `copySelection()`. See the
[selection adapter and controller types](../src/textSelection.ts) and
[integration examples](examples.md).

Both features use the scene's text index in PDF and HEP documents. Text geometry
helpers `computeCharQuad` and `computeCharRangeBounds` are also exported;
their coordinate and buffer contracts are in [sceneTextGeometry.ts](../src/sceneTextGeometry.ts).

## `detectRooms(scene, options?)`

Returns `Promise<RoomDetectionResult>`. The detector loads on first use and requires
Web Worker support in browsers. Non-browser environments without `Worker` run it
on the calling thread.

Pass `pageIndexes` to select zero-based scene pages, `seeds` for explicit seed
points, `signal` to cancel, or `collectDebugInfo: true` for diagnostics. Enable
`extractText` when loading a PDF to supply room-label text items; HEP scenes use
their saved text index as a seed source.

Results include `rooms` and `failedSeeds`. Each room provides a flat `polygon`
coordinate array, `area` in scene units squared, `labelText`, `roomNumber`, and
`hasDoorEvidence`. Thresholds and wall-detection controls are described in the
[room detection types](../src/roomDetector.ts); see also [quality and evaluation](room-detector-quality.md).

## Node sessions and native viewer integration

The [Node entry](../src/nodePdfSource.ts) exports `createNodeFilePdfSource(path,
options?)` for random-access local-file reads, `openPdfInNodeWorker(source,
options?)` for a PDF parser session, and `createNodeBundledStandardFontResolver(options?)`
for lazy bundled font loading. Close worker sessions with `await session.close()`;
close a file source yourself if it is never handed to a session. Session options
and methods are defined in [workerClient.ts](../src/pdf/workerClient.ts) and
[nativeTypes.ts](../src/pdf/nativeTypes.ts).

The standalone native viewer is a repository application. Its renderer classes
are source modules, not named exports from the npm entry point. Use
[main.ts](../src/main.ts) as the integration example and
[RendererApi](../src/rendererTypes.ts) as the backend contract for
[WebGL](../src/webGlFloorplanRenderer.ts) and [WebGPU](../src/webGpuFloorplanRenderer.ts).
The exported `createCanvasInteractionController(getRenderer)` attaches native
pan/zoom controls; its lifecycle is documented in [canvasInteractions.ts](../src/canvasInteractions.ts).
