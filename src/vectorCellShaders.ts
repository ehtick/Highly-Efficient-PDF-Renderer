/**
 * Coverage through a path's cell index (see vectorCellIndex.ts).
 *
 * The caller defines heprCellFetchA/B(index) over its segment textures, and
 * includes FILL_COVERAGE_GLSL first. `cells` is the path's header: first
 * level texel, level count, finest cell size and the log2 size ratio between
 * levels; `origin` is its grid origin.
 * The finest level whose cells span half the footprint keeps the box within
 * three columns and three rows: smaller cells than the footprint hold fewer
 * pieces the box does not reach, which outweighs reading more of them.
 * Each column's part of the box takes its pieces
 * exactly and everything right of it through the cell's closures; each row
 * integrates only its own rows, as bands do. The parts are weighted by their
 * share of the box, so the result is the whole box's averaged winding.
 */
export const VECTOR_CELL_COVERAGE_GLSL = `
float heprCellWinding(vec4 cells, vec2 origin, vec4 box, vec2 footprint) {
  float reach = 0.5 * max(footprint.x, footprint.y);
  float level = clamp(ceil(log2(max(reach / cells.z, 1.0)) / cells.w), 0.0, cells.y - 1.0);
  float size = cells.z * exp2(level * cells.w);
  if (size < reach && level < cells.y - 1.0) {
    level = level + 1.0;
    size = cells.z * exp2(level * cells.w);
  }
  vec4 grid = heprCellFetchA(int(cells.x + level));
  float right = box.x + footprint.x;
  int firstColumn = int(clamp(floor((box.x - origin.x) / size), 0.0, grid.y - 1.0));
  int lastColumn = int(clamp(floor((right - origin.x) / size), 0.0, grid.y - 1.0));
  int firstRow = int(clamp(floor((box.y - origin.y) / size), 0.0, grid.z - 1.0));
  int lastRow = int(clamp(floor((box.y + footprint.y - origin.y) / size), 0.0, grid.z - 1.0));
  vec4 rowGrid = vec4(0.0, 0.0, origin.y, size);
  float winding = 0.0;
  // Reads run one ahead of their use: the next cell's record and the next
  // piece are requested before this piece's coverage is computed, so their
  // latency overlaps it. A pixel's time is mostly that latency, and a draw
  // lasts as long as its slowest pixels.
  for (int row = firstRow; row <= lastRow; row += 1) {
    vec2 rows = heprBandRows(rowGrid, row, int(grid.z), box);
    int rowBase = int(grid.x + float(row) * grid.y);
    vec4 nextCell = heprCellFetchA(rowBase + firstColumn);
    for (int column = firstColumn; column <= lastColumn; column += 1) {
      vec4 cell = nextCell;
      nextCell = heprCellFetchA(rowBase + min(column + 1, lastColumn));
      // The outer columns reach past the grid: nothing lies beyond them.
      float low = column == 0 ? box.x : max(box.x, origin.x + float(column) * size);
      float high = column == int(grid.y) - 1 ? right : min(right, origin.x + float(column + 1) * size);
      if (high > low) {
        vec4 part = vec4(low, box.y, 1.0 / (high - low), box.w);
        float cellWinding = 0.0;
        int first = int(cell.x);
        int count = int(cell.y);
        vec4 nextA = heprCellFetchA(first);
        vec4 nextB = heprCellFetchB(first);
        for (int piece = 0; piece < count; piece += 1) {
          vec4 a = nextA;
          vec4 b = nextB;
          int following = first + min(piece + 1, count - 1);
          nextA = heprCellFetchA(following);
          nextB = heprCellFetchB(following);
          cellWinding += heprSegmentCoverage(vec2(a.x, a.y), vec2(a.z, a.w), vec2(b.x, b.y), b.z >= 0.5,
            part, rows.x, rows.y);
        }
        int closures = int(cell.z);
        int closureCount = int(cell.w);
        for (int closure = 0; closure < closureCount; closure += 2) {
          vec4 pair = heprCellFetchA(closures + closure);
          vec4 pair2 = heprCellFetchA(closures + min(closure + 1, closureCount - 1));
          float more = closure + 1 < closureCount ? 1.0 : 0.0;
          cellWinding += pair.y * (clamp((pair.x - box.y) * box.w, rows.x, rows.y) - rows.y);
          cellWinding += pair.w * (clamp((pair.z - box.y) * box.w, rows.x, rows.y) - rows.y);
          cellWinding += more * pair2.y * (clamp((pair2.x - box.y) * box.w, rows.x, rows.y) - rows.y);
          cellWinding += more * pair2.w * (clamp((pair2.z - box.y) * box.w, rows.x, rows.y) - rows.y);
        }
        winding += cellWinding * (high - low) / footprint.x;
      }
    }
  }
  return winding;
}
`;
