/** Document-local layer identity; store the document/artifact identity separately. */
export interface OptionalContentGroup {
  readonly id: string;
  readonly name: string;
  readonly defaultVisible: boolean;
  readonly locked: boolean;
  /** False when the PDF's default View configuration does not select this group's intent. */
  readonly usedInView: boolean;
}

/** Acyclic condition graph. Operands address entries in SceneOptionalContent.conditions. */
export type OptionalContentCondition =
  | { readonly kind: "group"; readonly groupId: string }
  | { readonly kind: "and" | "or"; readonly operands: readonly number[] }
  | { readonly kind: "not"; readonly operand: number }
  | { readonly kind: "constant"; readonly value: boolean };

export type OptionalContentOrderNode =
  | { readonly kind: "group"; readonly groupId: string; readonly children?: readonly OptionalContentOrderNode[] }
  | { readonly kind: "label"; readonly label: string; readonly children: readonly OptionalContentOrderNode[] };

export interface SceneOptionalContent {
  readonly groups: readonly OptionalContentGroup[];
  readonly conditions: readonly OptionalContentCondition[];
  readonly order: readonly OptionalContentOrderNode[];
  readonly radioGroups: readonly (readonly string[])[];
}
