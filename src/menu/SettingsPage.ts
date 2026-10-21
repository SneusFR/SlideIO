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
  frNumber,
  frPercent,
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
  { id: "graphics", label: "Graphismes" },
  { id: "crosshair", label: "Réticule" },
  { id: "audio", label: "Audio" },
];

/** Cost of an option for the frame time: 1 bean = faible … 3 = fort. */
type Cost = 1 | 2 | 3;
const COST_WORDS: Record<Cost, string> = { 1: "faible", 2: "moyen", 3: "fort" };

const PRESET_HINTS: Record<PresetChoice, string> = {
  auto: "Mesuré sur ce PC et cette carte : le plus beau rendu qui tient l'objectif d'images par seconde, avec de la marge pour les combats.",
  bas: "L'ancien préréglage LOW : FXAA, ombres statiques, un pixel par pixel d'écran. Pour les puces graphiques intégrées.",
  moyen: "MSAA 2×, ombres dynamiques de taille moyenne, filtrage 4×. Pour les petites cartes graphiques.",
  eleve: "L'ancien préréglage HIGH : MSAA 4×, ombres dynamiques détaillées, filtrage 8×.",
  ultra: "Pleine définition même sur un écran haute densité, ombres très fines, filtrage 16×, neige dense. Pour les cartes puissantes.",
  custom: "Tes propres réglages, option par option. Choisis un préréglage pour revenir à un ensemble prêt.",
};

const VOLUME_ROWS: { bus: AudioBus; label: string; desc: string; linked?: AudioBus[] }[] = [
  { bus: "master", label: "Volume général", desc: "Tous les sons du jeu." },
  // Weapon IMPACT sounds (hammer hits, explosions…) live on the "impacts" bus
  // but belong to the weapon volume from the player's point of view.
  { bus: "weapons", label: "Armes", desc: "Tirs, rechargements et impacts.", linked: ["impacts"] },
  { bus: "music", label: "Musique", desc: "La musique du menu." },
  { bus: "ambience", label: "Ambiance", desc: "Les sons de la carte." },
];

const SHAPES: { value: CrosshairShape; label: string }[] = [
  { value: "STICKER", label: "Sticker" },
  { value: "DOT", label: "Point" },
  { value: "CROSS", label: "Croix" },
];

/** Session storage flag: reopen the page after « Appliquer et recharger ». */
export const REOPEN_KEY = "slideio.reopenSettings";

/** French typography: no-break spaces before « : », and narrow ones before « ; ! ? » and inside « ». */
function fr(text: string): string {
  return text
    .replace(/ :/g, "\u00a0:")
    .replace(/ ([;!?])/g, "\u202f$1")
    .replace(/« /g, "«\u00a0")
    .replace(/ »/g, "\u00a0»");
}

/** Small DOM builder: tag, class, text. */
function el<K extends keyof HTMLElementTagNameMap>(tag: K, className = "", text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = fr(text);
  return node;
}

function setText(node: HTMLElement, text: string): void {
  const t = fr(text);
  if (node.textContent !== t) node.textContent = t;
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

  /** Options whose labels / availability depend on the state (frame cap « Auto (60) »…). */
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
      if (option.title) button.title = fr(option.title);
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
    const text = fr(this.format(v));
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
 * at the bottom, « Appliquer et recharger »).
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
    const title = el("h2", "gs-title", "Paramètres");
    title.id = "gs-title";
    const subtitle = el("p", "gs-subtitle", "Tout s'applique tout de suite");
    // (Narrow windows: the panel covers the map — the hint goes, see the CSS.)
    subtitle.append(el("span", "gs-subtitle-side", " — regarde la carte à droite"), ".");
    titleWrap.append(title, subtitle);
    const back = el("button", "gs-back", "Retour");
    back.type = "button";
    back.title = "Retour (Échap)";
    back.addEventListener("pointerenter", () => deps.sounds.hover());
    back.addEventListener("click", () => {
      deps.sounds.click();
      this.close();
    });
    head.append(titleWrap, back);

    const tabs = el("nav", "gs-tabs");
    tabs.setAttribute("role", "tablist");
    tabs.setAttribute("aria-label", "Catégories");
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
    this.reloadWarn = el("p", "gs-reload-warn", "Recharger quitte la partie en cours.");
    reloadCopy.append(this.reloadText, this.reloadWarn);
    this.reloadBtn = el("button", "gs-btn gs-btn-gold", "Appliquer et recharger");
    this.reloadBtn.type = "button";
    this.reloadBtn.addEventListener("click", () => this.onReload());
    this.reloadBar.append(reloadCopy, this.reloadBtn);

    panel.append(head, tabs, this.body, this.reloadBar);

    // Live card (the live view's corner).
    this.meter = el("aside", "gs-meter");
    this.meter.setAttribute("aria-label", "Mesure en direct");
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
      dt.title = fr(hint);
      const dd = el("dd", "", "—");
      wrap.append(dt, dd);
      rows.appendChild(wrap);
      return { row: wrap, dd };
    };
    this.meterFrame = metric("Image", "Temps médian entre deux images affichées").dd;
    this.meterSlow = metric("Images lentes", "Les 5 % d'images les plus lentes : ce qu'on ressent comme des saccades").dd;
    this.meterCpu = metric("Processeur (jeu)", "Temps du jeu sur le processeur, par image").dd;
    const gpu = metric("Carte graphique", "Indicatif : mesuré par les requêtes de chronométrage du mode debug (?gpu)");
    this.meterGpuRow = gpu.row;
    this.meterGpu = gpu.dd;
    this.meterSize = metric("Rendu", "Taille de l'image 3D calculée, en pixels").dd;
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
      chip.setAttribute("aria-label", `Impact ${COST_WORDS[cost]} sur les images par seconde`);
      chip.title = `Impact ${COST_WORDS[cost]} sur les images par seconde`;
      for (let i = 0; i < 3; i++) chip.appendChild(el("i", i < cost ? "full" : ""));
      chip.appendChild(el("span", "gs-cost-word", COST_WORDS[cost]));
      head.appendChild(chip);
    }
    const reload = el("span", "gs-chip-reload hidden", "Au rechargement");
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

  /** Edit one graphics value: "Personnalisé" (or the preset these values are exactly). */
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
    // "Automatique" means MEASURED: no up-to-date measurement here → now.
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
    const presetSec = this.section(fieldset, "Préréglage");
    const presetSeg = new Segmented<PresetChoice>(
      "Préréglage",
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
    const detectTitle = el("p", "gs-detect-title", "Détection automatique");
    this.detectText = el("p", "gs-detect-text");
    this.detectMeta = el("p", "gs-detect-meta");
    this.detectProgress = el("div", "gs-detect-progress hidden");
    this.detectProgress.setAttribute("role", "progressbar");
    this.detectProgress.setAttribute("aria-label", "Progression de la détection");
    this.detectFill = el("div", "gs-detect-fill");
    this.detectProgress.appendChild(this.detectFill);
    detectCopy.append(detectTitle, this.detectText, this.detectMeta, this.detectProgress);
    const detectSide = el("div", "gs-detect-side");
    this.detectBtn = el("button", "gs-btn", "Lancer la détection");
    this.detectBtn.type = "button";
    this.detectBtn.addEventListener("pointerenter", () => sounds.hover());
    this.detectBtn.addEventListener("click", () => {
      sounds.click();
      if (this.deps.controller.detecting) this.deps.controller.cancelDetection();
      else this.startDetection();
    });
    const targetWrap = el("div", "gs-detect-target");
    const targetLabel = el("span", "gs-detect-target-label", "Objectif");
    const targetSeg = new Segmented<FpsTargetSetting>(
      "Objectif de la détection",
      [],
      (t) => {
        this.deps.store.update((d) => {
          d.fpsTarget = t;
        });
        // "Automatique" measured for the old target: measure again for the new one.
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
      "Résolution de rendu",
      { min: RENDER_SCALE_MIN, max: RENDER_SCALE_MAX, step: RENDER_SCALE_STEP },
      (v) => frPercent(v),
      (v) => this.edit("renderScale", v),
      150,
    );
    const scaleRow = this.row(
      image,
      "Résolution de rendu",
      "Le nombre de pixels calculés, en % de la définition de ton écran. Moins : beaucoup plus rapide, un peu plus flou. Au-delà de 100 % : suréchantillonnage, pour les cartes puissantes.",
      scale.el,
      3,
    );
    const scalePx = el("p", "gs-row-sub");
    scaleRow.control.appendChild(scalePx);

    const aa = new Segmented<AntiAliasing>("Anticrénelage", [], (v) => this.edit("antialiasing", v), sounds);
    const aaRow = this.row(
      image,
      "Anticrénelage",
      "Lisse les bords en escalier. FXAA coûte peu ; le MSAA est plus net, mais lourd pour une puce graphique intégrée.",
      aa.el,
      3,
    );

    // ---- Shadows ----
    const shadowsSec = this.section(fieldset, "Ombres");
    const shadows = new Segmented<ShadowMode>(
      "Ombres",
      (["off", "static", "dynamic"] as const).map((v) => ({ value: v, label: SHADOW_LABELS[v] })),
      (v) => this.edit("shadows", v),
      sounds,
    );
    const shadowsRow = this.row(
      shadowsSec,
      "Ombres",
      "Statiques : les ombres de la carte, calculées une fois au chargement. Dynamiques : recalculées à chaque image, avec celles des personnages.",
      shadows.el,
      2,
    );
    const quality = new Segmented<ShadowQuality>("Qualité des ombres", [], (v) => this.edit("shadowQuality", v), sounds);
    const qualityRow = this.row(
      shadowsSec,
      "Qualité des ombres",
      "La taille de la carte d'ombres : des bords d'ombre plus nets. Avec les ombres dynamiques, elle se paie à chaque image.",
      quality.el,
      2,
    );
    const chars = new Segmented<boolean>("Ombres des personnages", yesNo(), (on) => this.edit("characterShadows", on), sounds);
    const charsRow = this.row(
      shadowsSec,
      "Ombres des personnages",
      "Les personnages, leurs armes et les cibles mobiles projettent leur ombre au sol (avec les ombres dynamiques).",
      chars.el,
      2,
    );

    // ---- Effects ----
    const fx = this.section(fieldset, "Effets");
    const snow = new Segmented<SnowLevel>(
      "Neige",
      (["off", "legere", "normale", "dense"] as const).map((v) => ({ value: v, label: SNOW_LABELS[v] })),
      (v) => this.edit("snow", v),
      sounds,
    );
    const snowRow = this.row(fx, "Neige", "Les flocons qui tombent sur Givre.", snow.el, 1);
    const halos = new Segmented<boolean>("Halos des lumières", yesNo(), (on) => this.edit("halos", on), sounds);
    const halosRow = this.row(fx, "Halos des lumières", "La lueur autour des ampoules et des lanternes de Givre.", halos.el, 1);
    const prints = new Segmented<boolean>("Empreintes dans la neige", yesNo(), (on) => this.edit("footprints", on), sounds);
    const printsRow = this.row(fx, "Empreintes dans la neige", "Les traces de pas laissées dans la neige de Givre.", prints.el, 1);
    const particles = new Segmented<ParticleDensity>(
      "Particules",
      (["normal", "reduced"] as const).map((v) => ({ value: v, label: PARTICLE_LABELS[v] })),
      (v) => this.edit("particles", v),
      sounds,
    );
    this.row(fx, "Particules", "Étincelles et éclats des impacts, des explosions et des coups de masse.", particles.el, 1);
    const aniso = new Segmented<Anisotropy>("Filtrage anisotrope", [], (v) => this.edit("anisotropy", v), sounds);
    const anisoRow = this.row(fx, "Filtrage anisotrope", "Garde les sols et les murs nets quand on les voit de biais.", aniso.el, 1);

    // ---- Performance ----
    const rate = this.section(fieldset, "Performances");
    const cap = new Segmented<FpsCapSetting>(
      "Limite d'images par seconde",
      [],
      (v) => this.deps.store.update((d) => void (d.fpsCap = v)),
      sounds,
      "gs-seg-wrap",
    );
    const capRow = this.row(rate, "Limite d'images par seconde", "", cap.el);
    const panel = new Segmented<PerfPanelMode>(
      "Panneau de performances",
      [
        { value: "full", label: "Complet" },
        { value: "fps", label: "FPS seulement" },
        { value: "off", label: "Masqué" },
      ],
      (v) => this.deps.store.update((d) => void (d.perfPanel = v)),
      sounds,
    );
    this.row(rate, "Panneau de performances", "Le panneau de mesures en haut à gauche, en partie. Masqué, il ne coûte plus rien.", panel.el);

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
      setText(scalePx, `${w} × ${h} pixels · écran ${nw} × ${nh}`);
      note(scaleRow, v.renderScale < floorRenderScale(env) - 0.5 ? "Sous le plancher de la détection" : "");
      aa.setOptions(
        (["none", "fxaa", "msaa2", "msaa4"] as AntiAliasing[]).map((a) => {
          const off = (!caps.composer && (a === "fxaa" || a === "msaa2")) || (a === "msaa2" && caps.maxSamples < 2) || (a === "msaa4" && caps.maxSamples < 4);
          return {
            value: a,
            label: AA_LABELS[a],
            disabled: off,
            title: off ? (caps.composer ? "Non pris en charge par cette carte graphique" : "Sur Givre seulement") : undefined,
          };
        }),
      );
      aa.set(caps.composer ? v.antialiasing : v.antialiasing === "msaa2" ? "msaa4" : v.antialiasing === "fxaa" ? "none" : v.antialiasing);
      note(aaRow, caps.composer ? "" : "Ici, MSAA au rechargement");
      // Shadows
      shadows.set(v.shadows);
      quality.setOptions(
        SHADOW_QUALITIES.map((q) => {
          const off = SHADOW_QUALITIES.indexOf(q) > SHADOW_QUALITIES.indexOf(caps.maxShadowQuality);
          return { value: q, label: SHADOW_QUALITY_LABELS[q], disabled: off, title: off ? "Trop grande pour cette carte graphique" : undefined };
        }),
      );
      quality.set(v.shadowQuality);
      quality.setEnabled(v.shadows !== "off");
      note(qualityRow, v.shadows === "off" ? "Sans ombres" : "");
      chars.set(v.characterShadows);
      chars.setEnabled(v.shadows === "dynamic");
      note(charsRow, v.shadows === "dynamic" ? "" : "Avec les ombres dynamiques");
      // Effects
      snow.set(v.snow);
      halos.set(v.halos);
      prints.set(v.footprints);
      particles.set(v.particles);
      aniso.setOptions(
        ANISOTROPY_LEVELS.map((a) => {
          const off = a > Math.max(1, caps.maxAnisotropy);
          return { value: a, label: ANISOTROPY_LABELS[a], disabled: off, title: off ? "Au-delà du maximum de cette carte graphique" : undefined };
        }),
      );
      aniso.set(v.anisotropy);
      note(snowRow, caps.snow ? "" : "Sur Givre");
      note(halosRow, caps.halos ? "" : "Sur Givre");
      note(printsRow, caps.footprints ? "" : "Sur Givre");
      note(anisoRow, caps.anisotropicTextures ? "" : "Visible sur Givre");
      // Performance
      const effectivePreset = controller.effectivePreset();
      cap.setOptions(FPS_CAPS.map((c) => ({ value: c, label: fpsCapLabel(c, effectivePreset) })));
      cap.set(record.fpsCap);
      setText(
        capRow.desc,
        `Plafonne les images calculées : moins de chauffe et de bruit sur un portable. Sans limite, le jeu suit ton écran (${hz} Hz).`,
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
    const sec = this.section(parent, "Contours (Givre)");
    const on = new Segmented<boolean>("Contours cel-shading", yesNo(), (v) => store.update((d) => void (d.outline.enabled = v)), sounds);
    this.row(sec, "Contours cel-shading", "Le liseré blanc autour des formes, façon dessin animé.", on.el, 2);
    const thick = new Slider(
      "Épaisseur des contours",
      { min: OUTLINE_THICKNESS_MIN * 100, max: OUTLINE_THICKNESS_MAX * 100, step: 5 },
      (v) => `${frNumber(v / 100, 2)} px`,
      (v) => store.update((d) => void (d.outline.thickness = v / 100)),
    );
    this.row(sec, "Épaisseur", "Largeur du liseré.", thick.el);
    const intensity = new Slider(
      "Intensité des contours",
      { min: 0, max: 100, step: 1 },
      (v) => frPercent(v),
      (v) => store.update((d) => void (d.outline.intensity = v / 100)),
    );
    this.row(sec, "Intensité", "Opacité du liseré.", intensity.el);
    const debug = new Segmented<boolean>("Vue des bords", yesNo(), (v) => controller.setOutlineDebug(v), sounds);
    this.row(sec, "Vue des bords", "Montre seulement les bords détectés (pour régler ; non enregistré).", debug.el);
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
    // (inert: neither clickable nor focusable; the Annuler button stays live).
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
        `Mesure ${Math.min(total, done + 1)} sur ${total} : l'image change pendant les essais, la caméra reste immobile. Quelques secondes.`,
      );
      setText(this.detectMeta, `Objectif : ${controller.detectionTarget()} FPS sur cette carte.`);
      this.detectFill.style.transform = `scaleX(${Math.min(1, done / total)})`;
      this.detectProgress.setAttribute("aria-valuenow", String(Math.round((100 * done) / total)));
      setText(this.detectBtn, "Annuler");
      return;
    }
    const auto = controller.autoResult();
    setText(this.detectBtn, auto ? "Relancer la détection" : "Lancer la détection");
    if (auto) {
      setText(this.detectText, auto.summary || "Réglages mesurés sur ce PC.");
      const when = new Date(auto.at);
      const date = Number.isFinite(when.getTime())
        ? when.toLocaleDateString("fr-FR", { day: "numeric", month: "long" })
        : "";
      const stale = auto.targetFps !== controller.detectionTarget() ? " — objectif changé depuis : relance-la" : "";
      setText(this.detectMeta, `Mesuré${date ? ` le ${date}` : ""} pour ${auto.targetFps} FPS${stale}.`);
    } else {
      setText(
        this.detectText,
        "Mesure ce PC sur la carte en cours et choisit le plus beau rendu qui tient l'objectif, avec de la marge pour les combats : 60 FPS au moins, et la fréquence de l'écran tant que l'image reste au moins celle d'origine. Jamais sous le plancher de qualité (l'ancien préréglage LOW).",
      );
      setText(this.detectMeta, `Objectif : ${controller.detectionTarget()} FPS. Quelques secondes ; l'image change pendant les essais.`);
    }
  }

  // ----------------------------------------------------------- crosshair

  private buildCrosshair(pane: HTMLElement): void {
    const { sounds, store } = this.deps;
    const update = (change: (c: CrosshairSettings) => void): void => {
      store.update((d) => change(d.crosshair));
    };
    const sec = this.section(pane, "Réticule", "Le réticule du jeu est caché dans les menus : voici son aperçu, sur un décor clair et sur un décor sombre.");
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

    const shape = new Segmented<CrosshairShape>("Forme", SHAPES, (v) => update((c) => void (c.shape = v)), sounds);
    this.row(sec, "Forme", "Sticker : point et quatre traits qui bougent au tir. Point ou croix : classiques, fixes.", shape.el);
    const size = new Slider(
      "Taille du réticule",
      { min: CROSSHAIR_SCALE_MIN * 100, max: CROSSHAIR_SCALE_MAX * 100, step: 5 },
      (v) => frPercent(v),
      (v) => update((c) => void (c.scale = v / 100)),
    );
    this.row(sec, "Taille", "Taille du réticule et des marqueurs d'impact.", size.el);
    const colorWrap = el("div", "gs-color");
    const color = el("input", "gs-color-input");
    color.type = "color";
    color.setAttribute("aria-label", "Couleur du réticule");
    const reset = el("button", "gs-btn gs-btn-small", "Couleur d'origine");
    reset.type = "button";
    colorWrap.append(color, reset);
    color.addEventListener("input", () => update((c) => void (c.color = color.value)));
    reset.addEventListener("click", () => {
      sounds.click();
      update((c) => void (c.color = DEFAULT_CROSSHAIR.color));
    });
    this.row(sec, "Couleur", "La couleur du point et des traits.", colorWrap);
    const contrast = new Segmented<boolean>("Contraste élevé", yesNo(), (v) => update((c) => void (c.highContrast = v)), sounds);
    this.row(sec, "Contraste élevé", "Contour plus épais, pour les décors clairs ou chargés.", contrast.el);
    const motion = new Segmented<boolean>("Mouvements réduits", yesNo(), (v) => update((c) => void (c.reducedMotion = v)), sounds);
    this.row(sec, "Mouvements réduits", "Le réticule ne bouge plus au tir ni à la visée : de simples fondus.", motion.el);

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
    const sec = this.section(pane, "Volumes");
    for (const def of VOLUME_ROWS) {
      const slider = new Slider(
        def.label,
        { min: 0, max: 100, step: 1 },
        (v) => frPercent(v),
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
      setText(this.reloadBtn, "Appliquer et recharger");
      return;
    }
    const list = changes.map((c) => `${SETTING_NAMES[c.key]} : ${valueLabel(c.key, c.to as never).toLowerCase()}`).join(", ");
    setText(this.reloadText, `Au prochain chargement de la page — ${list}. Ces réglages changent les shaders : ils ne s'appliquent pas en direct.`);
    const inMatch = this.deps.isInMatch();
    this.reloadWarn.classList.toggle("hidden", !inMatch);
    if (!this.reloadArmed) setText(this.reloadBtn, "Appliquer et recharger");
  }

  private onReload(): void {
    this.deps.sounds.click();
    if (this.deps.isInMatch() && !this.reloadArmed) {
      this.reloadArmed = true;
      setText(this.reloadBtn, "Quitter la partie et recharger");
      return;
    }
    try {
      sessionStorage.setItem(REOPEN_KEY, "graphics");
    } catch {
      /* no session storage: the page simply does not reopen */
    }
    this.reloadBtn.disabled = true;
    setText(this.reloadBtn, "Rechargement…");
    window.setTimeout(() => window.location.reload(), 120);
  }

  // --------------------------------------------------------------- meter

  private updateMeter(): void {
    const perf = this.deps.game.livePerf();
    const { controller } = this.deps;
    const target = controller.detectionTarget();
    const cap = controller.capFps();
    const goal = Math.min(target, cap);
    setText(this.meterTarget, `objectif ${goal}`);
    setText(this.meterDevice, this.deps.game.gpuName || "Carte graphique inconnue");
    this.meterGpuRow.classList.toggle("hidden", !perf || perf.gpuMs === null);
    if (!perf) {
      setText(this.meterNum, "—");
      setText(this.meterStatus, "En attente d'images…");
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
      detecting ? "Détection en cours : mesures sous charge" : ok ? "Objectif tenu" : `Sous l'objectif (${goal} FPS)`,
    );
    setText(this.meterFrame, `${frNumber(perf.frameMs, 1)} ms`);
    setText(this.meterSlow, `${frNumber(perf.frameP95, 1)} ms`);
    setText(this.meterCpu, `${frNumber(perf.cpuMs, 1)} ms`);
    if (perf.gpuMs !== null) setText(this.meterGpu, `≈ ${frNumber(perf.gpuMs, 1)} ms`);
    setText(this.meterSize, `${perf.width} × ${perf.height}`);
  }

  /** Re-renders every control from the store (and the detection state). */
  refresh(): void {
    for (const r of this.refreshers) r();
  }
}

function yesNo(): Option<boolean>[] {
  return [
    { value: true, label: "Oui" },
    { value: false, label: "Non" },
  ];
}

function chip(row: Row, on: boolean): void {
  row.reload.classList.toggle("hidden", !on);
}

function note(row: Row, text: string): void {
  setText(row.note, text);
  row.note.classList.toggle("hidden", text === "");
}
