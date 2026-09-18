import type { LayerVisibilityController } from "./layerVisibility";
import type { OptionalContentOrderNode } from "./optionalContentData";

export interface PdfLayerControlsOptions {
  container: HTMLElement;
  controller: Pick<LayerVisibilityController, "getLayers" | "getLayerOrder" | "setLayerVisibility" |
    "getAllLayerVisibility" | "setAllLayerVisibility" | "resetLayerVisibility" | "subscribeLayerVisibility">;
}

/** Reusable controls; parsing, constraints, and visibility state live in the library controller. */
export function createPdfLayerControls({ container, controller }: PdfLayerControlsOptions) {
  const document = container.ownerDocument;
  container.innerHTML = `<details class="pdf-layers"><summary>PDF Layers</summary>
    <fieldset>
    <label class="pdf-layers-all" title="Show or hide all available layers, including filtered-out layers. Locked layers stay unchanged; mutually exclusive layers keep their current choice."><input type="checkbox" />All</label>
    <label class="pdf-layers-filter">Filter layers<input type="search" placeholder="Layer name" aria-label="Filter PDF layers" /></label>
    <div class="pdf-layers-list"></div>
    <button type="button">Reset to PDF defaults</button>
    </fieldset>
    <div class="pdf-layers-status" role="status" aria-live="polite"></div>
    <progress max="100" hidden aria-label="Preparing PDF layers"></progress></details>`;
  const all = container.querySelector<HTMLInputElement>(".pdf-layers-all input")!;
  const fieldset = container.querySelector<HTMLFieldSetElement>("fieldset")!;
  const filter = container.querySelector<HTMLInputElement>('input[type="search"]')!;
  const list = container.querySelector<HTMLDivElement>(".pdf-layers-list")!;
  const reset = container.querySelector<HTMLButtonElement>("button")!;
  const status = container.querySelector<HTMLDivElement>(".pdf-layers-status")!;
  const progress = container.querySelector<HTMLProgressElement>("progress")!;
  let disposed = false;
  let generation = 0;
  let operations = 0;

  async function change(operation: () => Promise<void>): Promise<void> {
    const token = generation;
    operations++;
    status.textContent = "Applying layer visibility…";
    try {
      await operation();
      if (!disposed && token === generation) status.textContent = "";
    } catch (error) {
      if (!disposed && token === generation && !(error instanceof DOMException && error.name === "AbortError")) {
        status.textContent = `Layer change failed: ${error instanceof Error ? error.message : String(error)}. Try again or reset to PDF defaults.`;
      }
    } finally {
      if (!disposed && token === generation) { operations--; render(); }
    }
  }

  function render(): void {
    if (disposed) return;
    const layers = controller.getLayers();
    const summary = controller.getAllLayerVisibility();
    all.checked = summary.checked;
    all.indeterminate = summary.indeterminate;
    all.disabled = summary.disabled;
    const byId = new Map(layers.map(layer => [layer.id, layer]));
    const seen = new Set<string>();
    const needle = filter.value.trim().toLocaleLowerCase();
    list.replaceChildren();
    reset.disabled = layers.length === 0;
    filter.disabled = layers.length === 0;
    if (!layers.length) {
      list.textContent = "This PDF has no optional-content layers.";
      return;
    }
    const nodes = (order: readonly OptionalContentOrderNode[], parent: HTMLElement): void => {
      for (const node of order) {
        const branch = document.createElement("div");
        branch.className = "pdf-layer-branch";
        if (node.kind === "group") {
          const layer = byId.get(node.groupId);
          if (!layer) continue;
          seen.add(layer.id);
          if (layer.name.toLocaleLowerCase().includes(needle)) {
            const label = document.createElement("label");
            label.title = `${layer.name}\n${layer.id}${layer.locked ? "\nLocked by the PDF" : ""}`;
            const checkbox = document.createElement("input");
            checkbox.type = "checkbox";
            checkbox.checked = layer.visible;
            checkbox.disabled = layer.locked || !layer.usedInView;
            checkbox.addEventListener("change", () => { void change(() => controller.setLayerVisibility(layer.id, checkbox.checked)); });
            const name = document.createElement("span");
            name.textContent = layer.name || "Unnamed layer";
            label.append(checkbox, name);
            branch.append(label);
          }
        } else if (!needle || node.label.toLocaleLowerCase().includes(needle)) {
          const heading = document.createElement("div");
          heading.textContent = node.label;
          heading.className = "pdf-layer-label";
          branch.append(heading);
        }
        if (node.children?.length) {
          const children = document.createElement("div");
          children.className = "pdf-layer-children";
          nodes(node.children, children);
          if (children.childNodes.length) branch.append(children);
        }
        if (branch.childNodes.length) parent.append(branch);
      }
    };
    nodes(controller.getLayerOrder(), list);
    nodes(layers.filter(layer => !seen.has(layer.id)).map(layer => ({ kind: "group", groupId: layer.id })), list);
    if (!list.childNodes.length) list.textContent = layers.length ? "No matching layers." : "This PDF has no optional-content layers.";
  }
  const toggleAll = (): void => { void change(() => controller.setAllLayerVisibility(all.checked)); };
  const resetDefaults = (): void => { void change(() => controller.resetLayerVisibility()); };
  all.addEventListener("change", toggleAll);
  filter.addEventListener("input", render);
  reset.addEventListener("click", resetDefaults);
  const unsubscribe = controller.subscribeLayerVisibility(render);
  render();
  return {
    refresh({ resetFilter = true } = {}): void {
      if (disposed) return;
      generation++;
      operations = 0;
      if (resetFilter) filter.value = "";
      status.textContent = "";
      progress.hidden = true; progress.value = 0;
      render();
    },
    setEnabled(enabled: boolean): void { if (!disposed) fieldset.disabled = !enabled; },
    setProgress(percentage: number | null): void {
      if (disposed) return;
      progress.hidden = percentage === null;
      progress.value = percentage ?? 0;
      if (percentage !== null) status.textContent = `Preparing PDF layers… ${Math.round(percentage)}%`;
      else if (!operations) status.textContent = "";
    },
    dispose(): void {
      disposed = true; generation++; unsubscribe();
      all.removeEventListener("change", toggleAll);
      filter.removeEventListener("input", render);
      reset.removeEventListener("click", resetDefaults);
      container.replaceChildren();
    }
  };
}
