import type { PageTextIndex, VectorScene } from "./pdfVectorExtractor";
import { createDefaultOptionalContentSnapshot, type OptionalContentSnapshot } from "./optionalContent";
import { getPrimitiveOptionalContentCondition, isScenePrimitiveVisible } from "./scenePrimitives";

const defaults = new WeakMap<VectorScene, OptionalContentSnapshot>();

/** Shared by search, selection, and hosts that consume the canonical text index. */
export function isSceneTextCharVisible(
  scene: VectorScene, page: PageTextIndex, charIndex: number, visibility?: OptionalContentSnapshot | null
): boolean {
  if (!scene.optionalContent && !scene.paintGraph) return true;
  if (!visibility && scene.optionalContent) {
    visibility = defaults.get(scene);
    if (!visibility) defaults.set(scene, visibility = createDefaultOptionalContentSnapshot(scene));
  }
  const conditionVisible = (condition?: number): boolean => condition === undefined || condition < 0 || !visibility || visibility.conditions[condition] === 1;
  const instance = page.charInstance[charIndex];
  if (scene.paintGraph && instance >= 0 && !isScenePrimitiveVisible(scene, { kind: "text", index: instance }, conditionVisible)) return false;
  let condition = page.optionalContent?.[charIndex];
  if (condition === undefined) {
    condition = instance >= 0 ? getPrimitiveOptionalContentCondition(scene, { kind: "text", index: instance }) : undefined;
  }
  return conditionVisible(condition);
}
