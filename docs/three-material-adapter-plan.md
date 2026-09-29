# Three Material Adapter Rewrite Plan

Goal: render HEPR pages as true Three.js objects using Three materials/shaders, while preserving core visual output and performance characteristics.

## Constraints
- Reuse core shader logic and data encoding where possible.
- Keep page nodes transformable (`position/rotation/scale`) like regular Three objects.
  Implemented through `getPage` / `getPages` on `HeprThreePdfObject`, with
  position/rotation/quaternion/scale and affine matrix setters. Independent page
  views keep every paint type and interaction on the same page transform and
  use a shared GPU page-matrix table for compatible page batches on both
  Three.js backends. Content, clips, LOD, picking and overlap scheduling follow
  the same transforms. Instanced backgrounds supply opaque depth separation;
  unsafe overlaps, effects and per-page appearance changes automatically use
  independent submissions. The default document retains its existing path.
- Avoid HTML-canvas texture bridging for the WebGL path.
- Maintain feature parity: strokes, fills, text, raster layers, culling, and vector LOD.

## Milestones
1. Extract shared GPU contracts from core WebGL renderer:
   - shader sources
   - packed data texture layouts
   - camera/AA uniforms
2. Build `ThreeMaterialPageRenderer` with layered sub-meshes:
   - stroke mesh (instanced quad + data textures)
   - fill mesh
   - text mesh
   - raster layer mesh
3. Port culling and visibility update logic into a renderer-agnostic module.
4. Render from the live camera throughout panning and zooming, with shared vector LOD and no pan-image cache.
5. Add benchmark harness against native WebGL/WebGPU outputs and frame times.
6. Make material adapter the default Three path once parity thresholds are met.

## Success Criteria
- Visual delta below agreed threshold vs native reference scenes.
- No background/content temporal mismatch.
- Similar interaction FPS on large PDFs (same machine/config).
- No additional API burden for Three users.

