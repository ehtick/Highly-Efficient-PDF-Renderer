import type { HeprPageData } from "./heprDocumentData";
import { executeHeprDisplayProgram, type HeprExecutionState } from "./heprDisplayExecutor";
import type { OptionalContentCondition, SceneOptionalContent } from "./optionalContentData";
import type { SceneTextIndex } from "./pdfVectorExtractor";

/** Associate fallback search quads with their retained paint scopes, including Type3 text. */
export async function attachRetainedTextOptionalContent(page: HeprPageData, text: SceneTextIndex,
  data: SceneOptionalContent, signal: AbortSignal): Promise<SceneOptionalContent> {
  const conditions: OptionalContentCondition[] = [...data.conditions], keys = new Map<string, number>();
  const glyphConditions = new Int32Array(page.stores.glyphs.glyphIds.length).fill(-1);
  const glyphsByTransform = new Map<number, number[]>();
  page.stores.glyphs.transformIndices.forEach((transform, glyph) => {
    let glyphs = glyphsByTransform.get(transform);
    if (!glyphs) glyphsByTransform.set(transform, glyphs = []);
    glyphs.push(glyph);
  });
  const condition = (state: HeprExecutionState): number => {
    const indices = new Set<number>();
    for (let scope = state.optionalContent; scope; scope = scope.parent) if (scope.index >= 0) indices.add(scope.index);
    const operands = [...indices].sort((a, b) => a - b);
    if (operands.length < 2) return operands[0] ?? -1;
    const key = operands.join(":"); let index = keys.get(key);
    if (index === undefined) { index = conditions.length; conditions.push({ kind: "and", operands }); keys.set(key, index); }
    return index;
  };
  const allContent: HeprPageData = { ...page, stores: { ...page.stores, optionalContent: {
    ...page.stores.optionalContent, defaultVisible: new Uint8Array(page.stores.optionalContent.defaultVisible.length).fill(1)
  } } };
  await executeHeprDisplayProgram(allContent, {
    beginCompositeGroup() {}, endCompositeGroup() {},
    beginProgram(execution) {
      if (execution.program.kind !== "type3") return;
      const index = condition(execution.state);
      for (const glyph of glyphsByTransform.get(execution.invocationCommand.transformIndex) ?? []) glyphConditions[glyph] = index;
    },
    drawRun(execution) {
      const command = execution.command;
      if (command.source !== "glyphs") return;
      const index = condition(execution.state);
      glyphConditions.fill(index, command.first, command.first + command.count);
    }
  }, { signal });
  text.pages[0].optionalContent = Int32Array.from(page.textIndex.charGlyphIndices, glyph => glyph >= 0 ? glyphConditions[glyph] : -1);
  return { ...data, conditions };
}
