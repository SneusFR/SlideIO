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
  type AntiAliasing,
  type DisplayEnv,
  type FpsCapSetting,
  type FpsTargetSetting,
  type GraphicsCaps,
  type GraphicsKey,
  type GraphicsValues,
  type PresetChoice,
} from "../settings/GraphicsSettings";
import {
  AA_LABELS,
  ANISOTROPY_LABELS,
  EFFECT_LIGHT_LABELS,
  PARTICLE_LABELS,
  PRESET_LABELS,
  SETTING_NAMES,
  SHADOW_LABELS,
  SHADOW_QUALITY_LABELS,
  SNOW_LABELS,
  fpsCapLabel,
  frNumber,
  frPercent,
  valueLabel,
} from "../settings/labels";
import type { GraphicsController, DetectionEvent } from "../settings/GraphicsController";
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
  acquireFrameMeter(): () => void;
  livePerf(): (LiveStats & { width: number; height: number; gpuTimer: boolean }) | null;
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

export type SettingsTab = "graphics" | "crosshair" | "display" | "audio";

const TABS: { id: SettingsTab; label: string }[] = [
  { id: "graphics", label: "Graphismes" },
  { id: "crosshair", label: "Réticule" },
  { id: "display", label: "Affichage" },
  { id: "audio", label: "Audio" },
];

/** Cost of an option for the frame time: 1 bean = faible … 3 = fort. */
type Cost = 1 | 2 | 3;
const COST_WORDS: Record<Cost, string> = { 1: "faible", 2: "moyen", 3: "fort" };

const PRESET_HINTS: Record<PresetChoice, string> = {
  auto: "Mesuré sur ce PC : le plus beau rendu qui tient l'objectif d'images par seconde.",
  bas: "Pour les portables et les puces graphiques intégrées : FXAA, ombres statiques.",
  moyen: "Pour les petites cartes graphiques : MSAA 2×, ombres dynamiques.",
  eleve: "Le rendu complet du jeu : MSAA 4×, ombres dynamiques détaillées.",
  ultra: "Pour les cartes puissantes : pleine définition, ombres très fines, neige dense.",
  custom: "Tes propres réglages. Choisis un préréglage pour revenir à un ensemble prêt.",
};

const VOLUME_ROWS: { bus: AudioBus; label: string; linked?: AudioBus[] }[] = [
  { bus: "master", label: "Volume général" },
  // Weapon IMPACT sounds (hammer hits, explosions…) live on the "impacts" bus
  // but belong to the weapon volume from the player's point of view.
  { bus: "weapons", label: "Armes", linked: ["impacts"] },
  { bus: "music", label: "Musique" },
  { bus: "ambience", label: "Ambiance" },
];

const SHAPES: { value: CrosshairShape; label: string }[] = [
  { value: "STICKER", label: "Sticker" },
  { value: "DOT", label: "Point" },
  { value: "CROSS", label: "Croix" },
];

/** Session storage flag: reopen the page after « Appliquer et recharger ». */
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
      if (option.title) button.title = option.title;
      button.addEventListener("pointerenter", () => this.sounds.hover());
      button.addEventListener("click", () => {
        if (button.disabled || button.getAttribute("aria-disabled") === "true") return;
        this.sounds.click();
        this.onPick(option.value);
      });
      this.buttons.push({ option, button });
      this.el.appendChild(button);
    }
  }

  /** Options whose labels / availability depend on the state (FPS cap « Automatique (60) »…). */
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
    if (!force && value === this.value) {
      this.syncDisabled();
      return;
    }
    this.value = value;
    for (const { option, button } of this.buttons) {
      const on = option.value === value;
      button.setAttribute("aria-checked", on ? "true" : "false");
      button.tabIndex = on ? 0 : -1;
      button.classList.toggle("on", on);
    }
    // No option selected (value outside the list): the first one takes the focus stop.
    if (!this.buttons.some((b) => b.option.value === value) && this.buttons[0]) this.buttons[0].button.tabIndex = 0;
    this.syncDisabled();
  }

  private syncDisabled(): void {
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
      setText(this.out, this.format(v));
      this.paint(v);
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
    setText(this.out, this.format(v));
    this.paint(v);
  }

  setEnabled(on: boolean): void {
    this.input.disabled = !on;
    this.el.classList.toggle("disabled", !on);
  }

  /** Filled part of the track (CSS custom property on the input only). */
  private paint(v: number): void {
    const min = Number(this.input.min);
    const max = Number(this.input.max);
    const f = max > min ? (v - min) / (max - min) : 0;
    this.input.style.setProperty("--fill", `${Math.round(f * 1000) / 10}%`);
  }
}

interface Row {
  el: HTMLDivElement;
  desc: HTMLParagraphElement;
  note: HTMLSpanElement;
  reload: HTMLSpanElement;
}

/**
 * THE SETTINGS PAGE — graphics (presets, every option with its cost, the
 * automatic detection), crosshair, display, audio. Opened from the main
 * menu and from the pause menu (the same overlay); the live game view stays
 * visible on the right so every change is seen — and measured, on the frame
 * budget card — as it happens. Changes apply at once, except the few that
 * need a reload (listed at the bottom, « Appliquer et recharger »).
 */
export class SettingsPage {
  /** Opened / closed (the menu hides its own UI while the page is up). */
  onOpenChange: ((open: boolean) => void) | null = null;

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
  private releaseMeter: (() => void) | null = null;
  private meterTimer: number | null = null;
  private lastFocus: HTMLElement | null = null;
  private graphicsFieldset!: HTMLFieldSetElement;
  // Meter card
  private readonly meter: HTMLElement;
  private readonly meterNum: HTMLElement;
  private readonly meterTarget: HTMLElement;
  private readonly meterFill: HTMLElement;
  private readonly meterBar: HTMLElement;
  private readonly meterGpu: HTMLElement;
  private readonly meterCpu: HTMLElement;
  private readonly meterSize: HTMLElement;
  private readonly meterDevice: HTMLElement;
  private readonly meterBarLabel: HTMLElement;
  // Detection block
  private detectText!: HTMLParagraphElement;
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
    const title = el("h2", "gs-title", "Paramètres");
    title.id = "gs-title";
    const back = el("button", "gs-back", "Retour");
    back.type = "button";
    back.addEventListener("pointerenter", () => deps.sounds.hover());
    back.addEventListener("click", () => {
      deps.sounds.click();
      this.close();
    });
    head.append(title, back);

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

    // Frame budget card (the live view's corner).
    this.meter = el("aside", "gs-meter");
    this.meter.setAttribute("aria-label", "Mesure en direct");
    const top = el("div", "gs-meter-top");
    this.meterNum = el("span", "gs-meter-num", "—");
    const unit = el("span", "gs-meter-unit", "i/s");
    this.meterTarget = el("span", "gs-meter-target");
    top.append(this.meterNum, unit, this.meterTarget);
    this.meterBarLabel = el("div", "gs-meter-bar-label");
    this.meterBar = el("div", "gs-meter-bar");
    this.meterFill = el("div", "gs-meter-fill");
    const mark = el("div", "gs-meter-mark");
    mark.title = "Marge de la détection automatique : 80 % du temps d'une image";
    this.meterBar.append(this.meterFill, mark);
    const rows = el("dl", "gs-meter-rows");
    const metric = (label: string): HTMLElement => {
      const wrap = el("div");
      const dd = el("dd", "", "—");
      wrap.append(el("dt", "", label), dd);
      rows.appendChild(wrap);
      return dd;
    };
    this.meterGpu = metric("Carte graphique");
    this.meterCpu = metric("Processeur");
    this.meterSize = metric("Rendu");
    this.meterDevice = el("p", "gs-meter-device");
    this.meter.append(top, this.meterBarLabel, this.meterBar, rows, this.meterDevice);

    this.root.append(panel, this.meter);

    this.buildGraphics(this.panes.get("graphics")!);
    this.buildCrosshair(this.panes.get("crosshair")!);
    this.buildDisplay(this.panes.get("display")!);
    this.buildAudio(this.panes.get("audio")!);
    this.showTab("graphics");

    deps.store.subscribe(() => this.refresh());
    deps.controller.subscribe((e) => this.onDetection(e));
    document.addEventListener("keydown", (e) => {
      if (!this.openState) return;
      if (e.key === "Escape") {
        e.preventDefault();
        this.close();
      }
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
    // GPU times for the card while the page is up (a timer query per frame).
    this.releaseMeter = this.deps.game.acquireFrameMeter();
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
    this.releaseMeter?.();
    this.releaseMeter = null;
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

  private section(parent: HTMLElement, title: string): HTMLElement {
    const s = el("section", "gs-section");
    s.appendChild(el("h3", "gs-section-title", title));
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
      chip.setAttribute("aria-label", `Impact ${COST_WORDS[cost]} sur les performances`);
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
    return { el: r, desc: p, note, reload };
  }

  /** Edit one graphics value: "Personnalisé" (or the preset these values are exactly). */
  private edit<K extends GraphicsKey>(key: K, value: GraphicsValues[K]): void {
    const { controller, store } = this.deps;
    const env = this.deps.env();
    store.update((d) => {
      d.graphics = editChoice(d.graphics, key, value, env, controller.gpu);
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
    // "Automatique" means MEASURED: no detection for this GPU yet → measure now.
    if (id === "auto" && !controller.autoDetected) void controller.runDetection("manual");
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
      "gs-seg-wide",
    );
    presetSec.appendChild(presetSeg.el);
    const presetHint = el("p", "gs-preset-hint");
    presetSec.appendChild(presetHint);

    const detect = el("div", "gs-detect");
    const detectCopy = el("div", "gs-detect-copy");
    this.detectText = el("p", "gs-detect-text");
    this.detectProgress = el("div", "gs-detect-progress hidden");
    this.detectFill = el("div", "gs-detect-fill");
    this.detectProgress.appendChild(this.detectFill);
    detectCopy.append(this.detectText, this.detectProgress);
    const detectSide = el("div", "gs-detect-side");
    this.detectBtn = el("button", "gs-btn", "Lancer la détection");
    this.detectBtn.type = "button";
    this.detectBtn.addEventListener("pointerenter", () => sounds.hover());
    this.detectBtn.addEventListener("click", () => {
      sounds.click();
      if (this.deps.controller.detecting) this.deps.controller.cancelDetection();
      else void this.deps.controller.runDetection("manual");
    });
    const targetLabel = el("span", "gs-detect-target-label", "Objectif");
    const targetSeg = new Segmented<FpsTargetSetting>(
      "Objectif de la détection",
      [],
      (t) =>
        this.deps.store.update((d) => {
          d.fpsTarget = t;
        }),
      sounds,
      "gs-seg-small",
    );
    detectSide.append(this.detectBtn, targetLabel, targetSeg.el);
    detect.append(detectCopy, detectSide);
    presetSec.appendChild(detect);

    // ---- Image ----
    const image = this.section(fieldset, "Image");
    const scale = new Slider(
      "Résolution de rendu",
      { min: RENDER_SCALE_MIN, max: RENDER_SCALE_MAX, step: RENDER_SCALE_STEP },
      (v) => frPercent(v),
      (v) => this.edit("renderScale", v),
      180,
    );
    const scaleRow = this.row(
      image,
      "Résolution de rendu",
      "Moins de pixels calculés : beaucoup plus rapide, un peu plus flou. 100 % = la définition de ton écran ; au-delà, suréchantillonnage pour les cartes puissantes.",
      scale.el,
      3,
    );
    const scalePx = el("p", "gs-row-sub");
    scaleRow.el.querySelector(".gs-row-control")!.appendChild(scalePx);

    const dyn = new Segmented<boolean>("Résolution dynamique", yesNo(), (on) => this.deps.store.update((d) => void (d.dynamicResolution = on)), sounds);
    const dynRow = this.row(image, "Résolution dynamique", "", dyn.el);

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
    const shadows = new Segmented(
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
    const quality = new Segmented("Qualité des ombres", [], (v: (typeof SHADOW_QUALITIES)[number]) => this.edit("shadowQuality", v), sounds);
    const qualityRow = this.row(shadowsSec, "Qualité des ombres", "Taille de la carte d'ombres : des bords d'ombre plus nets.", quality.el, 1);
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
    const snow = new Segmented(
      "Neige",
      (["off", "legere", "normale", "dense"] as const).map((v) => ({ value: v, label: SNOW_LABELS[v] })),
      (v) => this.edit("snow", v),
      sounds,
    );
    const snowRow = this.row(fx, "Neige", "Les flocons qui tombent sur Givre.", snow.el, 2);
    const halos = new Segmented<boolean>("Halos des lumières", yesNo(), (on) => this.edit("halos", on), sounds);
    const halosRow = this.row(fx, "Halos des lumières", "La lueur autour des ampoules et des lanternes de Givre.", halos.el, 1);
    const prints = new Segmented<boolean>("Empreintes dans la neige", yesNo(), (on) => this.edit("footprints", on), sounds);
    const printsRow = this.row(fx, "Empreintes dans la neige", "Les traces de pas laissées dans la neige de Givre.", prints.el, 1);
    const particles = new Segmented(
      "Particules",
      (["normal", "reduced"] as const).map((v) => ({ value: v, label: PARTICLE_LABELS[v] })),
      (v) => this.edit("particles", v),
      sounds,
    );
    this.row(fx, "Particules", "Étincelles et éclats des impacts et des coups de masse.", particles.el, 1);
    const lights = new Segmented(
      "Lumières des effets",
      ([0, 1, 2] as const).map((v) => ({ value: v, label: EFFECT_LIGHT_LABELS[v] })),
      (v) => this.edit("effectLights", v),
      sounds,
    );
    const lightsRow = this.row(
      fx,
      "Lumières des effets",
      "Tirs et explosions éclairent le décor autour d'eux. Chaque lumière est calculée sur tout l'écran.",
      lights.el,
      1,
    );
    const aniso = new Segmented("Filtrage anisotrope", [], (v: (typeof ANISOTROPY_LEVELS)[number]) => this.edit("anisotropy", v), sounds);
    const anisoRow = this.row(fx, "Filtrage anisotrope", "Garde les sols et les murs nets quand on les voit de biais.", aniso.el, 1);

    // ---- Frame rate ----
    const rate = this.section(fieldset, "Fréquence d'images");
    const cap = new Segmented<FpsCapSetting>(
      "Limite d'images par seconde",
      [],
      (v) => this.deps.store.update((d) => void (d.fpsCap = v)),
      sounds,
      "gs-seg-wrap",
    );
    const capRow = this.row(rate, "Limite d'images par seconde", "", cap.el);

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
      const hz = Math.round(this.deps.refreshHz());
      targetSeg.setOptions(FPS_TARGETS.map((t) => ({ value: t, label: t === "display" ? `Écran (${hz} Hz)` : `${t} i/s` })));
      targetSeg.set(record.fpsTarget);
      // Image
      scale.set(Math.round(v.renderScale * 100) / 100);
      const ratio = pixelRatioFor(v.renderScale, env.dpr);
      const w = Math.floor(window.innerWidth * ratio);
      const h = Math.floor(window.innerHeight * ratio);
      setText(scalePx, `${w} × ${h} pixels`);
      dyn.set(record.dynamicResolution);
      setText(
        dynRow.desc,
        `En partie, baisse la résolution quand les images ralentissent, puis la remonte — jamais sous ${frPercent(
          floorRenderScale(env),
        )}. Objectif : ${controller.playTarget()} i/s.`,
      );
      aa.setOptions(
        (["none", "fxaa", "msaa2", "msaa4"] as AntiAliasing[]).map((a) => ({
          value: a,
          label: AA_LABELS[a],
          disabled: !caps.composer && (a === "fxaa" || a === "msaa2"),
          title: !caps.composer && (a === "fxaa" || a === "msaa2") ? "Sur Givre seulement" : undefined,
        })),
      );
      aa.set(caps.composer ? v.antialiasing : v.antialiasing === "msaa2" ? "msaa4" : v.antialiasing === "fxaa" ? "none" : v.antialiasing);
      note(aaRow, caps.composer ? "" : "MSAA au rechargement sur cette carte");
      // Shadows
      shadows.set(v.shadows);
      quality.setOptions(
        SHADOW_QUALITIES.map((q) => ({
          value: q,
          label: SHADOW_QUALITY_LABELS[q],
          disabled: SHADOW_QUALITIES.indexOf(q) > SHADOW_QUALITIES.indexOf(caps.maxShadowQuality),
          title:
            SHADOW_QUALITIES.indexOf(q) > SHADOW_QUALITIES.indexOf(caps.maxShadowQuality) ? "Trop grande pour cette carte graphique" : undefined,
        })),
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
      lights.set(v.effectLights);
      aniso.setOptions(
        ANISOTROPY_LEVELS.map((a) => ({
          value: a,
          label: ANISOTROPY_LABELS[a],
          disabled: a > Math.max(1, caps.maxAnisotropy),
          title: a > Math.max(1, caps.maxAnisotropy) ? "Au-delà du maximum de cette carte graphique" : undefined,
        })),
      );
      aniso.set(v.anisotropy);
      note(snowRow, caps.snow ? "" : "S'applique sur Givre");
      note(halosRow, caps.halos ? "" : "S'applique sur Givre");
      note(printsRow, caps.footprints ? "" : "S'applique sur Givre");
      note(anisoRow, caps.anisotropicTextures ? "" : "Visible sur Givre");
      // Frame rate
      cap.setOptions(FPS_CAPS.map((c) => ({ value: c, label: c === "auto" ? fpsCapLabel(c, controller.effectivePreset()) : c === 0 ? "Illimitée" : String(c) })));
      cap.set(record.fpsCap);
      setText(
        capRow.desc,
        `Plafonne les images calculées : moins de chauffe et de bruit sur un portable. « Illimitée » suit l'écran (${hz} Hz).`,
      );
      // Reload chips
      const pending = new Set(controller.pendingReload().map((c) => c.key));
      chip(shadowsRow, pending.has("shadows"));
      chip(charsRow, pending.has("characterShadows"));
      chip(lightsRow, pending.has("effectLights"));
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
    if (e.kind === "progress" || e.kind === "start" || e.kind === "cancelled" || e.kind === "done") this.refreshDetection();
  }

  private refreshDetection(): void {
    const { controller } = this.deps;
    const running = controller.detecting;
    this.graphicsFieldset.classList.toggle("gs-busy", running);
    // The options are not editable while candidates are measured on screen
    // (inert: neither clickable nor focusable; the Annuler button stays live).
    for (const node of this.graphicsFieldset.querySelectorAll<HTMLElement>(".gs-row, .gs-seg-wide, .gs-detect-side .gs-seg")) {
      node.inert = running;
      node.classList.toggle("gs-locked", running);
    }
    this.detectProgress.classList.toggle("hidden", !running);
    if (running) {
      const p = controller.progress;
      const done = p?.done ?? 0;
      const total = Math.max(1, p?.total ?? 1);
      setText(this.detectText, `Mesure ${Math.min(total, done + 1)} sur ${total}… L'image change pendant les essais.`);
      this.detectFill.style.transform = `scaleX(${Math.min(1, done / total)})`;
      setText(this.detectBtn, "Annuler");
      return;
    }
    setText(this.detectBtn, controller.autoDetected ? "Relancer la détection" : "Lancer la détection");
    const auto = this.record.graphics.auto;
    if (auto && controller.autoDetected) {
      setText(this.detectText, auto.summary || "Réglages mesurés sur ce PC.");
    } else {
      setText(
        this.detectText,
        "Mesure ce PC sur la carte en cours et choisit le plus beau rendu qui tient l'objectif. Quelques secondes ; l'image change pendant les essais.",
      );
    }
  }

  // ----------------------------------------------------------- crosshair

  private buildCrosshair(pane: HTMLElement): void {
    const { sounds, store } = this.deps;
    const update = (change: (c: CrosshairSettings) => void): void => {
      store.update((d) => change(d.crosshair));
    };
    const sec = this.section(pane, "Réticule");
    // Preview on a light and a dark background (the HUD's crosshair is hidden in the menus).
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

  // ------------------------------------------------------------- display

  private buildDisplay(pane: HTMLElement): void {
    const { sounds, store } = this.deps;
    const sec = this.section(pane, "Affichage");
    const panel = new Segmented<PerfPanelMode>(
      "Panneau de performances",
      [
        { value: "full", label: "Complet" },
        { value: "fps", label: "Images par seconde" },
        { value: "off", label: "Masqué" },
      ],
      (v) => store.update((d) => void (d.perfPanel = v)),
      sounds,
    );
    this.row(sec, "Panneau de performances", "Le panneau de mesures en haut à gauche, en partie. Masqué, il ne coûte plus rien.", panel.el);
    this.refreshers.push(() => panel.set(this.record.perfPanel));
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
      this.row(sec, def.label, "", slider.el);
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
    const list = changes.map((c) => `${SETTING_NAMES[c.key]} : ${valueLabel(c.key, c.to as never)}`).join(", ");
    setText(this.reloadText, `Au prochain chargement — ${list}.`);
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
    const target = this.deps.controller.playTarget();
    const budget = 1000 / target;
    setText(this.meterTarget, `objectif ${target}`);
    setText(this.meterDevice, this.deps.game.gpuName || "Carte graphique inconnue");
    if (!perf) {
      setText(this.meterNum, "—");
      return;
    }
    setText(this.meterNum, String(Math.round(perf.fps)));
    this.meter.classList.toggle("below", perf.fps < target * 0.95);
    const load = perf.gpuMs ?? perf.frameMs;
    const ratio = load / budget;
    setText(
      this.meterBarLabel,
      perf.gpuMs !== null
        ? `Carte graphique : ${frNumber(perf.gpuMs, 1)} ms sur ${frNumber(budget, 1)} par image`
        : `Image : ${frNumber(perf.frameMs, 1)} ms sur ${frNumber(budget, 1)}`,
    );
    this.meterFill.style.transform = `scaleX(${Math.min(1, ratio)})`;
    this.meterBar.dataset.level = ratio <= 0.8 ? "ok" : ratio <= 1 ? "tight" : "over";
    setText(this.meterGpu, perf.gpuMs !== null ? `${frNumber(perf.gpuMs, 1)} ms` : "n/d");
    setText(this.meterCpu, `${frNumber(perf.cpuMs, 1)} ms`);
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
