# Development

[Project home](../README.md) · [Documentation](README.md) · [Examples](examples.md)

## Local setup

Use Node.js 24 or newer and install dependencies from the repository root:

```bash
npm install
```

The repository includes `@napi-rs/canvas` as a development dependency for Node
conversion and raster tests. Browser package consumers do not need it.

Start the development server when you want to run the demos locally:

```bash
npm run dev
```

Open the URL printed by Vite. The demo entry points are:

| Path | Demo |
| --- | --- |
| `/` | Standalone WebGL/WebGPU viewer. |
| `/three-example.html` | Three.js integration with camera controls. |
| `/room-overlay-demo.html` | Floorplan room detection and TSV overlays. |

## Builds and checks

| Command | Purpose |
| --- | --- |
| `npm test` | Type check and bounded fast regression suite. |
| `npm run typecheck` | TypeScript checks only. |
| `npm run test:file -- scripts/test-text-search.mjs` | Run one regression file. |
| `npm run build` | Build the demo app. |
| `npm run build:lib` | Build the package and run package checks. |
| `npm run build:all` | Build the app and package. |
| `npm run pack:local` | Build the package and create an installable tarball. |
| `npm run preview` | Serve the built app for manual review. |

See [Development validation](development-validation.md) for suite selection,
timeouts, CI coverage, and manual browser checks. Corpus tests, conversion runs,
and visual comparisons are separate from the default fast checks and can be
expensive. Select those checks deliberately for the change you are making.

For rendering changes, manually check both demos and backends with representative
PDFs. Exercise pan/zoom, text search and selection, document switching, and HEP
export/reload. The [visual regression guide](visual-regressions.md) lists specific
appearance checkpoints.

## Example assets

The demos read paired PDF and HEP entries from these locations:

```text
public/examples/pdfs/          Source documents
public/examples/heps/          Prepared HEP documents
public/examples/manifest.json  Demo menu entries and file sizes
```

After adding or updating matching assets, refresh the manifest:

```bash
npm run generate-manifest
```

This command indexes existing files; it does not convert PDFs. For conversion,
follow the [manual](manual.md#node-conversion). A full example refresh with
`npm run regenerate:heps` converts all bundled PDFs and updates the manifest;
allow time and memory for large documents before starting it.

## Room detection tools

The room overlay demo runs detection on demand. **Download Generated TSV** saves
the detected room polygons and labels for inspection. The
[room detection example](examples.md#detect-rooms-in-a-vector-floorplan) shows the public API.

For focused geometry checks:

```bash
npm run test:file -- scripts/test-room-detector.mjs
```

`scripts/eval-rooms.mjs --from-pdf` evaluates the live PDF text extraction path;
`--score` also scores predictions against the available annotations. Those labels
are incomplete, so unmatched predictions need review. Audit saved predictions
for invalid polygons, duplicates, containment, and overlap with:

```bash
npm run audit:rooms -- .eval/my-room-run
```

Use the [gold-set review protocol](room-gold-set.md) to create and validate a
reviewed evaluation set. See [detector quality](room-detector-quality.md) for
recorded results and limits.

## Performance and fidelity

The [parser benchmark guide](parser-benchmark.md) describes production parser
measurements and their scope. The optional [oracle harness](../oracle/README.md)
has a separate dependency installation for rendering comparisons. Run corpus
benchmarks and baseline generation manually; the default tests do not establish
full-corpus visual fidelity or browser performance.

For temporary runtime diagnostics in the main viewer, add `heprProfile=1` to
the URL query, reload, and reopen the PDF. While panning or zooming, the console
prints `[HEPR profile scene]` once per scene and `[HEPR profile frame]` about
every two seconds. Compare the whole-document overview, one page, and a small
detail in both WebGL and WebGPU.

The scene record contains counts only. Frame records include median/p95 CPU
submission time, active frame intervals (idle gaps above 500 ms are excluded),
visible source paint runs and actual batched draw requests. GPU timings are sampled asynchronously
when supported: WebGL uses disjoint timer queries, while WebGPU measures the
direct scene pass, including highlights. Cached/minified WebGPU passes are not
timed. `gpuSamples: 0` or `gpuMs: null` means no GPU measurement is available;
it does not mean zero GPU cost. No synchronous GPU waits are used.

High CPU time points toward submission or driver overhead. High GPU time with
low CPU time points toward shader/fragment work. Adjacent strokes, fills, or text
share instanced draws even when their clip roots differ. Spatially independent
pages also share draws: their paint streams are interleaved by type while keeping
the order of overlapping paints. Actual content bounds determine those
groups, including all stroke LOD levels, vector clips, and screen-space AA;
page rectangles alone do not establish independence. A bounded look-ahead pass
also combines paints within a page when they can move across every intervening
paint without overlap. Unknown bounds remain ordering barriers. The search has
both a short window and a comparison budget to bound CPU work during rebuilds.
Arbitrary WebGL local-to-clip projections keep the original global order.
The draw list is reused until visibility, LOD, or the AA scale bucket changes.
Stroke paint ranks are computed at scene setup. When selection changes, a
hierarchical bitmask filters that static order without comparison sorting.
Unchanged selected IDs reuse their ordered instance list.
For an orthographic overview containing every LOD's geometry and every paint
bound, panning reuses both the LOD selection and the source paint list. A changed
LOD budget, partial visibility, or explicit reset resumes selection work;
arbitrary local-to-clip projections keep their existing update path.
Native WebGL/WebGPU ordered scenes use the existing soft 50,000-stroke LOD target;
merging stays within each source paint, clip, and consecutive opaque color.
Exact tile geometry returns when it fits the budget. The Draw counter reports
selected strokes, while `orderedDrawRequests` reports submitted GPU draws.

`cpuPhasesMs` separates stroke LOD selection, ordered-run culling, batch planning,
instance-buffer uploads, and ordered draw submission. `other` contains the rest
of the renderer frame, including the legacy draw paths and callbacks. Each phase
reports median/p95 across all sampled frames; a cached or unexecuted phase counts
as zero. These CPU phases do not measure GPU execution. WebGL GPU queries span
the frame's GPU commands and may include gaps while the CPU feeds those commands;
WebGPU timestamps span the direct render pass.

`orderedDrawsByKind` reports the last frame's draws and instances separately for
strokes, fills, text, images, and gradients. `workPerFrame` reports mean/max batch
rebuilds, uploaded instance bytes, and WebGL texture bindings issued or avoided.
This distinguishes a high primitive count from repeated CPU setup work. Texture
binding counts cover the ordinary stroke/fill/text routines.

For a temporary comparison in an ordered scene, capture 5–10 seconds of panning
with everything visible, then enter `window.__HEPR_PROFILE_SKIP__ = "text"` in the
console and pan again. This intentionally hides text during profiled frames;
it leaves LOD and batch preparation intact, isolating text submission/rendering
cost. Use `"fill"` for a second comparison if needed. Other accepted kinds are
`"stroke"`, `"raster"`, `"gradient-fill"`, and `"gradient-stroke"`. Restore normal
drawing with `delete window.__HEPR_PROFILE_SKIP__` and move the camera to redraw.
The frame log labels the omitted kind in `skippedKinds`; `skipSupported` is false
on legacy scenes. Changing the diagnostic mode starts a fresh timing window and
discards pending GPU results from the previous mode. The switch has no effect
when profiling is disabled. Only aggregated numbers are logged, never per draw.

Disable logging immediately with `window.__HEPR_PROFILE__ = false`, or remove
the query parameter and reload. Setting `window.__HEPR_PROFILE__ = true` enables
CPU/WebGL diagnostics without reloading; WebGPU timestamp support must be
requested at renderer creation, so use the URL option for that backend.
Logs omit document names, text, geometry coordinates and image data.
