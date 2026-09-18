import type { PrimitiveInteractionController } from "./primitiveInteraction";
import type { PrimitiveInfo } from "./scenePrimitives";

interface DrawingSelectionControlsOptions {
  getLayerName?(id: string): string | undefined;
  container: HTMLElement;
  createController(callbacks: {
    onSelectionChange(primitive: PrimitiveInfo | null, displayColor?: [number, number, number] | null): void;
    onPreparationProgress(percentage: number | null): void;
  }): PrimitiveInteractionController;
  onEnabledChange?(enabled: boolean): void;
}

/** Shared demo controls; picking and gesture handling live in the library controller. */
export function createDrawingSelectionControls(options: DrawingSelectionControlsOptions): PrimitiveInteractionController {
  const { container } = options;
  container.innerHTML = `
    <label class="drawing-selection-toggle" for="drawing-selection-checkbox">
      Drawing Selection
      <input id="drawing-selection-checkbox" type="checkbox" autocomplete="off" aria-controls="drawing-selection-controls" />
    </label>
    <div id="drawing-selection-controls" class="drawing-selection-controls" hidden>
      <div id="drawing-selection-loading" class="drawing-selection-loading" hidden>
        <span id="drawing-selection-loading-label" role="status">Preparing drawing selection… 0%</span>
        <progress id="drawing-selection-progress" max="100" value="0" aria-labelledby="drawing-selection-loading-label"></progress>
      </div>
      <div id="drawing-selection-info" role="status">Hover or click a drawing element.</div>
      <div class="drawing-selection-actions">
        <label for="drawing-selection-color">Selected color</label>
        <input id="drawing-selection-color" type="color" value="#ff0000" disabled />
        <button id="drawing-selection-reset" type="button" disabled>Reset selected</button>
        <button id="drawing-selection-reset-all" type="button">Reset all colors</button>
      </div>
    </div>`;
  const element = <T extends HTMLElement>(id: string): T => container.querySelector<T>(`#drawing-selection-${id}`)!;
  const checkbox = element<HTMLInputElement>("checkbox");
  const controls = element<HTMLDivElement>("controls");
  const loading = element<HTMLDivElement>("loading");
  const loadingLabel = element<HTMLSpanElement>("loading-label");
  const progress = element<HTMLProgressElement>("progress");
  const info = element<HTMLDivElement>("info");
  const colorInput = element<HTMLInputElement>("color");
  const reset = element<HTMLButtonElement>("reset");
  const resetAll = element<HTMLButtonElement>("reset-all");
  let disposed = false;
  // Do not restore this mode with the browser's saved form state.
  checkbox.checked = false;

  const controller = options.createController({
    onPreparationProgress: percentage => {
      if (disposed) return;
      const preparing = percentage !== null && percentage < 100;
      loading.hidden = !preparing;
      info.hidden = preparing;
      progress.value = percentage ?? 0;
      loadingLabel.textContent = `Preparing drawing selection… ${percentage ?? 0}%`;
      controls.setAttribute("aria-busy", String(preparing));
    },
    onSelectionChange: (primitive, displayColor) => {
      if (disposed) return;
      const recolorable = primitive !== null && primitive.kind !== "raster";
      colorInput.disabled = reset.disabled = !recolorable;
      if (!primitive) {
        info.textContent = "Hover or click a drawing element.";
        return;
      }
      const page = primitive.pageIndex === null ? "" : ` · Page ${primitive.pageIndex + 1}`;
      const bounds = primitive.bounds;
      info.textContent = `${primitive.kind} ${primitive.index}${page} · ${primitive.segmentCount} segments · ` +
        `(${bounds.minX.toFixed(2)}, ${bounds.minY.toFixed(2)})–(${bounds.maxX.toFixed(2)}, ${bounds.maxY.toFixed(2)})`;
      const layers = primitive.optionalContent?.layerIds;
      if (layers?.length) info.textContent += ` · Layers: ${layers.map(id => {
        const name = options.getLayerName?.(id);
        return name ? `${name} (${id})` : id;
      }).join(", ")}`;
      const color = displayColor ?? primitive.color ?? [1, 0, 0];
      colorInput.value = "#" + color.map(channel =>
        Math.round(Math.max(0, Math.min(1, channel)) * 255).toString(16).padStart(2, "0")).join("");
    }
  });

  function setEnabled(enabled: boolean): void {
    if (disposed) return;
    checkbox.checked = enabled;
    controls.hidden = !enabled;
    if (enabled === controller.isEnabled()) return;
    if (enabled) {
      options.onEnabledChange?.(true);
      controller.enable();
    } else {
      controller.disable();
      options.onEnabledChange?.(false);
    }
  }
  const change = (): void => setEnabled(checkbox.checked);
  const changeColor = (): void => controller.setSelectedColor(colorInput.value);
  const resetColor = (): void => controller.resetSelectedColor();
  const resetColors = (): void => controller.resetAllColors();
  checkbox.addEventListener("change", change);
  colorInput.addEventListener("input", changeColor);
  reset.addEventListener("click", resetColor);
  resetAll.addEventListener("click", resetColors);

  return {
    ...controller,
    enable: () => setEnabled(true),
    disable: () => setEnabled(false),
    dispose(): void {
      if (disposed) return;
      setEnabled(false);
      controller.dispose();
      disposed = true;
      checkbox.removeEventListener("change", change);
      colorInput.removeEventListener("input", changeColor);
      reset.removeEventListener("click", resetColor);
      resetAll.removeEventListener("click", resetColors);
      container.replaceChildren();
    }
  };
}
