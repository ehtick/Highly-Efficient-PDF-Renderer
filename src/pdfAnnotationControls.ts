import type { SceneAnnotation } from "./annotationData";
import type { AnnotationLayerVisibility } from "./optionalContent";
import type { VectorScene } from "./pdfVectorExtractor";

export interface PdfAnnotationControlsController {
  /** The document whose annotations are listed; a different scene resets the panel. */
  getScene(): VectorScene | null;
  /** Annotations with a compiled appearance layer, and whether it is applied as shown. */
  getAnnotationLayers(): readonly AnnotationLayerVisibility[];
  setAnnotationVisibility(annotationIds: readonly string[], visible: boolean): Promise<void>;
}

export interface PdfAnnotationControlsOptions {
  container: HTMLElement;
  controller: PdfAnnotationControlsController;
  /** After annotations are turned on or off, for example to refresh the annotation overlay. */
  onChange?(): void;
}

interface Entry { annotation: SceneAnnotation; text: string; title: string; search: string }

/** Longer lists stay responsive; the filter reaches the rest. */
const MAX_ROWS = 500;

/** Invisible, Hidden and NoView annotations never show, and popups belong to their parent. */
function listed(annotation: SceneAnnotation): boolean {
  return annotation.subtype !== "Popup" && (annotation.flags & (1 | 2 | 32)) === 0;
}

function describe(annotation: SceneAnnotation): Entry {
  const heading = `${annotation.subtype} · p. ${annotation.sourcePageIndex + 1}`;
  const target = annotation.destination ?? annotation.action?.destination;
  const detail = (annotation.contents || annotation.tooltip || annotation.subject || annotation.field?.name ||
    annotation.action?.uri || target?.name ||
    (target?.sourcePageIndex === undefined ? undefined : `Go to page ${target.sourcePageIndex + 1}`) || annotation.name)
    ?.replace(/\s+/g, " ").trim();
  const text = detail ? `${heading} — ${detail.length > 60 ? `${detail.slice(0, 59)}…` : detail}` : heading;
  const title = [heading, annotation.author, detail, annotation.id].filter(Boolean).join("\n");
  return { annotation, text, title, search: title.toLocaleLowerCase() };
}

/**
 * Reusable Annotations panel. Turning an annotation off hides its drawn
 * appearance through the controller; pass `isAnnotationEnabled` to the
 * annotation overlay adapter so its bubble or link stops responding too.
 */
export function createPdfAnnotationControls({ container, controller, onChange }: PdfAnnotationControlsOptions) {
  const document = container.ownerDocument;
  container.innerHTML = `<details class="pdf-annotations"><summary>Annotations</summary>
    <label class="pdf-annotations-all"><input type="checkbox" /><span>All</span></label>
    <label class="pdf-annotations-filter">Filter annotations<input type="search" placeholder="Type, page, text or author" aria-label="Filter annotations" /></label>
    <div class="pdf-annotations-list"></div>
    <div class="pdf-annotations-status" role="status" aria-live="polite"></div></details>`;
  const allLabel = container.querySelector<HTMLLabelElement>(".pdf-annotations-all")!;
  const all = container.querySelector<HTMLInputElement>(".pdf-annotations-all input")!;
  const allText = container.querySelector<HTMLSpanElement>(".pdf-annotations-all span")!;
  const filterLabel = container.querySelector<HTMLLabelElement>(".pdf-annotations-filter")!;
  const filter = container.querySelector<HTMLInputElement>(".pdf-annotations-filter input")!;
  const list = container.querySelector<HTMLDivElement>(".pdf-annotations-list")!;
  const status = container.querySelector<HTMLDivElement>(".pdf-annotations-status")!;
  const checkboxes = new Map<string, HTMLInputElement>();
  let scene: VectorScene | null = null;
  let entries: Entry[] = [];
  let matching: Entry[] = [];
  let hidden = new Set<string>();
  let disposed = false;
  let generation = 0;
  let operations = 0;

  /** Update check states in place, so a toggled row keeps keyboard focus. */
  function sync(): void {
    const off = matching.filter(entry => hidden.has(entry.annotation.id)).length;
    all.checked = matching.length > 0 && off === 0;
    all.indeterminate = off > 0 && off < matching.length;
    for (const [id, checkbox] of checkboxes) checkbox.checked = !hidden.has(id);
  }

  async function request(ids: readonly string[], visible: boolean): Promise<void> {
    const layered = new Set(controller.getAnnotationLayers().map(layer => layer.annotationId));
    const appearances = ids.filter(id => layered.has(id));
    // Links and annotations without a drawn appearance change only in the overlay.
    if (!appearances.length) return;
    const token = generation;
    operations++;
    status.textContent = "Applying annotation visibility…";
    let failure: unknown, failed = false;
    try {
      await controller.setAnnotationVisibility(appearances, visible);
    } catch (error) {
      failed = !(error instanceof DOMException && error.name === "AbortError");
      failure = error;
    }
    if (disposed || token !== generation) return;
    operations--;
    if (!failed) {
      if (!operations) status.textContent = "";
      return;
    }
    // Show the applied appearance state rather than the failed request.
    const applied = new Map(controller.getAnnotationLayers().map(layer => [layer.annotationId, layer.visible]));
    for (const id of appearances) {
      if (applied.get(id)) hidden.delete(id);
      else hidden.add(id);
    }
    sync();
    status.textContent = `Annotation change failed: ${failure instanceof Error ? failure.message : String(failure)}. Try again.`;
    onChange?.();
  }

  function apply(ids: readonly string[], visible: boolean): void {
    for (const id of ids) {
      if (visible) hidden.delete(id);
      else hidden.add(id);
    }
    sync();
    // Bubbles and links follow at once; drawn appearances once the renderer applies them.
    void request(ids, visible);
    onChange?.();
  }

  function render(): void {
    if (disposed) return;
    const needle = filter.value.trim().toLocaleLowerCase();
    matching = needle ? entries.filter(entry => entry.search.includes(needle)) : entries;
    allLabel.hidden = filterLabel.hidden = entries.length === 0;
    allText.textContent = needle ? "All matching" : "All";
    allLabel.title = needle
      ? "Turn every annotation that matches the filter on or off, including ones beyond the list limit."
      : "Turn every annotation on or off, including ones beyond the list limit.";
    checkboxes.clear();
    list.replaceChildren();
    for (const entry of matching.slice(0, MAX_ROWS)) {
      const { annotation } = entry;
      const row = document.createElement("div");
      row.className = "pdf-annotation-row";
      const label = document.createElement("label");
      label.title = entry.title;
      const checkbox = document.createElement("input");
      checkbox.type = "checkbox";
      checkbox.addEventListener("change", () => apply([annotation.id], checkbox.checked));
      checkboxes.set(annotation.id, checkbox);
      const name = document.createElement("span");
      name.textContent = entry.text;
      label.append(checkbox, name);
      row.append(label);
      list.append(row);
    }
    if (!entries.length) list.textContent = "This document has no annotations.";
    else if (!matching.length) list.textContent = "No matching annotations.";
    else if (matching.length > MAX_ROWS) {
      const more = document.createElement("div");
      more.className = "pdf-annotations-more";
      more.textContent = `Showing ${MAX_ROWS} of ${matching.length}. Refine the filter to see the rest.`;
      list.append(more);
    }
    sync();
  }

  function sceneChanged(): void {
    if (disposed) return;
    const next = controller.getScene();
    if (next === scene) {
      // A replacement renderer for the same document may start with every appearance shown.
      const layers = controller.getAnnotationLayers();
      for (const visible of [false, true]) {
        const ids = layers.filter(layer => layer.visible !== visible && hidden.has(layer.annotationId) !== visible)
          .map(layer => layer.annotationId);
        if (ids.length) void request(ids, visible);
      }
      return;
    }
    scene = next;
    generation++;
    operations = 0;
    filter.value = "";
    status.textContent = "";
    entries = (next?.annotations ?? []).filter(listed).map(describe);
    // A new document starts from its applied appearances, normally all shown.
    hidden = new Set(controller.getAnnotationLayers().filter(layer => !layer.visible).map(layer => layer.annotationId));
    render();
  }

  const toggleAll = (): void => apply(matching.map(entry => entry.annotation.id), all.checked);
  all.addEventListener("change", toggleAll);
  filter.addEventListener("input", render);
  sceneChanged();
  return {
    /** False while the user has turned the annotation off; pass it to the annotation overlay adapter. */
    isAnnotationEnabled(annotation: SceneAnnotation | string): boolean {
      return !hidden.has(typeof annotation === "string" ? annotation : annotation.id);
    },
    /** Call after replacing the document, its renderer or its PDF object. */
    sceneChanged,
    dispose(): void {
      if (disposed) return;
      disposed = true; generation++;
      all.removeEventListener("change", toggleAll);
      filter.removeEventListener("input", render);
      checkboxes.clear();
      container.replaceChildren();
    }
  };
}

export type PdfAnnotationControls = ReturnType<typeof createPdfAnnotationControls>;
