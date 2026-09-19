# API reference

[Overview](../README.md) · [Examples](examples.md) · [Manual](manual.md)

This page covers the main integration APIs. The package ships TypeScript declarations;
[the public entry point](../src/index.ts) lists every exported function and type.

## Package entry points

| Import | Purpose |
| --- | --- |
| `@soadzoor/hepr` | Three.js objects, HEP export, search, selection, LOD utilities, and room detection. |
| `@soadzoor/hepr/three` | Alias for the main entry point, with the same exports. |
| `@soadzoor/hepr/bundler` | Same public API as the main entry, with modules and assets prepared for browser application bundlers. |
| `@soadzoor/hepr/node` | Node file sources, PDF worker sessions, and bundled standard-font resolution. |
| `@soadzoor/hepr/experimental/pdf-worker` | Worker entry used by the PDF session infrastructure. |
| `@soadzoor/hepr/experimental/dense-pdf-worker` | Worker entry for the specialized dense-vector parser. |

For bundled browser applications, consistently use the `/bundler` entry and the
[Vite settings in the quick start](../README.md#quick-start). The main and
`/three` entries retain the prebuilt layout for serving intact and for Node.

## `pdfObjectGenerator(source, options?, rendererType?)`

Returns `Promise<HeprThreePdfObject>`. The result is a `THREE.Group` that follows
your Three.js camera through its render hooks. Add it to your scene and render
normally; frame the camera using the object's bounds as shown in the [examples](examples.md).

```ts
import { pdfObjectGenerator } from "@soadzoor/hepr/bundler";

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

## `buildStrokeScene(polylines, defaults?)`

Synchronously returns a `VectorScene` compiled from host-provided 2D geometry.
No PDF, canvas, or GPU context is needed to build it. Pass the result directly
to `createThreePdfObject` to use the existing Three.js renderer and stroke LOD.

```ts
import { buildStrokeScene, createThreePdfObject } from "@soadzoor/hepr/bundler";

const geometry = buildStrokeScene([
  { points: [[0, 0], [100, 0], [100, 60], [0, 60]], closed: true },
  { points: new Float32Array([0, 30, 100, 30]), color: "#dc2626", width: 0.25 }
], { color: "#334155", width: 0.5 });
const drawing = await createThreePdfObject(geometry, {
  sourceLabel: "Sheet layout",
  vectorLod: "auto"
});
scene.add(drawing);
```

Each `StrokeScenePolyline` contains:

| Field | Default | Meaning |
| --- | --- | --- |
| `points` | Required | Readonly `[x, y]` tuples, or a flat `Float32Array` / `Float64Array` of coordinate pairs. |
| `closed` | `false` | Add the last-to-first edge unless the final point already equals the first. |
| `color` | Inherited | sRGB `#RGB`, `#RRGGBB`, CSS color name, `0xRRGGBB`, or normalized RGB tuple. Tuple channels are clamped to 0–1. |
| `width` | Inherited | Nonnegative full stroke width in scene units; zero means a device-pixel hairline. |

The optional `StrokeSceneStyle` defaults supply `color` (black) and `width` (1)
for polylines that omit them. Strokes are opaque and solid, with round caps and
round joins. This version does not accept dash patterns, other cap/join styles,
curves, fills, text, or images. Keep `curveStrokes` enabled (the rendering default)
for round cap coverage.

Coordinates are X-right/Y-up, with no implicit unit conversion or Y flip. Widths
use the same units and scale with the Three.js object. GPU coordinates are float32;
use coordinates near a local origin and place the group in the larger BIM world
with Three.js transforms. `Float64Array` input is also converted to float32.

The builder copies inputs and computes stroke bounds and a single page rectangle,
including stroke width. Treat the returned scene as immutable while rendering;
changing your original points does not change it. Empty/single-point paths emit
no strokes. Consecutive points equal after float32 conversion are skipped and
reported in `discardedDegenerateCount`; entirely empty geometry has zero pages
and the default bounds `[0, 0, 1, 1]`. Invalid point shapes, nonfinite/out-of-range
coordinates, invalid colors, and invalid widths throw. Scene buffers support at
most 16,777,216 candidate segments; practical limits depend on available memory
and the renderer's GPU texture capacity.

The supported contract is the builder input and rendering workflow. Applications
should not construct or mutate the packed scene metadata themselves. LOD uses
the existing visual approximations at overview scales; use `vectorLod: "off"`
when exact stroke rendering is required.

## `createThreePdfObject(scene, options?)`

Returns `Promise<HeprThreePdfObject>` from a compiled `VectorScene`, including one
returned by `buildStrokeScene`. It skips source loading/parsing, prepares LOD,
and creates the same `THREE.Group` used by `pdfObjectGenerator`. No standalone
viewer UI or custom WebGL lifecycle integration is required.

`CreateThreePdfObjectOptions` accepts the rendering options above, plus
`sourceLabel` (default `"Vector scene"`), `signal`, and `onProgress`. Unlike the
file loader, `rendererType` is an **option**, defaulting to `"webgl"`, and
`pageBackgroundOpacity` defaults to `0`. Set it to `1` for a visible sheet
background. `sourceKind` on the object and `sourceType` in progress events are
`"scene"`. Cancellation and disposal follow the file loader's behavior.

The object lies in its local XY plane and is centered on the page bounds, as
with PDF objects. To retain the input coordinates within a parent BIM/sheet group:

```ts
const b = geometry.pageBounds;
drawing.position.set((b.minX + b.maxX) / 2, (b.minY + b.maxY) / 2, 0);
sheetGroup.add(drawing);
// Rotate, translate, or scale sheetGroup to place the drawing in the 3D world.
```

Your normal `renderer.render(scene, camera)` calls drive culling and LOD. Remove
the group from its parent and call `dispose()` when finished. Geometry edits and
incremental buffer updates are outside this API; build a new scene if needed.

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
| `getLayers()` / `getLayerOrder()` | Read PDF layer records and their display hierarchy. |
| `setLayerVisibility(id, visible)` | Apply one layer change; resolves after resources and visibility commit. |
| `setLayerVisibilities(changes)` | Atomically validate and apply an array of `{ id, visible }` changes. |
| `setAllLayerVisibility(visible, layerIds?)` | Show/hide all editable layers, optionally restricted to IDs, respecting locks and radio groups. |
| `getAllLayerVisibility(layerIds?)` | Read `{ checked, indeterminate, disabled }` for a bulk-toggle control from applied visibility. |
| `resetLayerVisibility()` | Restore the PDF's original visibility defaults. |
| `subscribeLayerVisibility(listener)` | Observe applied visibility snapshots; returns an unsubscribe function. |
| `subscribeLayerVisibilityProgress(listener)` | Observe preparation percentage or `null` when idle; immediately reports current progress and returns an unsubscribe function. |
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
`distancePx`, and an optional `segmentIndex` or mesh `triangleIndex`. The last eligible painted primitive
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
Mesh and function shadings use `"gradient-fill"` references with `shadingKind: "mesh"`,
`triangleCount`, and `getTriangle(index)`, which returns detached positions and vertex colors.
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
Mesh highlights trace exterior triangle edges, preserving holes and disconnected
pieces while removing shared seams. Highlight extraction is bounded to 65,536
triangles per mesh and 8,192 paint-clip edges; an oversized highlight update rejects
atomically, leaving inspection and rendering available.
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

### PDF layers (optional content)

Each PDF object owns its visibility state. Two objects can share a `VectorScene`
and display different layers. `getLayers()` returns detached records containing
`id`, `name`, `defaultVisible`, `visible`, `locked`, and `usedInView`. IDs are
opaque and document-scoped; duplicate names are valid. `getLayerOrder()` exposes
the PDF's group/label hierarchy. The original condition DAG and radio groups
remain available in `sceneData.optionalContent`.

```ts
const layers = pdf.getLayers();
const editable = layers.find(layer => !layer.locked && layer.usedInView);
if (editable) await pdf.setLayerVisibility(editable.id, false);

const unsubscribe = pdf.subscribeLayerVisibility(snapshot => {
  console.log("Applied layer revision", snapshot.revision);
  requestRender();
});

// Hide all editable layers in one batch, using IDs from getLayers().
await pdf.setLayerVisibilities(layers
  .filter(layer => !layer.locked && layer.usedInView)
  .map(layer => ({ id: layer.id, visible: false })));
await pdf.resetLayerVisibility();
// At teardown: unsubscribe();
```

Batches validate before changing anything. Locked groups and groups outside the
View intent cannot be changed. Enabling one member of a radio group disables its
other editable members; a conflicting batch rejects. Rapid changes supersede
pending preparation, which can reject an earlier promise with `AbortError`.
The previous applied state stays on screen until replacement resources are ready.
`subscribeLayerVisibility` reports applied revisions, not pending requests.

`setAllLayerVisibility()` skips locked/non-View layers. Enabling preserves current
radio-group choices, then enables compatible default-on or first eligible members.
`getAllLayerVisibility()` reports checked when all compatible editable layers are
on, mixed when further compatible layers can be enabled, and disabled when there
are no editable targets. The shared panel's **All** checkbox affects every layer,
including those hidden by its name filter.

Both a pick hit and its inspected primitive include
`optionalContent: { conditionId, layerIds }`. `conditionId` addresses the primitive's
draw-run condition (or is `null`); `layerIds` also includes dependencies inherited
through groups and masks. These are visibility dependencies, potentially negated
or involving several layers, rather than an exclusive ownership label. Ungrouped
content has an empty list. Resolve names through `getLayers()`.

Hidden paints cannot be picked. Hidden hover/selection traces are cleared while
temporary colors remain available if the paint reappears. Visibility changes
invalidate stale picks, search results, text-selection layouts, and rendering
caches while preserving canonical references and the picking hierarchy. Library
hosts should refresh their search UI after a visibility notification. OCR/fallback
text uses retained character conditions even when it has no pickable glyph.

For native views, `createLayerVisibilityController({ getScene, getRenderer,
onChange?, onProgress? })` provides the same layer operations and shared fallback
preparation. Call `sceneChanged()` after loading a scene, `rendererChanged()` after
replacing its renderer, and `dispose()` at teardown. Its `onProgress` receives a
percentage or `null`. Separate controllers give separate view states.
`OptionalContentController` is the lower-level model with an optional resource
preparation callback; use the native wrapper when retained raster replay is needed.

`createPdfLayerControls({ container, controller })` mounts the reusable DOM panel
for either a PDF object or native controller. Connect native preparation progress
to its `setProgress()`, call `refresh()` after document replacement, and `dispose()`
at teardown. The panel exposes CSS classes under `.pdf-layers`; the standalone
viewer stylesheet is a styling example. All three demos mount the panel.

For Three.js hosts that replace PDF objects, `createThreePdfLayerControls()` shares
the binding and subscription lifecycle used by the Three.js and room demos:

```ts
const layers = createThreePdfLayerControls({
  container: document.querySelector<HTMLElement>("#pdf-layers")!,
  getPdfObject: () => currentPdfObject,
  requestRender,
  onVisibilityChange: () => {
    // Refresh host search results and text selection for the applied visibility.
  }
});

// After assigning a loaded PDF object (or null), before disposing its predecessor:
layers.objectChanged();

// For a backend replacement built from the same sceneData object:
await layers.prepareReplacement(replacementPdf, abortController.signal);
const previousPdf = currentPdfObject;
currentPdfObject = replacementPdf;
layers.objectChanged();
previousPdf?.dispose();

// At host teardown; PDF objects remain owned by the host:
layers.dispose();
```

The binding forwards preparation progress, requests frames after applied changes,
and ignores callbacks from detached objects. `prepareReplacement()` temporarily
disables panel changes, waits for pending panel operations, and applies the latest
visibility to the replacement before installation. It only transfers between
objects sharing the exact same `sceneData`; new documents use their PDF defaults.
The host remains responsible for its Three.js scene membership and renderer/canvas
lifecycle. Use the shared `pdfLayerControls.css` as the panel styling example.

Layer changes do not modify scene definitions, source geometry, or exports.
HEP stores initially hidden content and the original PDF visibility defaults.
Layer definitions and retained effects add file and memory costs compared with
earlier scenes; ordinary flat pages keep the existing rendering path. Effect
graphs use temporary GPU surfaces at the viewing resolution, subject to memory
budgets. Retained compatibility fallbacks may require asynchronous image replay
on a layer change. These temporary surfaces are never serialized as canonical
geometry. HEP schema v7 is required: regenerate older HEP files from their PDFs.
Replayable raster fallbacks use the retained PDF's original paints when computing
their backdrop correction. Temporary vector recoloring or a global tint does not
recolor that correction; layer-dependent backdrop changes are replayed.

## `buildHep(input, options?)`

Returns `Promise<Blob>` with MIME type `application/x-hep`. Save it with a `.hep`
extension. Import it from `@soadzoor/hepr/bundler` in a bundled browser app,
or `@soadzoor/hepr` in Node.

| Input | Options |
| --- | --- |
| PDF source (`PdfObjectSource`) | `BuildHepFromPdfOptions`: shared encoding options, `pages`, `maxPagesPerRow`, `segmentMerge`, `invisibleCull`, `iccTransformResolver`, `iccEngine`, and `onDiagnostic`. |
| Parsed `VectorScene` | `BuildHepFromSceneOptions`: shared encoding options. |

Shared encoding options are `sourceLabel`, `encodeRasterImages` (default `true`),
`compression` (`"deflate"` by default, or `"store"`), `onProgress`, and `signal`.
Compressed writing requires native `CompressionStream("deflate")`; loading
compressed files requires `DecompressionStream("deflate")`.

Pass an already-loaded `pdf.sceneData` to avoid parsing again. Export preserves
the PDF's original layer defaults, including initially hidden geometry, regardless
of the viewer's current layer settings. V7 retains fallback commands and assets;
it does not embed the original PDF for later image recovery.

Node hosts can install the optional `@napi-rs/canvas` backend for PDF operations
that need Canvas2D, image encoding, and encoded HEP image decoding. See the
[conversion examples](examples.md), [builder types](../src/hepBuilder.ts), and
[HEP format specification](HEP_CONTAINER.md).

### Rendering compatibility and diagnostics

PDF loading and PDF-to-HEP conversion prefer opening a usable document over
rejecting a page because the optimized vector representation cannot express it.
Axial/radial gradients, bounded tessellated shadings, large compound fills,
supported tiling patterns and Type3 programs retain canonical geometry. Groups,
standard blend modes, and alpha/luminosity masks use a shared ordered paint graph
and renderer-owned transient surfaces. Group opacity is applied to the group
result, preserving overlap between its children.

Malformed or unsupported effects and exhausted expansion budgets can still use
diagnosed selective or whole-page image fallbacks. V7 retains the replayable
program and assets beside these fallback slots so layer changes can regenerate
their pixels without the original PDF. Print separations and exact overprint
simulation remain outside scope.

The page image targets 2 pixels per PDF point (144 dpi for ordinary pages), capped
at 16 million pixels and 16,384 pixels per dimension. Parser image and decoded-byte
limits can lower these ceilings. Rasterized pages lose vector sharpness and geometry
needed for features such as room detection. Their extracted text index is retained
separately for search and selection; no text is painted twice. HEP stores the image,
text, and retained replay resources, with no source PDF needed when reopening it.

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
