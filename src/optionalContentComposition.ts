import type { OptionalContentCondition, OptionalContentGroup, OptionalContentOrderNode, SceneOptionalContent } from "./optionalContentData";

/** Compose pages of one document while keeping catalog identities and remapping local conditions. */
export function composeOptionalContent(pages: readonly (SceneOptionalContent | undefined)[]): {
  data: SceneOptionalContent | undefined;
  offsets: number[];
} {
  const groups = new Map<string, OptionalContentGroup>();
  const conditions: OptionalContentCondition[] = [];
  const offsets: number[] = [];
  const order: OptionalContentOrderNode[] = [];
  const orderGroups = new Set<string>();
  const radioGroups = new Map<string, readonly string[]>();
  const collect = (nodes: readonly OptionalContentOrderNode[]): void => {
    for (const node of nodes) {
      if (node.kind === "group") orderGroups.add(node.groupId);
      if (node.children) collect(node.children);
    }
  };
  for (const page of pages) {
    const offset = conditions.length;
    offsets.push(offset);
    if (!page) continue;
    for (const group of page.groups) if (!groups.has(group.id)) groups.set(group.id, group);
    for (const condition of page.conditions) {
      conditions.push(condition.kind === "and" || condition.kind === "or"
        ? { kind: condition.kind, operands: condition.operands.map(index => index + offset) }
        : condition.kind === "not" ? { kind: "not", operand: condition.operand + offset } : { ...condition });
    }
    if (!order.length) { order.push(...page.order); collect(page.order); }
    for (const radio of page.radioGroups) radioGroups.set(JSON.stringify(radio), [...radio]);
  }
  for (const group of groups.values()) if (!orderGroups.has(group.id)) order.push({ kind: "group", groupId: group.id });
  return { data: groups.size ? { groups: [...groups.values()], conditions, order, radioGroups: [...radioGroups.values()] } : undefined, offsets };
}
