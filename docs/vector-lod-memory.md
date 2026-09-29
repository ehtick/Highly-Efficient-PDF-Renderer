# Lossless vector LOD memory changes

Measured on 2026-09-29 using the existing Lower Level and Level 1 HEP examples.
The baseline is the repository implementation before these changes, including
its original nine-level hierarchy. The earlier level-skipping mitigation is
replaced: tolerances, geometry precision, and LOD selection rules are unchanged.

## What changed

- Build geometry and paint IDs in fixed-size typed chunks instead of repeatedly
  doubling large arrays and retaining JavaScript number arrays.
- Store interval-group membership as compact source IDs. Reconstruct one group
  at a time, preserving floating-point accumulation order. Complete and release
  consecutive paint groups while preserving the original density admission cap.
- Share derived geometry with the combined renderer store. Keep caller-owned
  canonical arrays unchanged.
- Allocate selection and instance scratch as needed. Replace native comparison
  sorting with exact stable counting by paint run, source origin, and ID.
- Share exact and ordered LOD GPU textures in native renderers. Upload source
  views of at most 4 MiB without full-size padded staging arrays. Retain exact
  identity buffers where compositing needs canonical fallback draws.
- Let Three data textures share immutable combined arrays. Clone only the style
  texture on the first individual-stroke color edit, and omit unused LOD culling
  arrays.

## Measurements

Separate Node processes load existing HEP files, build all levels, prepare
ordered batches, and select the first overview frame. Peak RSS is recorded before
parity fingerprinting. These figures exclude GPU allocations and browser/driver
overhead; they are comparative process measurements, not iPhone tab estimates.

| Drawing: peak RSS through ordered preparation | Original | Optimized | Reduction |
| --- | ---: | ---: | ---: |
| Lower Level | 1,241.4 MiB | 894.9 MiB | 27.9% |
| Level 1 | 1,884.2 MiB | 1,157.9 MiB | 38.5% |

| Level 1 measurement | Original | Optimized |
| --- | ---: | ---: |
| Peak RSS through LOD construction | 1,398.7 MiB | 852.3 MiB |
| Reachable typed-array backing storage after overview selection | 1,137.0 MiB | 754.6 MiB |
| LOD construction time | 11.02 s | 9.18 s |
| Ordered-batch construction time | 2.41 s | 1.15 s |

Reachable storage counts unique buffers reachable through the scene, runtime,
and batch planner; it excludes hidden WeakMap metadata and ordinary JS objects.
Timing and RSS vary with garbage collection and machine load.

For Level 1, native allocation accounting additionally removes 156.64 MiB of
duplicate GPU textures plus 9.79 MiB of WebGL identity-buffer storage
(19.57 MiB for WebGPU). The previous four-array WebGL upload also allocated
345.73 MiB of simultaneous CPU staging. These are distinct allocation savings,
not figures to add mechanically to the process peaks. Three's shared textures
alone eliminate another 345.73 MiB of retained CPU texture copies.

## Verification

- Both example files preserve all nine original levels. Comparisons cover every
  Float32 geometry/style bit, source paint origin, duplicate multiplicity,
  runtime bound, spatial bucket, and eight successive zoom/pan selections.
- Exact final ordered draw geometry, clip codes, and batch order match.
- TypeScript checking and 27 distinct server-free regression files passed,
  including clipping, density, perspective, ordering, color restoration,
  compositing, buffer growth, cancellation, and shared-resource disposal.
- A separate synthetic comparison checked compact interval accumulation against
  the original implementation across 30,003 varied strokes, multiple tolerances,
  fine/overview modes, and page reuse.
- Browser/device verification remains manual. The older Three instance-buffer
  test was stopped after detecting its Vite dependency and is unverified.

To profile an existing HEP without conversion or a server:

```sh
node scripts/benchmark-vector-lod-memory.mjs public/examples/heps/Level_1-parsed-data.hep --ordered --output=/tmp/lod-memory.json
```

Use `--compare=previous-snapshot.json` to compare output. The tool's default
deadline is 90 seconds. `--source=original-core.ts` and
`--ordered-source=original-batches.ts` allow an original implementation to be
loaded without modifying git state.

On the iPhone, load Lower Level and Level 1 with Vector LOD enabled, check
overview and close zoom, pan across dense regions, switch LOD off/on, recolor
and restore a stroke if supported, and reopen the documents several times.
Confirm that loading finishes and the page remains stable. No Safari crash fix
is claimed until this device check passes.

## Changed files

- Core: `src/vectorStrokeLodCore.ts`, `src/vectorStrokeIntervalGroups.ts`,
  `src/vectorStrokePaintOrder.ts`.
- Storage and ordering: `src/vectorStrokeLodStorage.ts`,
  `src/vectorOrderedBatches.ts`.
- Renderers: `src/vectorStrokeLod.ts`, `src/threeMaterialStrokeLayer.ts`,
  `src/webGlFloorplanRenderer.ts`, `src/webGpuFloorplanRenderer.ts`.
- Tests and tooling: `scripts/test-vector-lod-memory.mjs`,
  `scripts/test-vector-lod-storage.mjs`,
  `scripts/test-native-stroke-upload-memory.mjs`,
  `scripts/test-vector-ordered-batches.mjs`, `scripts/lib/testSuites.mjs`,
  `scripts/benchmark-vector-lod-memory.mjs`.
- Documentation: `docs/manual.md`, `docs/vector-lod-memory.md`.

Suggested commit: `Reduce vector LOD memory without changing rendered output`.
