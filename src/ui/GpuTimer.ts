import * as THREE from "three";

/** EXT_disjoint_timer_query_webgl2 (not declared by lib.dom). */
interface TimerQueryExt {
  readonly TIME_ELAPSED_EXT: number;
  readonly GPU_DISJOINT_EXT: number;
}

interface Segment {
  label: string;
  query: WebGLQuery;
}

/**
 * DEV tool — GPU EXECUTION time of every frame, split into labelled
 * segments (EXT_disjoint_timer_query_webgl2: Chrome / Edge / Firefox on
 * desktop). The debug HUD's CPU line only covers the main thread: when the
 * frame interval is far above it, this line tells whether the GPU itself is
 * busy for that long (GPU-bound → cut pixel / vertex work) or not (the
 * browser's GPU process, the compositor or the display cadence).
 *
 * WebGL forbids nested timer queries, so ONE query is open at a time:
 * mark(label) closes the open segment and opens the next one. Every GPU
 * command of the frame lands in exactly one segment and the segments add
 * up to the whole frame. Results arrive a few frames later (asynchronous,
 * never stalls the pipeline); frames hit by a "disjoint" event (GPU clock
 * change, context switch…) are dropped.
 */
export class GpuTimer {
  /** Null when the browser / GPU does not expose the timer extension. */
  static create(renderer: THREE.WebGLRenderer): GpuTimer | null {
    const gl = renderer.getContext();
    if (typeof WebGL2RenderingContext === "undefined" || !(gl instanceof WebGL2RenderingContext)) return null;
    const ext = gl.getExtension("EXT_disjoint_timer_query_webgl2") as TimerQueryExt | null;
    return ext ? new GpuTimer(gl, ext) : null;
  }

  /** Label of the pass rendering now (prefix of the per-draw categories). */
  pass = "";
  /**
   * Every measured frame's total GPU time, once its results are read (a few
   * frames late) — the settings page's live card shows it as an indication
   * while this DEV / `?gpu` timer runs (settings/FrameMeter).
   */
  onFrame: ((totalMs: number) => void) | null = null;
  private readonly pool: WebGLQuery[] = [];
  /** Closed frames whose results are not read yet (oldest first). */
  private readonly pending: Segment[][] = [];
  private frame: Segment[] | null = null;
  private active: Segment | null = null;
  private readonly sums = new Map<string, number>();
  private frames = 0;
  /**
   * True once results stopped arriving (some drivers / headless contexts
   * never expose them): the timer then switches itself off for good.
   */
  dead = false;

  private constructor(
    private readonly gl: WebGL2RenderingContext,
    private readonly ext: TimerQueryExt,
  ) {}

  /** Opens the frame (closes a frame left open by an early return). */
  beginFrame(pass: string): void {
    if (this.frame) this.endFrame();
    if (this.dead) return;
    this.frame = [];
    this.setPass(pass);
  }

  /** A new pass starts: its own segment + the prefix of its draw categories. */
  setPass(pass: string): void {
    this.pass = pass;
    this.mark(pass);
  }

  /** Starts a new segment (no-op outside a frame or for the open label). */
  mark(label: string): void {
    const frame = this.frame;
    if (!frame || this.active?.label === label) return;
    const gl = this.gl;
    if (this.active) gl.endQuery(this.ext.TIME_ELAPSED_EXT);
    const query = this.pool.pop() ?? gl.createQuery();
    if (!query) {
      this.active = null;
      return;
    }
    gl.beginQuery(this.ext.TIME_ELAPSED_EXT, query);
    this.active = { label, query };
    frame.push(this.active);
  }

  /** Closes the frame and reads every frame whose results are ready. */
  endFrame(): void {
    if (this.active) this.gl.endQuery(this.ext.TIME_ELAPSED_EXT);
    this.active = null;
    if (this.frame && this.frame.length > 0) this.pending.push(this.frame);
    this.frame = null;
    this.collect();
  }

  private collect(): void {
    const gl = this.gl;
    while (this.pending.length > 0) {
      const segments = this.pending[0];
      if (!segments.every((s) => gl.getQueryParameter(s.query, gl.QUERY_RESULT_AVAILABLE))) break;
      this.pending.shift();
      // Disjoint flag: read once per frame, cleared by the read itself.
      const disjoint = gl.getParameter(this.ext.GPU_DISJOINT_EXT) as boolean;
      if (!disjoint) {
        let total = 0;
        for (const s of segments) {
          const ms = (gl.getQueryParameter(s.query, gl.QUERY_RESULT) as number) / 1e6;
          this.sums.set(s.label, (this.sums.get(s.label) ?? 0) + ms);
          total += ms;
        }
        this.frames++;
        this.onFrame?.(total);
      }
      for (const s of segments) this.pool.push(s.query);
    }
    // Results that never come (lost context, a driver that never exposes
    // them): stop measuring instead of piling up queries.
    if (this.pending.length > 30) {
      for (const segments of this.pending) for (const s of segments) gl.deleteQuery(s.query);
      for (const query of this.pool) gl.deleteQuery(query);
      this.pending.length = 0;
      this.pool.length = 0;
      this.dead = true;
    }
  }

  /**
   * Average GPU ms per frame since the previous call, total + segments
   * (largest first, labels merged by their prefix before ":" unless
   * `detail`). Null until a measured frame arrived.
   */
  take(detail = false): { total: number; frames: number; split: [string, number][] } | null {
    if (this.frames === 0) return null;
    const merged = new Map<string, number>();
    let total = 0;
    for (const [label, ms] of this.sums) {
      const key = detail ? label : label.split(":")[0];
      merged.set(key, (merged.get(key) ?? 0) + ms / this.frames);
      total += ms / this.frames;
    }
    const frames = this.frames;
    this.sums.clear();
    this.frames = 0;
    const split = [...merged].sort((a, b) => b[1] - a[1]);
    return { total, frames, split };
  }
}

/**
 * Wraps every composer pass so its GPU work opens a segment named after the
 * pass (labels from `labelOf`).
 */
export function timePasses(
  passes: readonly { render: (...args: never[]) => void }[],
  timer: GpuTimer,
  labelOf: (pass: object) => string,
): void {
  for (const pass of passes) {
    const label = labelOf(pass);
    const render = pass.render.bind(pass) as (...args: unknown[]) => void;
    (pass as { render: (...args: unknown[]) => void }).render = (...args: unknown[]) => {
      timer.setPass(label);
      render(...args);
    };
  }
}

/**
 * Per-draw categories (detail mode): every draw opens the segment
 * "<pass>:<category>" — category = the shadow pass, a named effect, or the
 * name of the scene's top-level child holding the object. Returns the
 * uninstall function.
 */
export function timeDraws(renderer: THREE.WebGLRenderer, timer: GpuTimer): () => void {
  const original = renderer.renderBufferDirect;
  const cache = new WeakMap<THREE.Object3D, string>();
  const categoryOf = (object: THREE.Object3D): string => {
    let label = cache.get(object);
    if (label) return label;
    let node: THREE.Object3D = object;
    let named = "";
    while (node.parent && !(node.parent as THREE.Scene).isScene) {
      if (!named && node.name.startsWith("givre_")) named = node.name;
      node = node.parent;
    }
    label = named || node.name || node.type;
    cache.set(object, label);
    return label;
  };
  renderer.renderBufferDirect = function (camera, scene, geometry, material, object, group) {
    // Shadow-map draws come with a null scene (WebGLShadowMap).
    timer.mark(scene ? `${timer.pass}:${categoryOf(object)}` : "ombres");
    original.call(this, camera, scene, geometry, material, object, group);
  };
  return () => {
    renderer.renderBufferDirect = original;
  };
}

/** Readable names of the map's categories (debug HUD GPU line, `?gpu=draws`). */
const CATEGORY_NAMES: Record<string, string> = {
  givre_sky: "ciel",
  givre_neige: "neige",
  givre_halos: "halos",
  givre_empreintes: "empreintes",
  givre_snow_surfaces: "neige au sol",
  givre_01_fond: "fond",
  givre_01_animated: "décor animé",
  givre_01_merged: "carte",
  EnemyHealthBars: "barres de vie",
};

/**
 * Short label of a timer segment for the debug HUD (the per-draw split must
 * fit on a laptop screen): `monde:<category>` → the category's short name
 * (the map's batches, whose names list their materials, are all "carte"),
 * the other passes in one term each (`bras`, `sortie`, `FXAA`…), and the
 * world pass before its first draw (clear, uploads) → "monde (début)".
 */
export function gpuLabel(label: string): string {
  const colon = label.indexOf(":");
  const pass = colon < 0 ? label : label.slice(0, colon);
  if (colon < 0) return pass === "monde" ? "monde (début)" : pass;
  if (pass !== "monde") return pass;
  const base = label
    .slice(colon + 1)
    .replace(/\(.*$/s, "")
    .replace(/_c\d+$/, "");
  if (/uber$/.test(base)) return "carte";
  return CATEGORY_NAMES[base] ?? base.replace(/^givre_/, "").slice(0, 16);
}
