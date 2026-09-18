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
| `onDiagnostic` | — | Receive PDF diagnostics, including raster fallback, visual approximation, and ICC warnings with zero-based `pageIndex`. |

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
| `pick(options)` | Asynchronously find a canonical drawing primitive under client coordinates; returns a hit or `null`. |
| `subscribePrimitivePreparationProgress(listener)` | Observe shared picking preparation (integer 0–100, or `null` when idle/reset/failed); returns an unsubscribe function. |
| `getPrimitive(ref)` | Read original style and detached scene-space geometry. |
| `setHover(ref)` / `setSelection(refs)` | Draw amber hover and blue selection traces; `null` / `[]` clears them. |
| `setPrimitiveOverrides(refs, { color })` | Temporarily replace vector RGB, preserving opacity, masks, and drawing order. |
| `clearPrimitiveOverrides(refs?)` | Restore specified primitives, or all overrides when omitted. |
| `clearPrimitiveInteraction()` | Clear hover, selection, and colors and release the picking index. |
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

### Drawing primitives

`pick({ camera, element, clientX, clientY, tolerancePx?, kinds?, signal? })`
accepts browser `clientX`/`clientY` values directly. Tolerance defaults to four CSS
pixels and does not require device-pixel-ratio adjustment. The result contains
`primitive`, the cursor `point` in composed scene coordinates, `closestPoint`,
`distancePx`, and an optional `segmentIndex`. The last eligible painted primitive
within tolerance wins. `kinds` filters eligible types, which is useful for a
measurement tool interested only in strokes. This queries canonical geometry,
not antialiased framebuffer pixels or simplified LOD geometry.

`PrimitiveRef` is `{ kind, index }`, where `kind` is `"stroke"`, `"fill"`,
`"text"`, `"raster"`, `"gradient-fill"`, or `"gradient-stroke"`. Stroke indices
identify individual segments; gradient-stroke indices identify complete runs.
Text indices identify glyph instances: a ligature is not necessarily one
Unicode character. Raster references identify whole layers, not shapes inside
their pixels. Invisible OCR text has no pickable render instance.

`getPrimitive(ref)` returns `kind`, `index`, `ref`, `bounds`, `pageIndex` (or
`null` when ambiguous), original `color`/`opacity`, `segmentCount`, and
`getSegment(index)` / `getSegmentStyle(index)`. Each segment has detached `start`/`end` points and an
optional quadratic `control`. Stroke inspection includes `strokeWidth`; fill
inspection includes `fillRule`; raster inspection includes its transformed
`quad`, pixel `width`, and pixel `height`. Segment styles expose the original
color, opacity, and applicable stroke width, hairline/cap flags, and rectangular
clip. This preserves differing styles within a gradient-stroke run. Gradient
primitives also expose `gradientIndex` and `maskGradientIndex` into the retained
gradient store (`null` means a solid source or no mask). Gradient or mixed colors are `null`.
Geometry uses the same composed, Y-up scene coordinates as `sceneData`.

These are the retained drawing primitives. Extraction can merge lines, split
dashes, approximate curves, or rasterize content; HEP also quantizes coordinates.
Original CAD endpoints are not guaranteed to survive. Hosts supply drawing scale
for real-world measurements and implement snapping using the exposed segments.

References survive reopening the **exact same HEP artifact**. Store an immutable
document ID or artifact hash alongside `{ kind, index }`. Equal PDF bytes alone
do not establish compatible indices across different conversion settings,
pipelines, or versions. References are not portable between unrelated documents.
Invalid kinds/indices and invalid override batches throw before applying changes.

Hover and selection trace stroke centerlines, fill/glyph contours, and raster
frames inside geometric clips, using their own opacity independently of source
colors or gradient masks. They do not compute a new outline along clip edges.
Color overrides accept `0xRRGGBB`, `#rgb`, `#rrggbb`, bare `rrggbb`, CSS named colors such as
`"red"`, or normalized sRGB `[r, g, b]` tuples. Gradients receive a flat RGB
override while retaining their alpha and masks; rasters cannot be recolored.
The existing global vector tint is applied after primitive overrides.

All interaction state is runtime-only. `sceneData`, PDF/HEP export, and file size
remain unchanged. The picking hierarchy is built lazily; very large scenes group
several primitives into each spatial leaf to stay within its 128 MiB estimated
packed-buffer build budget. They retain spatial rejection and the same canonical
references and paint order. The index retains the existing geometry arrays; additional memory is
used for packed bounds, ordering, sparse overrides, and selected/hovered trace
buffers. First-pick latency includes index construction; coarser leaves may
require more candidate checks on dense pages. Index building
and expensive queries yield cooperatively. An `AbortSignal` cancels that request's
wait or query; a shared index build can continue for other requests. Disposing the
object cancels the build and outstanding queries. Hosts should cancel or ignore outdated hover
results when the pointer, camera, or document changes.

`subscribePrimitivePreparationProgress()` immediately reports the current value,
then follows the shared index build even when one hover query is cancelled.
Clearing interaction or disposing the object reports `null`; unsubscribe when
detaching UI from an object. Observer exceptions do not interrupt picking.

For optional built-in mouse/touch handling, use
`createThreePrimitiveInteractionController({ getCanvas, getCamera, getPdfObject,
requestRender, onSelectionChange?, onPreparationProgress?, onError? })`.
The controller starts disabled. `enable()` attaches gestures; `disable()` clears
its selection, colors, picking resources, and listeners. It handles hover,
click/tap selection, Escape, drag/pinch suppression, pointer cursor state, and
outdated query results. It owns the PDF object's primitive interaction state;
use one controller per viewport and coordinate any text-selection mode in the host.

Call `onFrame()` after updating the camera and object transforms,
`sceneChanged()` after replacing the document, and `rendererChanged()` after
replacing a canvas or PDF object for the exact same `sceneData`. The latter
replays selection and colors. `setSelectedColor(color)`, `resetSelectedColor()`,
and `resetAllColors()` support host UI controls. Call `dispose()` before tearing
down the viewport. The controller toggles the canvas's `drawing-selection-hover`
CSS class; the host provides its cursor styling. See the
[controller example](examples.md#shared-drawing-selection-controller).

Overriding ordinary stroke/text colors temporarily forces exact rendering for
that class and restores the requested LOD mode when cleared. Highlighting alone
keeps LOD active. Batch large color changes; Three.js/WebGPU may upload a whole
modified texture even when only a few colors changed. Use hover traces for
frequent pointer feedback. Call `clearPrimitiveInteraction()` to release the
optional interaction resources without disposing the document.

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

### Rendering compatibility and diagnostics

PDF loading and PDF-to-HEP conversion prefer opening a usable document over
rejecting a page because the optimized vector representation cannot express it.
The existing selective image layers remain the first fallback. When that cannot
preserve clipping or paint order, HEPR tries the retained-page renderer and
stores the affected page as one image layer. Other pages keep their vector output.

The page image targets 2 pixels per PDF point (144 dpi for ordinary pages), capped
at 16 million pixels and 16,384 pixels per dimension. Parser image and decoded-byte
limits can lower these ceilings. Rasterized pages lose vector sharpness and geometry
needed for features such as room detection. Their extracted text index is retained
separately for search and selection; no text is painted twice. HEP stores the image
and text using its existing format, with no source PDF needed when reopening it.

`onDiagnostic` receives these warnings (also retained by `PdfSession.getDiagnostics()`):

| Code | Meaning |
| --- | --- |
| `page-raster-fallback` | A whole page became an image; details include the original reason, pixel dimensions, and scale. |
| `compositing-approximation` | Unsupported group/stroke behavior was approximated for screen output. |
| `gradient-approximation` | Adaptive gradient sampling reached its depth limit before meeting the color tolerance. |
| `extgstate-approximation` | A print color/halftone setting or nonidentity transfer function was omitted for screen output. |

Stitching-function boundaries are sampled as hard color transitions. Gradient
color-tolerance misses are nonfatal, but stop-count and other hard resource limits
remain enforced. `/BG2`, `/UCR2`, and `/TR2` take precedence over their older entries.
Default resets are accepted; unsupported custom functions use the screen defaults
with a warning. In particular, BG/UCR can affect RGB-to-CMYK conversion inside a
transparency group, so their omission is an approximation even for RGB output.

The low-level Canvas2D renderer also accepts `onDiagnostic` for gradient warnings.
Cancellation, malformed required data, custom resolver errors, and hard resource
limits are not converted into successful output. Fallback uses HEPR's own renderer,
so features that it cannot compile or render can still fail. Node raster fallback
requires the existing optional `@napi-rs/canvas` backend; no dependency is installed
automatically. The CLI prints warning diagnostics.

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
