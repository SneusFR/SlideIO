import type { MenuAudio } from "./MenuAudio";
import { audio, type AudioBus } from "../audio/AudioManager";
import {
  ANISOTROPY_LEVELS,
  FPS_CAPS,
  FPS_TARGETS,
  RENDER_SCALE_MAX,
  RENDER_SCALE_MIN,
  RENDER_SCALE_STEP,
  SHADOW_QUALITIES,
  editChoice,
  floorRenderScale,
  pixelRatioFor,
  snapRefreshRate,
  type AntiAliasing,
  type Anisotropy,
  type DisplayEnv,
  type FpsCapSetting,
  type FpsTargetSetting,
  type GraphicsCaps,
  type GraphicsKey,
  type GraphicsValues,
  type ParticleDensity,
  type PresetChoice,
  type ShadowMode,
  type ShadowQuality,
  type SnowLevel,
} from "../settings/GraphicsSettings";
import {
  AA_LABELS,
  ANISOTROPY_LABELS,
  PARTICLE_LABELS,
  PRESET_LABELS,
  SETTING_NAMES,
  SHADOW_LABELS,
  SHADOW_QUALITY_LABELS,
  SNOW_LABELS,
  fpsCapLabel,
  fpsTargetLabel,
  formatNumber,
  formatPercent,
  valueLabel,
} from "../settings/labels";
import type { DetectionEvent, GraphicsController } from "../settings/GraphicsController";
import type { PerfPanelMode, SettingsRecord, SettingsStore } from "../settings/SettingsStore";
import type { LiveStats } from "../settings/FrameMeter";
import {
  CROSSHAIR_SCALE_MAX,
  CROSSHAIR_SCALE_MIN,
  DEFAULT_CROSSHAIR,
  type CrosshairSettings,
  type CrosshairShape,
} from "../ui/CrosshairSettings";
import { OUTLINE_THICKNESS_MAX, OUTLINE_THICKNESS_MIN } from "../game/OutlineSettings";

/** What the page reads from the running game. */
export interface SettingsPageGame {
  readonly graphicsCaps: GraphicsCaps;
  readonly gpuName: string;
  readonly hasOutline: boolean;
  livePerf(): (LiveStats & { width: number; height: number }) | null;
}

export interface SettingsPageDeps {
  store: SettingsStore;
  controller: GraphicsController;
  game: SettingsPageGame;
  sounds: MenuAudio;
  /** In a match (solo or multiplayer): a reload would leave it. */
  isInMatch: () => boolean;
  /** Display refresh rate (Hz). */
  refreshHz: () => number;
  env: () => DisplayEnv;
}

export type SettingsTab = "graphics" | "crosshair" | "audio";

const TABS: { id: SettingsTab; label: string }[] = [
  { id: "graphics", label: "Graphics" },
  { id: "crosshair", label: "Crosshair" },
  { id: "audio", label: "Audio" },
];

/** Cost of an option for the frame time: 1 bean = light … 3 = heavy. */
type Cost = 1 | 2 | 3;
const COST_WORDS: Record<Cost, string> = { 1: "Light", 2: "Medium", 3: "Heavy" };

const PRESET_HINTS: Record<PresetChoice, string> = {
  auto: "Measured on this PC and this map: the best look that holds your FPS target, with headroom for fights.",
  bas: "The old LOW preset: FXAA, static shadows, one pixel per screen pixel. For integrated graphics.",
  moyen: "MSAA 2×, medium dynamic shadows, 4× filtering. For entry-level graphics cards.",
  eleve: "The old HIGH preset: MSAA 4×, detailed dynamic shadows, 8× filtering.",
  ultra: "Full resolution even on high-density screens, the sharpest shadows, 16× filtering, dense snow. For powerful graphics cards.",
  custom: "Your own settings, option by option. Pick a preset to go back to a ready-made set.",
};

const VOLUME_ROWS: { bus: AudioBus; label: string; desc: string; linked?: AudioBus[] }[] = [
  { bus: "master", label: "Main volume", desc: "Every sound in the game." },
  // Weapon IMPACT sounds (hammer hits, explosions…) live on the "impacts" bus
  // but belong to the weapon volume from the player's point of view.
  { bus: "weapons", label: "Weapon volume", desc: "Shots, reloads and impacts.", linked: ["impacts"] },
  { bus: "music", label: "Music volume", desc: "The menu music." },
  { bus: "ambience", label: "Ambiance volume", desc: "The sounds of the map." },
];

const SHAPES: { value: CrosshairShape; label: string }[] = [
  { value: "STICKER", label: "Sticker" },
  { value: "DOT", label: "Dot" },
  { value: "CROSS", label: "Cross" },
];

/** Session storage flag: reopen the page after "Apply & reload". */
export const REOPEN_KEY = "slideio.reopenSettings";

/** Small DOM builder: tag, class, text. */
function el<K extends keyof HTMLElementTagNameMap>(tag: K, className = "", text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function setText(node: HTMLElement, text: string): void {
  if (node.textContent !== text) node.textContent = text;
}

interface Option<T> {
  value: T;
  label: string;
  disabled?: boolean;
  title?: string;
}

/**
 * Segmented choice (radio group): click, or arrow keys inside the group
 * (roving focus: Tab enters / leaves the group on its selected option).
 */
class Segmented<T> {
  readonly el: HTMLDivElement;
  private readonly buttons: { option: Option<T>; button: HTMLButtonElement }[] = [];
  private value: T | null = null;

  constructor(
    label: string,
    private options: Option<T>[],
    private readonly onPick: (value: T) => void,
    private readonly sounds: MenuAudio,
    className = "",
  ) {
    this.el = el("div", `gs-seg ${className}`.trim());
    this.el.setAttribute("role", "radiogroup");
    this.el.setAttribute("aria-label", label);
    this.build();
    this.el.addEventListener("keydown", (e) => this.onKey(e));
  }

  private build(): void {
    this.el.textContent = "";
    this.buttons.length = 0;
    for (const option of this.options) {
      const button = el("button", "gs-seg-btn", option.label);
      button.type = "button";
      button.setAttribute("role", "radio");
      button.addEventListener("pointerenter", () => this.sounds.hover());
      button.addEventListener("click", () => {
        const current = this.buttons.find((b) => b.button === button)?.option;
        if (!current || button.disabled || current.disabled) return;
        this.sounds.click();
        this.onPick(current.value);
      });
      this.buttons.push({ option, button });
      this.el.appendChild(button);
    }
  }

  /** Options whose labels / availability depend on the state (frame cap "Auto (60)"…). */
  setOptions(options: Option<T>[]): void {
    const same =
      options.length === this.options.length &&
      options.every((o, i) => o.value === this.options[i].value && o.label === this.options[i].label);
    this.options = options;
    if (!same) this.build();
    else this.options.forEach((o, i) => (this.buttons[i].option = o));
    this.set(this.value as T, true);
  }

  set(value: T, force = false): void {
    if (force || value !== this.value) {
      this.value = value;
      for (const { option, button } of this.buttons) {
        const on = option.value === value;
        button.setAttribute("aria-checked", on ? "true" : "false");
        button.tabIndex = on ? 0 : -1;
        button.classList.toggle("on", on);
      }
      // No option selected (value outside the list): the first one takes the focus stop.
      if (!this.buttons.some((b) => b.option.value === value) && this.buttons[0]) this.buttons[0].button.tabIndex = 0;
    }
    for (const { option, button } of this.buttons) {
      button.setAttribute("aria-disabled", option.disabled ? "true" : "false");
      button.classList.toggle("off-limits", !!option.disabled);
      if (option.title) button.title = option.title;
      else button.removeAttribute("title");
    }
  }

  setEnabled(on: boolean): void {
    for (const { button } of this.buttons) button.disabled = !on;
    this.el.classList.toggle("disabled", !on);
  }

  private onKey(e: KeyboardEvent): void {
    const keys = ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End"];
    if (!keys.includes(e.key)) return;
    const enabled = this.buttons.filter((b) => !b.option.disabled && !b.button.disabled);
    if (enabled.length === 0) return;
    e.preventDefault();
    const current = enabled.findIndex((b) => b.button === document.activeElement);
    let next = current < 0 ? 0 : current;
    if (e.key === "Home") next = 0;
    else if (e.key === "End") next = enabled.length - 1;
    else if (e.key === "ArrowLeft" || e.key === "ArrowUp") next = (next - 1 + enabled.length) % enabled.length;
    else next = (next + 1) % enabled.length;
    enabled[next].button.focus();
    enabled[next].button.click();
  }
}

/** Range slider with its value text; applies while dragging (throttled) and on release. */
class Slider {
  readonly el: HTMLDivElement;
  readonly input: HTMLInputElement;
  private readonly out: HTMLOutputElement;
  private timer: number | null = null;

  constructor(
    label: string,
    opts: { min: number; max: number; step: number },
    private readonly format: (v: number) => string,
    private readonly onValue: (v: number) => void,
    /** Live apply period while dragging (ms); 0 = every input. */
    private readonly throttleMs = 0,
  ) {
    this.el = el("div", "gs-slider");
    this.input = el("input", "gs-range");
    this.input.type = "range";
    this.input.min = String(opts.min);
    this.input.max = String(opts.max);
    this.input.step = String(opts.step);
    this.input.setAttribute("aria-label", label);
    this.out = el("output", "gs-slider-value");
    this.el.append(this.input, this.out);
    this.input.addEventListener("input", () => {
      const v = Number(this.input.value);
      this.show(v);
      if (this.throttleMs <= 0) {
        this.onValue(v);
        return;
      }
      if (this.timer !== null) return;
      this.timer = window.setTimeout(() => {
        this.timer = null;
        this.onValue(Number(this.input.value));
      }, this.throttleMs);
    });
    this.input.addEventListener("change", () => {
      if (this.timer !== null) {
        window.clearTimeout(this.timer);
        this.timer = null;
      }
      this.onValue(Number(this.input.value));
    });
  }

  set(v: number): void {
    // Never fight the player's drag.
    if (document.activeElement === this.input && this.timer !== null) return;
    const s = String(v);
    if (this.input.value !== s) this.input.value = s;
    this.show(v);
  }

  setEnabled(on: boolean): void {
    this.input.disabled = !on;
    this.el.classList.toggle("disabled", !on);
  }

  private show(v: number): void {
    const text = this.format(v);
    if (this.out.textContent !== text) this.out.textContent = text;
    this.input.setAttribute("aria-valuetext", text);
    // Filled part of the track (custom property on the input only).
    const min = Number(this.input.min);
    const max = Number(this.input.max);
    const f = max > min ? (Math.min(max, Math.max(min, v)) - min) / (max - min) : 0;
    this.input.style.setProperty("--fill", `${Math.round(f * 1000) / 10}%`);
  }
}

interface Row {
  el: HTMLDivElement;
  desc: HTMLParagraphElement;
  note: HTMLSpanElement;
  reload: HTMLSpanElement;
  control: HTMLDivElement;
}

/**
 * THE SETTINGS PAGE — graphics (presets, every option with its cost, the
 * automatic detection), crosshair, audio. Opened from the main menu and from
 * the pause menu (the same overlay); the live game view stays visible on the
 * right so every change is seen — and measured, on the live card — as it
 * happens. Changes apply at once, except the few that need a reload (listed
 * at the bottom, "Apply & reload"). Short labels are written in natural case
 * and shown in uppercase by the stylesheet, like the rest of the menu.
 */
export class SettingsPage {
  /** Opened / closed (the menu hides its own UI while the page is up). */
  onOpenChange: ((open: boolean) => void) | null = null;
  /** Right before a detection the player starts (main.ts: the menu's idle work first). */
  beforeDetection: (() => void) | null = null;

  private readonly root: HTMLElement;
  private readonly tabButtons = new Map<SettingsTab, HTMLButtonElement>();
  private readonly panes = new Map<SettingsTab, HTMLElement>();
  private readonly refreshers: (() => void)[] = [];
  private readonly body: HTMLElement;
  private readonly reloadBar: HTMLElement;
  private readonly reloadText: HTMLParagraphElement;
  private readonly reloadWarn: HTMLParagraphElement;
  private readonly reloadBtn: HTMLButtonElement;
  private reloadArmed = false;
  private tab: SettingsTab = "graphics";
  private openState = false;
  private meterTimer: number | null = null;
  private lastFocus: HTMLElement | null = null;
  private graphicsFieldset!: HTMLFieldSetElement;
  // Live card
  private readonly meter: HTMLElement;
  private readonly meterNum: HTMLElement;
  private readonly meterTarget: HTMLElement;
  private readonly meterStatus: HTMLElement;
  private readonly meterFrame: HTMLElement;
  private readonly meterSlow: HTMLElement;
  private readonly meterCpu: HTMLElement;
  private readonly meterGpuRow: HTMLElement;
  private readonly meterGpu: HTMLElement;
  private readonly meterSize: HTMLElement;
  private readonly meterDevice: HTMLElement;
  // Detection block
  private detectText!: HTMLParagraphElement;
  private detectMeta!: HTMLParagraphElement;
  private detectBtn!: HTMLButtonElement;
  private detectProgress!: HTMLDivElement;
  private detectFill!: HTMLDivElement;

  constructor(private readonly deps: SettingsPageDeps) {
    this.root = document.getElementById("settings-page") ?? document.body.appendChild(el("div"));
    this.root.id = "settings-page";
    this.root.classList.add("hidden");
    this.root.setAttribute("role", "dialog");
    this.root.setAttribute("aria-modal", "true");
    this.root.setAttribute("aria-labelledby", "gs-title");
    this.root.textContent = "";

    const panel = el("section", "gs-panel");
    const head = el("header", "gs-head");
    const titleWrap = el("div", "gs-title-wrap");
    const title = el("h2", "gs-title", "Settings");
    title.id = "gs-title";
    const subtitle = el("p", "gs-subtitle", "Everything applies instantly");
    // (Narrow windows: the panel covers the map — the hint goes, see the CSS.)
    subtitle.append(el("span", "gs-subtitle-side", " — watch the map on the right"), ".");
    titleWrap.append(title, subtitle);
    const back = el("button", "gs-back", "Back");
    back.type = "button";
    back.title = "Back (Esc)";
    back.addEventListener("pointerenter", () => deps.sounds.hover());
    back.addEventListener("click", () => {
      deps.sounds.click();
      this.close();
    });
    head.append(titleWrap, back);

    const tabs = el("nav", "gs-tabs");
    tabs.setAttribute("role", "tablist");
    tabs.setAttribute("aria-label", "Settings categories");
    for (const t of TABS) {
      const b = el("button", "gs-tab", t.label);
      b.type = "button";
      b.id = `gs-tab-${t.id}`;
      b.setAttribute("role", "tab");
      b.setAttribute("aria-controls", `gs-pane-${t.id}`);
      b.addEventListener("pointerenter", () => deps.sounds.hover());
      b.addEventListener("click", () => {
        deps.sounds.click();
        this.showTab(t.id);
      });
      this.tabButtons.set(t.id, b);
      tabs.appendChild(b);
    }
    tabs.addEventListener("keydown", (e) => {
      if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
      e.preventDefault();
      const i = TABS.findIndex((t) => t.id === this.tab);
      const next = TABS[(i + (e.key === "ArrowRight" ? 1 : TABS.length - 1)) % TABS.length].id;
      this.showTab(next);
      this.tabButtons.get(next)?.focus();
    });

    this.body = el("div", "gs-body");
    for (const t of TABS) {
      const pane = el("div", "gs-pane");
      pane.id = `gs-pane-${t.id}`;
      pane.setAttribute("role", "tabpanel");
      pane.setAttribute("aria-labelledby", `gs-tab-${t.id}`);
      this.panes.set(t.id, pane);
      this.body.appendChild(pane);
    }

    this.reloadBar = el("footer", "gs-reload hidden");
    const reloadCopy = el("div", "gs-reload-copy");
    this.reloadText = el("p", "gs-reload-text");
    this.reloadWarn = el("p", "gs-reload-warn", "Reloading leaves the current match.");
    reloadCopy.append(this.reloadText, this.reloadWarn);
    this.reloadBtn = el("button", "gs-btn gs-btn-gold", "Apply & reload");
    this.reloadBtn.type = "button";
    this.reloadBtn.addEventListener("click", () => this.onReload());
    this.reloadBar.append(reloadCopy, this.reloadBtn);

    panel.append(head, tabs, this.body, this.reloadBar);

    // Live card (the live view's corner).
    this.meter = el("aside", "gs-meter");
    this.meter.setAttribute("aria-label", "Live performance");
    const top = el("div", "gs-meter-top");
    this.meterNum = el("span", "gs-meter-num", "—");
    const unit = el("span", "gs-meter-unit", "FPS");
    this.meterTarget = el("span", "gs-meter-target");
    top.append(this.meterNum, unit, this.meterTarget);
    this.meterStatus = el("p", "gs-meter-status");
    const rows = el("dl", "gs-meter-rows");
    const metric = (label: string, hint: string): { row: HTMLElement; dd: HTMLElement } => {
      const wrap = el("div");
      const dt = el("dt", "", label);
      dt.title = hint;
      const dd = el("dd", "", "—");
      wrap.append(dt, dd);
      rows.appendChild(wrap);
      return { row: wrap, dd };
    };
    this.meterFrame = metric("Frame", "Median time between two displayed frames").dd;
    this.meterSlow = metric("Slow frames", "The slowest 5% of frames: what you feel as stutter").dd;
    this.meterCpu = metric("CPU (game)", "Game time on the processor, per frame").dd;
    const gpu = metric("GPU", "Approximate: from the debug mode's GPU timer queries (?gpu)");
    this.meterGpuRow = gpu.row;
    this.meterGpu = gpu.dd;
    this.meterSize = metric("Render", "Size of the rendered 3D image, in pixels").dd;
    this.meterDevice = el("p", "gs-meter-device");
    this.meter.append(top, this.meterStatus, rows, this.meterDevice);

    this.root.append(panel, this.meter);

    this.buildGraphics(this.panes.get("graphics")!);
    this.buildCrosshair(this.panes.get("crosshair")!);
    this.buildAudio(this.panes.get("audio")!);
    this.showTab("graphics");

    deps.store.subscribe(() => {
      if (this.openState) this.refresh();
    });
    deps.controller.subscribe((e) => this.onDetection(e));
    document.addEventListener("keydown", (e) => {
      if (!this.openState || e.key !== "Escape") return;
      e.preventDefault();
      this.close();
    });
  }

  get isOpen(): boolean {
    return this.openState;
  }

  open(tab?: SettingsTab): void {
    if (tab) this.showTab(tab);
    if (this.openState) return;
    this.openState = true;
    this.lastFocus = document.activeElement as HTMLElement | null;
    this.reloadArmed = false;
    this.root.classList.remove("hidden");
    this.refresh();
    this.updateMeter();
    this.meterTimer = window.setInterval(() => this.updateMeter(), 250);
    this.onOpenChange?.(true);
    this.tabButtons.get(this.tab)?.focus();
  }

  close(): void {
    if (!this.openState) return;
    this.openState = false;
    this.root.classList.add("hidden");
    if (this.meterTimer !== null) window.clearInterval(this.meterTimer);
    this.meterTimer = null;
    this.onOpenChange?.(false);
    this.lastFocus?.focus?.();
  }

  private showTab(id: SettingsTab): void {
    this.tab = id;
    for (const [t, b] of this.tabButtons) {
      const on = t === id;
      b.setAttribute("aria-selected", on ? "true" : "false");
      b.tabIndex = on ? 0 : -1;
      b.classList.toggle("on", on);
    }
    for (const [t, p] of this.panes) p.hidden = t !== id;
    this.body.scrollTop = 0;
  }

  // ------------------------------------------------------------ helpers

  private get record(): SettingsRecord {
    return this.deps.store.get();
  }

  private get caps(): GraphicsCaps {
    return this.deps.game.graphicsCaps;
  }

  private section(parent: HTMLElement, title: string, intro?: string): HTMLElement {
    const s = el("section", "gs-section");
    s.appendChild(el("h3", "gs-section-title", title));
    if (intro) s.appendChild(el("p", "gs-section-intro", intro));
    parent.appendChild(s);
    return s;
  }

  private row(parent: HTMLElement, label: string, desc: string, control: HTMLElement, cost?: Cost): Row {
    const r = el("div", "gs-row");
    const text = el("div", "gs-row-text");
    const head = el("div", "gs-row-label");
    head.appendChild(el("span", "gs-row-name", label));
    if (cost) {
      const chip = el("span", "gs-cost");
      chip.dataset.cost = String(cost);
      chip.setAttribute("role", "img");
      chip.setAttribute("aria-label", `${COST_WORDS[cost]} impact on FPS`);
      chip.title = `${COST_WORDS[cost]} impact on FPS`;
      for (let i = 0; i < 3; i++) chip.appendChild(el("i", i < cost ? "full" : ""));
      chip.appendChild(el("span", "gs-cost-word", COST_WORDS[cost]));
      head.appendChild(chip);
    }
    const reload = el("span", "gs-chip-reload hidden", "On reload");
    const note = el("span", "gs-chip-note hidden");
    head.append(reload, note);
    const p = el("p", "gs-row-desc", desc);
    text.append(head, p);
    const ctl = el("div", "gs-row-control");
    ctl.appendChild(control);
    r.append(text, ctl);
    parent.appendChild(r);
    return { el: r, desc: p, note, reload, control: ctl };
  }

  /** Edit one graphics value: "Custom" (or the preset these values are exactly). */
  private edit<K extends GraphicsKey>(key: K, value: GraphicsValues[K]): void {
    const { controller, store } = this.deps;
    const env = this.deps.env();
    store.update((d) => {
      d.graphics = editChoice(d.graphics, key, value, env, controller.gpu, controller.mapId);
    });
  }

  private pickPreset(id: PresetChoice): void {
    const { controller, store } = this.deps;
    if (id === "custom") {
      const values = controller.effective();
      store.update((d) => {
        d.graphics = { ...d.graphics, preset: "custom", custom: values };
      });
      return;
    }
    store.update((d) => {
      d.graphics = { ...d.graphics, preset: id };
    });
    // "Auto" means MEASURED: no up-to-date measurement here → now.
    if (id === "auto" && controller.needsDetection()) this.startDetection();
  }

  private startDetection(): void {
    this.beforeDetection?.();
    void this.deps.controller.runDetection("manual");
  }

  // ----------------------------------------------------------- graphics

  private buildGraphics(pane: HTMLElement): void {
    const { sounds } = this.deps;
    const caps = this.caps;
    const fieldset = el("fieldset", "gs-fieldset");
    this.graphicsFieldset = fieldset;
    pane.appendChild(fieldset);

    // ---- Preset + detection ----
    const presetSec = this.section(fieldset, "Preset");
    const presetSeg = new Segmented<PresetChoice>(
      "Graphics preset",
      (["auto", "bas", "moyen", "eleve", "ultra", "custom"] as PresetChoice[]).map((p) => ({ value: p, label: PRESET_LABELS[p] })),
      (p) => this.pickPreset(p),
      sounds,
      "gs-seg-wide gs-presets",
    );
    presetSec.appendChild(presetSeg.el);
    const presetHint = el("p", "gs-preset-hint");
    presetSec.appendChild(presetHint);

    const detect = el("div", "gs-detect");
    const detectCopy = el("div", "gs-detect-copy");
    const detectTitle = el("p", "gs-detect-title", "Auto-detect");
    this.detectText = el("p", "gs-detect-text");
    this.detectMeta = el("p", "gs-detect-meta");
    this.detectProgress = el("div", "gs-detect-progress hidden");
    this.detectProgress.setAttribute("role", "progressbar");
    this.detectProgress.setAttribute("aria-label", "Detection progress");
    this.detectFill = el("div", "gs-detect-fill");
    this.detectProgress.appendChild(this.detectFill);
    detectCopy.append(detectTitle, this.detectText, this.detectMeta, this.detectProgress);
    const detectSide = el("div", "gs-detect-side");
    this.detectBtn = el("button", "gs-btn", "Run detection");
    this.detectBtn.type = "button";
    this.detectBtn.addEventListener("pointerenter", () => sounds.hover());
    this.detectBtn.addEventListener("click", () => {
      sounds.click();
      if (this.deps.controller.detecting) this.deps.controller.cancelDetection();
      else this.startDetection();
    });
    const targetWrap = el("div", "gs-detect-target");
    const targetLabel = el("span", "gs-detect-target-label", "Target");
    const targetSeg = new Segmented<FpsTargetSetting>(
      "Detection target",
      [],
      (t) => {
        this.deps.store.update((d) => {
          d.fpsTarget = t;
        });
        // "Auto" measured for the old target: measure again for the new one.
        if (this.record.graphics.preset === "auto" && this.deps.controller.needsDetection()) this.startDetection();
      },
      sounds,
      "gs-seg-small",
    );
    targetWrap.append(targetLabel, targetSeg.el);
    detectSide.append(this.detectBtn, targetWrap);
    detect.append(detectCopy, detectSide);
    presetSec.appendChild(detect);

    // ---- Image ----
    const image = this.section(fieldset, "Image");
    const scale = new Slider(
      "Render resolution",
      { min: RENDER_SCALE_MIN, max: RENDER_SCALE_MAX, step: RENDER_SCALE_STEP },
      (v) => formatPercent(v),
      (v) => this.edit("renderScale", v),
      150,
    );
    const scaleRow = this.row(
      image,
      "Render resolution",
      "How many pixels are rendered, as a % of your screen's resolution. Lower is much faster and a bit blurrier; above 100% is supersampling, for powerful graphics cards.",
      scale.el,
      3,
    );
    const scalePx = el("p", "gs-row-sub");
    scaleRow.control.appendChild(scalePx);

    const aa = new Segmented<AntiAliasing>("Anti-aliasing", [], (v) => this.edit("antialiasing", v), sounds);
    const aaRow = this.row(
      image,
      "Anti-aliasing",
      "Smooths jagged edges. FXAA is cheap; MSAA is sharper but heavy on integrated graphics.",
      aa.el,
      3,
    );

    // ---- Shadows ----
    const shadowsSec = this.section(fieldset, "Shadows");
    const shadows = new Segmented<ShadowMode>(
      "Shadows",
      (["off", "static", "dynamic"] as const).map((v) => ({ value: v, label: SHADOW_LABELS[v] })),
      (v) => this.edit("shadows", v),
      sounds,
    );
    const shadowsRow = this.row(
      shadowsSec,
      "Shadows",
      "Static: the map's shadows, computed once at load. Dynamic: recomputed every frame, the characters' shadows included.",
      shadows.el,
      2,
    );
    const quality = new Segmented<ShadowQuality>("Shadow quality", [], (v) => this.edit("shadowQuality", v), sounds);
    const qualityRow = this.row(
      shadowsSec,
      "Shadow quality",
      "Size of the shadow map: sharper shadow edges. With dynamic shadows, it costs time every frame.",
      quality.el,
      2,
    );
    const chars = new Segmented<boolean>("Character shadows", yesNo(), (on) => this.edit("characterShadows", on), sounds);
    const charsRow = this.row(
      shadowsSec,
      "Character shadows",
      "Characters, their weapons and moving targets cast shadows on the ground (with dynamic shadows).",
      chars.el,
      2,
    );

    // ---- Effects ----
    const fx = this.section(fieldset, "Effects");
    const snow = new Segmented<SnowLevel>(
      "Snow",
      (["off", "legere", "normale", "dense"] as const).map((v) => ({ value: v, label: SNOW_LABELS[v] })),
      (v) => this.edit("snow", v),
      sounds,
    );
    const snowRow = this.row(fx, "Snow", "The snowflakes falling on Givre.", snow.el, 1);
    const halos = new Segmented<boolean>("Light halos", yesNo(), (on) => this.edit("halos", on), sounds);
    const halosRow = this.row(fx, "Light halos", "The glow around the bulbs and lanterns of Givre.", halos.el, 1);
    const prints = new Segmented<boolean>("Snow footprints", yesNo(), (on) => this.edit("footprints", on), sounds);
    const printsRow = this.row(fx, "Snow footprints", "The footprints left in the snow of Givre.", prints.el, 1);
    const particles = new Segmented<ParticleDensity>(
      "Particles",
      (["normal", "reduced"] as const).map((v) => ({ value: v, label: PARTICLE_LABELS[v] })),
      (v) => this.edit("particles", v),
      sounds,
    );
    this.row(fx, "Particles", "Sparks and debris from impacts, explosions and hammer hits.", particles.el, 1);
    const aniso = new Segmented<Anisotropy>("Anisotropic filtering", [], (v) => this.edit("anisotropy", v), sounds);
    const anisoRow = this.row(fx, "Anisotropic filtering", "Keeps floors and walls sharp when you see them at an angle.", aniso.el, 1);

    // ---- Performance ----
    const rate = this.section(fieldset, "Performance");
    const cap = new Segmented<FpsCapSetting>(
      "FPS limit",
      [],
      (v) => this.deps.store.update((d) => void (d.fpsCap = v)),
      sounds,
      "gs-seg-wrap",
    );
    const capRow = this.row(rate, "FPS limit", "", cap.el);
    const panel = new Segmented<PerfPanelMode>(
      "Performance panel",
      [
        { value: "full", label: "Full" },
        { value: "fps", label: "FPS only" },
        { value: "off", label: "Hidden" },
      ],
      (v) => this.deps.store.update((d) => void (d.perfPanel = v)),
      sounds,
    );
    this.row(rate, "Performance panel", "The stats panel in the top-left corner during a match. Hidden, it costs nothing.", panel.el);

    // ---- Outline (Givre cel-shading, when the map has it) ----
    let outlineRefresh: (() => void) | null = null;
    if (this.deps.game.hasOutline) outlineRefresh = this.buildOutline(fieldset);

    this.refreshers.push(() => {
      const record = this.record;
      const { controller } = this.deps;
      const v = controller.effective();
      const env = this.deps.env();
      const preset = record.graphics.preset;
      presetSeg.set(preset);
      setText(presetHint, PRESET_HINTS[preset]);
      // Detection block
      this.refreshDetection();
      const hz = snapRefreshRate(this.deps.refreshHz());
      const targets = FPS_TARGETS.filter((t) => t === "display" || t < hz);
      targetSeg.setOptions(targets.map((t) => ({ value: t, label: fpsTargetLabel(t, hz) })));
      targetSeg.set(targets.includes(record.fpsTarget) ? record.fpsTarget : "display");
      targetWrap.classList.toggle("hidden", targets.length < 2);
      // Image
      scale.set(Math.round(v.renderScale));
      const ratio = pixelRatioFor(v.renderScale, env.dpr);
      const w = Math.floor(window.innerWidth * ratio);
      const h = Math.floor(window.innerHeight * ratio);
      const nw = Math.floor(window.innerWidth * env.dpr);
      const nh = Math.floor(window.innerHeight * env.dpr);
      setText(scalePx, `${w} × ${h} pixels · screen ${nw} × ${nh}`);
      note(scaleRow, v.renderScale < floorRenderScale(env) - 0.5 ? "Below the auto-detect floor" : "");
      aa.setOptions(
        (["none", "fxaa", "msaa2", "msaa4"] as AntiAliasing[]).map((a) => {
          const off = (!caps.composer && (a === "fxaa" || a === "msaa2")) || (a === "msaa2" && caps.maxSamples < 2) || (a === "msaa4" && caps.maxSamples < 4);
          return {
            value: a,
            label: AA_LABELS[a],
            disabled: off,
            title: off ? (caps.composer ? "Not supported by this graphics card" : "Givre only") : undefined,
          };
        }),
      );
      aa.set(caps.composer ? v.antialiasing : v.antialiasing === "msaa2" ? "msaa4" : v.antialiasing === "fxaa" ? "none" : v.antialiasing);
      note(aaRow, caps.composer ? "" : "MSAA applies on reload here");
      // Shadows
      shadows.set(v.shadows);
      quality.setOptions(
        SHADOW_QUALITIES.map((q) => {
          const off = SHADOW_QUALITIES.indexOf(q) > SHADOW_QUALITIES.indexOf(caps.maxShadowQuality);
          return { value: q, label: SHADOW_QUALITY_LABELS[q], disabled: off, title: off ? "Too big for this graphics card" : undefined };
        }),
      );
      quality.set(v.shadowQuality);
      quality.setEnabled(v.shadows !== "off");
      note(qualityRow, v.shadows === "off" ? "No shadows" : "");
      chars.set(v.characterShadows);
      chars.setEnabled(v.shadows === "dynamic");
      note(charsRow, v.shadows === "dynamic" ? "" : "Needs dynamic shadows");
      // Effects
      snow.set(v.snow);
      halos.set(v.halos);
      prints.set(v.footprints);
      particles.set(v.particles);
      aniso.setOptions(
        ANISOTROPY_LEVELS.map((a) => {
          const off = a > Math.max(1, caps.maxAnisotropy);
          return { value: a, label: ANISOTROPY_LABELS[a], disabled: off, title: off ? "Above the maximum of this graphics card" : undefined };
        }),
      );
      aniso.set(v.anisotropy);
      note(snowRow, caps.snow ? "" : "Givre only");
      note(halosRow, caps.halos ? "" : "Givre only");
      note(printsRow, caps.footprints ? "" : "Givre only");
      note(anisoRow, caps.anisotropicTextures ? "" : "Shows on Givre");
      // Performance
      const effectivePreset = controller.effectivePreset();
      cap.setOptions(FPS_CAPS.map((c) => ({ value: c, label: fpsCapLabel(c, effectivePreset) })));
      cap.set(record.fpsCap);
      setText(
        capRow.desc,
        `Caps the frame rate: less heat and fan noise on a laptop (60 also fixes stutter on some). Off, the game follows your screen (${hz} Hz).`,
      );
      panel.set(record.perfPanel);
      // Reload chips
      const pending = new Set(controller.pendingReload().map((c) => c.key));
      chip(shadowsRow, pending.has("shadows"));
      chip(charsRow, pending.has("characterShadows"));
      chip(aaRow, pending.has("antialiasing"));
      outlineRefresh?.();
      this.refreshReloadBar();
    });
  }

  private buildOutline(parent: HTMLElement): () => void {
    const { sounds, store, controller } = this.deps;
    const sec = this.section(parent, "Outline (Givre)");
    const on = new Segmented<boolean>("Cel outline", yesNo(), (v) => store.update((d) => void (d.outline.enabled = v)), sounds);
    this.row(sec, "Cel outline", "The white cartoon outline around shapes.", on.el, 2);
    const thick = new Slider(
      "Outline thickness",
      { min: OUTLINE_THICKNESS_MIN * 100, max: OUTLINE_THICKNESS_MAX * 100, step: 5 },
      (v) => `${formatNumber(v / 100, 2)} px`,
      (v) => store.update((d) => void (d.outline.thickness = v / 100)),
    );
    this.row(sec, "Outline thickness", "Width of the outline.", thick.el);
    const intensity = new Slider(
      "Outline intensity",
      { min: 0, max: 100, step: 1 },
      (v) => formatPercent(v),
      (v) => store.update((d) => void (d.outline.intensity = v / 100)),
    );
    this.row(sec, "Outline intensity", "Opacity of the outline.", intensity.el);
    const debug = new Segmented<boolean>("Edge debug", yesNo(), (v) => controller.setOutlineDebug(v), sounds);
    this.row(sec, "Edge debug", "Shows the detected edges only (for tuning; not saved).", debug.el);
    return () => {
      const o = this.record.outline;
      on.set(o.enabled);
      thick.set(Math.round(o.thickness * 100));
      intensity.set(Math.round(o.intensity * 100));
      debug.set(controller.outlineDebugOn);
    };
  }

  // ---------------------------------------------------------- detection

  private onDetection(e: DetectionEvent): void {
    if (!this.openState) return;
    if (e.kind === "progress") this.refreshDetection();
    else this.refresh();
  }

  private refreshDetection(): void {
    const { controller } = this.deps;
    const running = controller.detecting;
    this.graphicsFieldset.classList.toggle("gs-busy", running);
    // The options are not editable while candidates are measured on screen
    // (inert: neither clickable nor focusable; the Cancel button stays live).
    for (const node of this.graphicsFieldset.querySelectorAll<HTMLElement>(".gs-row, .gs-presets, .gs-detect-target")) {
      node.inert = running;
      node.classList.toggle("gs-locked", running);
    }
    this.detectProgress.classList.toggle("hidden", !running);
    if (running) {
      const p = controller.progress;
      const done = p?.done ?? 0;
      const total = Math.max(1, p?.total ?? 1);
      setText(
        this.detectText,
        `Test ${Math.min(total, done + 1)} of ${total}: the image changes during the tests while the camera holds still. Just a few seconds.`,
      );
      setText(this.detectMeta, `Target: ${controller.detectionTarget()} FPS on this map.`);
      this.detectFill.style.transform = `scaleX(${Math.min(1, done / total)})`;
      this.detectProgress.setAttribute("aria-valuenow", String(Math.round((100 * done) / total)));
      setText(this.detectBtn, "Cancel");
      return;
    }
    const auto = controller.autoResult();
    setText(this.detectBtn, auto ? "Run again" : "Run detection");
    if (auto) {
      setText(this.detectText, auto.summary || "Settings measured on this PC.");
      const date = isoDate(auto.at);
      const stale = auto.targetFps !== controller.detectionTarget() ? " — the target changed since, run it again" : "";
      setText(this.detectMeta, `Measured${date ? ` on ${date}` : ""} for ${auto.targetFps} FPS${stale}.`);
    } else {
      setText(
        this.detectText,
        "Tests this PC on the current map and picks the best look that holds the target, with headroom for fights: 60 FPS at least, plus your screen's refresh rate as long as the image stays at least as good as the original. Never below the quality floor (the old LOW preset).",
      );
      setText(this.detectMeta, `Target: ${controller.detectionTarget()} FPS. Takes a few seconds; the image changes during the tests.`);
    }
  }

  // ----------------------------------------------------------- crosshair

  private buildCrosshair(pane: HTMLElement): void {
    const { sounds, store } = this.deps;
    const update = (change: (c: CrosshairSettings) => void): void => {
      store.update((d) => change(d.crosshair));
    };
    const sec = this.section(pane, "Crosshair", "The game's crosshair is hidden in menus, so here is a preview on a light and on a dark background.");
    const preview = el("div", "gs-ch-preview");
    preview.setAttribute("aria-hidden", "true");
    const sample = (bg: string): HTMLElement => {
      const cell = el("div", `gs-ch-cell ${bg}`);
      const ch = el("div", "gs-ch");
      for (let i = 0; i < 4; i++) {
        const tick = el("i", "gs-ch-tick");
        tick.style.setProperty("--r", `${i * 90}deg`);
        ch.appendChild(tick);
      }
      cell.appendChild(ch);
      preview.appendChild(cell);
      return ch;
    };
    const previews = [sample("light"), sample("dark")];
    sec.appendChild(preview);

    const shape = new Segmented<CrosshairShape>("Crosshair shape", SHAPES, (v) => update((c) => void (c.shape = v)), sounds);
    this.row(sec, "Shape", "Sticker: a dot and four ticks that react when you shoot. Dot or cross: classic and static.", shape.el);
    const size = new Slider(
      "Crosshair size",
      { min: CROSSHAIR_SCALE_MIN * 100, max: CROSSHAIR_SCALE_MAX * 100, step: 5 },
      (v) => formatPercent(v),
      (v) => update((c) => void (c.scale = v / 100)),
    );
    this.row(sec, "Crosshair size", "Size of the crosshair and hit markers.", size.el);
    const colorWrap = el("div", "gs-color");
    const color = el("input", "gs-color-input");
    color.type = "color";
    color.setAttribute("aria-label", "Crosshair color");
    const reset = el("button", "gs-btn gs-btn-small", "Reset");
    reset.type = "button";
    reset.title = "Back to the default cream";
    colorWrap.append(color, reset);
    color.addEventListener("input", () => update((c) => void (c.color = color.value)));
    reset.addEventListener("click", () => {
      sounds.click();
      update((c) => void (c.color = DEFAULT_CROSSHAIR.color));
    });
    this.row(sec, "Crosshair color", "Color of the dot and the ticks.", colorWrap);
    const contrast = new Segmented<boolean>("High contrast", yesNo(), (v) => update((c) => void (c.highContrast = v)), sounds);
    this.row(sec, "High contrast", "A thicker outline, for bright or busy backgrounds.", contrast.el);
    const motion = new Segmented<boolean>("Reduced motion", yesNo(), (v) => update((c) => void (c.reducedMotion = v)), sounds);
    this.row(sec, "Reduced motion", "The crosshair stops moving when you shoot or aim: simple fades instead.", motion.el);

    this.refreshers.push(() => {
      const c = this.record.crosshair;
      shape.set(c.shape);
      size.set(Math.round(c.scale * 100));
      if (color.value.toLowerCase() !== c.color) color.value = c.color;
      contrast.set(c.highContrast);
      motion.set(c.reducedMotion);
      for (const p of previews) {
        p.dataset.shape = c.shape;
        p.classList.toggle("contrast", c.highContrast);
        p.style.setProperty("--ch-scale", String(c.scale));
        p.style.setProperty("--ch-color", c.color);
      }
    });
  }

  // --------------------------------------------------------------- audio

  private buildAudio(pane: HTMLElement): void {
    const { sounds } = this.deps;
    const sec = this.section(pane, "Volume");
    for (const def of VOLUME_ROWS) {
      const slider = new Slider(
        def.label,
        { min: 0, max: 100, step: 1 },
        (v) => formatPercent(v),
        (v) => {
          audio.setUserVolume(def.bus, v / 100);
          for (const linked of def.linked ?? []) audio.setUserVolume(linked, v / 100);
        },
      );
      // A soft click on release gives instant audible feedback (buses the UI sounds go through).
      slider.input.addEventListener("change", () => {
        if (def.bus === "master" || def.bus === "ui") sounds.click();
      });
      this.row(sec, def.label, def.desc, slider.el);
      this.refreshers.push(() => slider.set(Math.round(audio.getUserVolume(def.bus) * 100)));
    }
  }

  // -------------------------------------------------------------- reload

  private refreshReloadBar(): void {
    const changes = this.deps.controller.pendingReload();
    this.reloadBar.classList.toggle("hidden", changes.length === 0);
    if (changes.length === 0) {
      this.reloadArmed = false;
      setText(this.reloadBtn, "Apply & reload");
      return;
    }
    const list = changes.map((c) => `${SETTING_NAMES[c.key]}: ${valueLabel(c.key, c.to as never).toLowerCase()}`).join(", ");
    setText(this.reloadText, `On the next page load: ${list}. These settings change the shaders, so they can't apply live.`);
    const inMatch = this.deps.isInMatch();
    this.reloadWarn.classList.toggle("hidden", !inMatch);
    if (!this.reloadArmed) setText(this.reloadBtn, "Apply & reload");
  }

  private onReload(): void {
    this.deps.sounds.click();
    if (this.deps.isInMatch() && !this.reloadArmed) {
      this.reloadArmed = true;
      setText(this.reloadBtn, "Leave match & reload");
      return;
    }
    try {
      sessionStorage.setItem(REOPEN_KEY, "graphics");
    } catch {
      /* no session storage: the page simply does not reopen */
    }
    this.reloadBtn.disabled = true;
    setText(this.reloadBtn, "Reloading…");
    window.setTimeout(() => window.location.reload(), 120);
  }

  // --------------------------------------------------------------- meter

  private updateMeter(): void {
    const perf = this.deps.game.livePerf();
    const { controller } = this.deps;
    const target = controller.detectionTarget();
    const cap = controller.capFps();
    const goal = Math.min(target, cap);
    setText(this.meterTarget, `target ${goal}`);
    setText(this.meterDevice, this.deps.game.gpuName || "Unknown graphics card");
    this.meterGpuRow.classList.toggle("hidden", !perf || perf.gpuMs === null);
    if (!perf) {
      setText(this.meterNum, "—");
      setText(this.meterStatus, "Waiting for frames…");
      this.meter.dataset.state = "idle";
      return;
    }
    const fps = Math.round(perf.fps);
    setText(this.meterNum, String(fps));
    const detecting = controller.detecting;
    const ok = perf.fps >= goal * 0.97;
    this.meter.dataset.state = detecting ? "busy" : ok ? "ok" : "below";
    setText(
      this.meterStatus,
      detecting ? "Detection running: testing under load" : ok ? "On target" : `Below target (${goal} FPS)`,
    );
    setText(this.meterFrame, `${formatNumber(perf.frameMs, 1)} ms`);
    setText(this.meterSlow, `${formatNumber(perf.frameP95, 1)} ms`);
    setText(this.meterCpu, `${formatNumber(perf.cpuMs, 1)} ms`);
    if (perf.gpuMs !== null) setText(this.meterGpu, `≈ ${formatNumber(perf.gpuMs, 1)} ms`);
    setText(this.meterSize, `${perf.width} × ${perf.height}`);
  }

  /** Re-renders every control from the store (and the detection state). */
  refresh(): void {
    for (const r of this.refreshers) r();
  }
}

function yesNo(): Option<boolean>[] {
  return [
    { value: true, label: "On" },
    { value: false, label: "Off" },
  ];
}

/** Locale-neutral date of a stored detection: "2026-10-21" ("" when unknown). */
function isoDate(at: number): string {
  const d = new Date(at);
  if (!Number.isFinite(d.getTime())) return "";
  const pad = (n: number): string => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function chip(row: Row, on: boolean): void {
  row.reload.classList.toggle("hidden", !on);
}

function note(row: Row, text: string): void {
  setText(row.note, text);
  row.note.classList.toggle("hidden", text === "");
}
