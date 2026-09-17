import type { VectorDrawRun, VectorScene } from "./pdfVectorExtractor";

const cpuPhases = ["strokeLod", "runCulling", "batchPlan", "instanceUpload", "orderedSubmit", "other"] as const;
type CpuPhase = typeof cpuPhases[number];
type WorkCounter = "batchRebuilds" | "instanceUploadBytes" | "textureBinds" | "textureBindSkips";
const drawKinds = ["stroke", "fill", "text", "raster", "gradient-fill", "gradient-stroke"] as const;

const profileByUrl = typeof location !== "undefined" && new URLSearchParams(location.search).get("heprProfile") === "1";

/** Local, opt-in diagnostics: no document names, text, coordinates or pixel data. */
export function renderProfilingEnabled(): boolean {
  const setting = (globalThis as { __HEPR_PROFILE__?: boolean }).__HEPR_PROFILE__;
  if (setting !== undefined) return setting === true;
  return profileByUrl;
}

export class RenderPerformanceProbe {
  private started = -1;
  private reported = 0;
  private lastFrame = 0;
  private cpu: number[] = [];
  private intervals: number[] = [];
  private gpu: number[] = [];
  private scene: VectorScene | null = null;
  private summary: Record<string, unknown> = {};
  private frame: Record<string, unknown> = {};
  private gl: WebGL2RenderingContext | null = null;
  private extension: any = null;
  private queries: { query: WebGLQuery; generation: number }[] = [];
  private activeQuery: WebGLQuery | null = null;
  private lastQuery = -Infinity;
  private gpuSlot: { device: any; query: any; resolve: any; read: any; copied: boolean; generation: number } | null = null;
  private gpuPending = false;
  private gpuTimer = "unavailable";
  private disposed = false;
  private readonly backend: string;
  private phases: Partial<Record<CpuPhase, number>> = {};
  private phaseSamples: Partial<Record<CpuPhase, number[]>> = {};
  private counters: Partial<Record<WorkCounter, number>> = {};
  private counterSamples: Partial<Record<WorkCounter, number[]>> = {};
  private draws: Partial<Record<VectorDrawRun["kind"], { draws: number; instances: number }>> = {};
  private skipKinds = new Set<VectorDrawRun["kind"]>();
  private configuration = "";
  private generation = 0;

  constructor(backend: string) { this.backend = backend; }

  get active(): boolean { return this.started >= 0; }

  mark(): number { return this.active ? performance.now() : -1; }

  phase(name: CpuPhase, start: number): void {
    if (!this.active || start < 0) return;
    this.phases[name] = (this.phases[name] ?? 0) + performance.now() - start;
  }

  count(name: WorkCounter, amount = 1): void {
    if (this.active) this.counters[name] = (this.counters[name] ?? 0) + amount;
  }

  draw(kind: VectorDrawRun["kind"], instances: number): void {
    if (!this.active) return;
    const entry = this.draws[kind] ??= { draws: 0, instances: 0 };
    entry.draws++; entry.instances += instances;
  }

  skips(kind: VectorDrawRun["kind"]): boolean { return this.active && this.skipKinds.has(kind); }

  begin(scene: VectorScene | null, frame: Record<string, unknown>, gl?: WebGL2RenderingContext): void {
    if (this.disposed || !renderProfilingEnabled()) return;
    const now = performance.now();
    const skip = (globalThis as { __HEPR_PROFILE_SKIP__?: unknown }).__HEPR_PROFILE_SKIP__;
    this.skipKinds = new Set(scene?.drawRuns ? drawKinds.filter(kind => skip === kind) : []);
    const configuration = JSON.stringify({ skip: [...this.skipKinds], layers: frame.layers });
    if (this.scene !== scene || this.configuration !== configuration) {
      const sceneChanged = this.scene !== scene;
      this.scene = scene;
      this.summary = scene ? summarizeScene(scene) : {};
      this.cpu = []; this.intervals = []; this.gpu = [];
      this.phaseSamples = {}; this.counterSamples = {};
      this.reported = now; this.lastFrame = 0;
      this.configuration = configuration;
      this.generation++;
      if (sceneChanged) console.info("[HEPR profile scene]", JSON.stringify({ backend: this.backend, ...this.summary }));
    }
    if (this.lastFrame && now - this.lastFrame < 500) this.intervals.push(now - this.lastFrame);
    this.lastFrame = now;
    this.frame = { ...frame, skippedKinds: [...this.skipKinds], skipSupported: Boolean(scene?.drawRuns),
      visibleOrderedRuns: 0, orderedDrawRequests: 0 };
    this.phases = {}; this.counters = {}; this.draws = {};
    if (gl) this.beginGl(gl, now);
    this.started = performance.now();
  }

  orderedRuns(visible: number, submitted: number): void {
    if (this.started < 0) return;
    this.frame.visibleOrderedRuns = Number(this.frame.visibleOrderedRuns) + visible;
    this.frame.orderedDrawRequests = Number(this.frame.orderedDrawRequests) + submitted;
  }

  /** Optional timestamp for the native WebGPU direct scene pass, including its highlights. */
  gpuPass(device: any): Record<string, unknown> {
    if (this.started < 0 || this.gpuPending || this.gpuSlot || !device.features?.has("timestamp-query") ||
        performance.now() - this.lastQuery < 500) return {};
    this.lastQuery = performance.now();
    const usage = (globalThis as any).GPUBufferUsage;
    const query = device.createQuerySet({ type: "timestamp", count: 2 });
    const resolve = device.createBuffer({ size: 16, usage: usage.QUERY_RESOLVE | usage.COPY_SRC });
    const read = device.createBuffer({ size: 16, usage: usage.MAP_READ | usage.COPY_DST });
    this.gpuSlot = { device, query, resolve, read, copied: false, generation: this.generation };
    this.gpuTimer = "WebGPU direct scene pass";
    return { timestampWrites: { querySet: query, beginningOfPassWriteIndex: 0, endOfPassWriteIndex: 1 } };
  }

  resolveGpu(encoder: any): void {
    const slot = this.gpuSlot;
    if (!slot || slot.copied) return;
    encoder.resolveQuerySet(slot.query, 0, 2, slot.resolve, 0);
    encoder.copyBufferToBuffer(slot.resolve, 0, slot.read, 0, 16);
    slot.copied = true;
  }

  end(extra: Record<string, unknown> = {}): void {
    if (this.started < 0) return;
    const now = performance.now();
    this.cpu.push(now - this.started);
    this.phases.other = Math.max(0, now - this.started - Object.values(this.phases).reduce((sum, value) => sum + value, 0));
    for (const phase of cpuPhases) (this.phaseSamples[phase] ??= []).push(this.phases[phase] ?? 0);
    for (const counter of ["batchRebuilds", "instanceUploadBytes", "textureBinds", "textureBindSkips"] as const) {
      (this.counterSamples[counter] ??= []).push(this.counters[counter] ?? 0);
    }
    this.started = -1;
    if (this.activeQuery && this.gl) {
      this.gl.endQuery(this.extension.TIME_ELAPSED_EXT);
      this.queries.push({ query: this.activeQuery, generation: this.generation }); this.activeQuery = null;
    }
    const slot = this.gpuSlot;
    if (slot) {
      this.gpuSlot = null;
      if (slot.copied) {
        this.gpuPending = true;
        // Submitted work is read asynchronously; never block a frame with finish() or a GPU wait.
        void slot.read.mapAsync((globalThis as any).GPUMapMode.READ).then(() => {
          const times = new BigUint64Array(slot.read.getMappedRange());
          const ms = Number(times[1] - times[0]) / 1e6;
          if (!this.disposed && slot.generation === this.generation && Number.isFinite(ms) && ms >= 0) this.gpu.push(ms);
          slot.read.unmap();
        }).catch(() => {}).finally(() => {
          slot.read.destroy(); slot.resolve.destroy(); slot.query.destroy(); this.gpuPending = false;
        });
      } else { slot.read.destroy(); slot.resolve.destroy(); slot.query.destroy(); }
    }
    if (now - this.reported < 2000) return;
    console.info("[HEPR profile frame]", JSON.stringify({ backend: this.backend, ...this.frame, ...extra,
      samples: this.cpu.length, cpuSubmitMs: distribution(this.cpu), activeFrameIntervalMs: distribution(this.intervals),
      cpuPhasesMs: Object.fromEntries(cpuPhases.map(name => [name, distribution(this.phaseSamples[name] ?? [])])),
      workPerFrame: Object.fromEntries(Object.entries(this.counterSamples).map(([name, values]) => [name, {
        mean: Math.round(values.reduce((sum, value) => sum + value, 0) / values.length * 100) / 100,
        max: values.reduce((max, value) => Math.max(max, value), 0)
      }])),
      orderedDrawsByKind: this.draws,
      gpuMs: distribution(this.gpu), gpuSamples: this.gpu.length, gpuTimer: this.gpuTimer }));
    this.cpu = []; this.intervals = []; this.gpu = []; this.phaseSamples = {}; this.counterSamples = {}; this.reported = now;
  }

  dispose(): void {
    this.disposed = true;
    if (this.activeQuery && this.gl) {
      this.gl.endQuery(this.extension.TIME_ELAPSED_EXT); this.gl.deleteQuery(this.activeQuery);
    }
    if (this.gl) for (const { query } of this.queries) this.gl.deleteQuery(query);
    this.queries = []; this.activeQuery = null;
    const slot = this.gpuSlot;
    if (slot) { slot.read.destroy(); slot.resolve.destroy(); slot.query.destroy(); this.gpuSlot = null; }
  }

  private beginGl(gl: WebGL2RenderingContext, now: number): void {
    if (this.gl !== gl) {
      this.gl = gl;
      this.extension = gl.getExtension("EXT_disjoint_timer_query_webgl2");
      this.gpuTimer = this.extension ? "WebGL frame" : "unavailable";
    }
    if (!this.extension) return;
    const disjoint = gl.getParameter(this.extension.GPU_DISJOINT_EXT);
    for (let index = this.queries.length - 1; index >= 0; index--) {
      const { query, generation } = this.queries[index];
      if (!disjoint && !gl.getQueryParameter(query, gl.QUERY_RESULT_AVAILABLE)) continue;
      if (!disjoint && generation === this.generation) this.gpu.push(Number(gl.getQueryParameter(query, gl.QUERY_RESULT)) / 1e6);
      gl.deleteQuery(query); this.queries.splice(index, 1);
    }
    if (disjoint || now - this.lastQuery < 500 || this.queries.length >= 4 ||
        gl.getQuery(this.extension.TIME_ELAPSED_EXT, gl.CURRENT_QUERY)) return;
    const query = gl.createQuery();
    if (query) {
      gl.beginQuery(this.extension.TIME_ELAPSED_EXT, query);
      this.activeQuery = query; this.lastQuery = now;
    }
  }
}

function distribution(values: number[]): { median: number; p95: number } | null {
  if (!values.length) return null;
  values.sort((a, b) => a - b);
  const rounded = (value: number): number => Math.round(value * 100) / 100;
  return { median: rounded(values[Math.floor(values.length / 2)]), p95: rounded(values[Math.min(values.length - 1, Math.floor(values.length * 0.95))]) };
}

export function summarizeScene(scene: VectorScene): Record<string, unknown> {
  const clips = scene.clipPaths ?? [];
  const edges = clips.map(clip => clip.edges.length / 4);
  const byKind: Record<string, number> = {};
  for (const run of scene.drawRuns ?? []) byKind[run.kind] = (byKind[run.kind] ?? 0) + 1;
  return { pages: scene.pageCount, strokes: scene.segmentCount, glyphs: scene.textInstanceCount,
    fills: scene.fillPathCount, images: scene.rasterLayers.length, orderedRuns: scene.drawRuns?.length ?? 0,
    runsByKind: byKind, clips: clips.length, totalClipEdges: edges.reduce((sum, count) => sum + count, 0),
    maxClipEdges: edges.reduce((max, count) => Math.max(max, count), 0) };
}
