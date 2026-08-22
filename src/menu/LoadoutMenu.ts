import { MenuAudio } from "./MenuAudio";
import {
  KILLSTREAK_ITEMS,
  KillstreakId,
  loadLoadout,
  LoadoutItem,
  LoadoutSelection,
  MELEE_ITEMS,
  PRIMARY_ITEMS,
  saveLoadout,
} from "../loadout/Loadout";

type SlotKey = "melee" | "primary" | "killstreak";

interface SlotDef {
  key: SlotKey;
  label: string;
  items: LoadoutItem[];
}

const SLOTS: SlotDef[] = [
  { key: "melee", label: "ARME DE MÊLÉE", items: MELEE_ITEMS },
  { key: "primary", label: "ARME PRINCIPALE", items: PRIMARY_ITEMS },
  { key: "killstreak", label: "KILLSTREAKS", items: KILLSTREAK_ITEMS },
];

/**
 * LOADOUT overlay — same goofy bean-prairie language as the main menu
 * (dark leafy panels, thin green borders, uppercase + letter-spacing).
 * Three slots (melee / primary / killstreak); each slot lists its items on
 * the left and shows the selected item's summary, abilities, damage stats
 * and cooldowns on the right. "ÉQUIPER" persists via saveLoadout(); the
 * game re-reads the selection when the player enters the match.
 * Fully self-contained: own DOM + injected CSS, nothing else touched.
 */
export class LoadoutMenu {
  /** Fired when the overlay closes (menu restores its idle state). */
  onClose: (() => void) | null = null;

  private readonly root: HTMLElement;
  private readonly listEl: HTMLElement;
  private readonly detailEl: HTMLElement;
  private readonly tabsEl: HTMLElement;
  private readonly subslotsEl: HTMLElement;

  private selection: LoadoutSelection = loadLoadout();
  private activeSlot: SlotDef = SLOTS[0];
  /** Which of the three killstreak slots (keys 1/2/3) is being edited. */
  private activeKillstreakSlot: 0 | 1 | 2 = 0;
  /** Item currently INSPECTED (not necessarily equipped). */
  private inspectedId = "";

  constructor(private readonly sounds: MenuAudio) {
    injectStyles();

    this.root = document.createElement("div");
    this.root.id = "loadout-menu";
    this.root.innerHTML = `
      <div class="lo-panel">
        <div class="lo-header">
          <div>
            <div class="lo-title">LOADOUT</div>
            <div class="lo-subtitle">CONFIGURATION DE COMBAT</div>
          </div>
          <button class="lo-back" type="button">RETOUR</button>
        </div>
        <div class="lo-tabs"></div>
        <div class="lo-subslots"></div>
        <div class="lo-body">
          <div class="lo-list"></div>
          <div class="lo-detail"></div>
        </div>
      </div>
    `;
    document.body.appendChild(this.root);

    this.tabsEl = this.root.querySelector(".lo-tabs")!;
    this.subslotsEl = this.root.querySelector(".lo-subslots")!;
    this.listEl = this.root.querySelector(".lo-list")!;
    this.detailEl = this.root.querySelector(".lo-detail")!;

    const back = this.root.querySelector<HTMLButtonElement>(".lo-back")!;
    back.addEventListener("pointerenter", () => this.sounds.hover());
    back.addEventListener("click", () => {
      this.sounds.click();
      this.close();
    });
    // Escape also closes the overlay.
    document.addEventListener("keydown", this.onKeyDown);

    this.renderTabs();
    this.setSlot(SLOTS[0]);
  }

  private readonly onKeyDown = (e: KeyboardEvent): void => {
    if (e.code === "Escape" && this.isOpen) this.close();
  };

  get isOpen(): boolean {
    return this.root.classList.contains("open");
  }

  open(): void {
    this.selection = loadLoadout(); // always reflect the persisted truth
    this.setSlot(this.activeSlot);
    this.root.classList.add("open");
  }

  close(): void {
    if (!this.isOpen) return;
    this.root.classList.remove("open");
    this.onClose?.();
  }

  dispose(): void {
    document.removeEventListener("keydown", this.onKeyDown);
    this.root.remove();
  }

  // ------------------------------------------------------------------
  // Rendering
  // ------------------------------------------------------------------

  private renderTabs(): void {
    this.tabsEl.innerHTML = "";
    for (const slot of SLOTS) {
      const tab = document.createElement("button");
      tab.type = "button";
      tab.className = "lo-tab";
      tab.textContent = slot.label;
      tab.addEventListener("pointerenter", () => this.sounds.hover());
      tab.addEventListener("click", () => {
        this.sounds.click();
        this.setSlot(slot);
      });
      this.tabsEl.appendChild(tab);
    }
  }

  private setSlot(slot: SlotDef): void {
    this.activeSlot = slot;
    this.inspectedId = this.equippedId();
    const tabs = this.tabsEl.querySelectorAll<HTMLButtonElement>(".lo-tab");
    tabs.forEach((tab, i) => tab.classList.toggle("active", SLOTS[i] === slot));
    this.renderSubSlots();
    this.renderList();
    this.renderDetail();
  }

  /** Id equipped in the active slot (killstreaks: the active sub-slot). */
  private equippedId(): string {
    if (this.activeSlot.key === "killstreak") {
      return this.selection.killstreaks[this.activeKillstreakSlot];
    }
    return this.selection[this.activeSlot.key];
  }

  /** SLOT 1/2/3 selector row — only visible on the killstreaks tab. */
  private renderSubSlots(): void {
    this.subslotsEl.innerHTML = "";
    const visible = this.activeSlot.key === "killstreak";
    this.subslotsEl.classList.toggle("visible", visible);
    if (!visible) return;

    for (let i = 0; i < 3; i++) {
      const id = this.selection.killstreaks[i];
      const item = KILLSTREAK_ITEMS.find((it) => it.id === id);
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "lo-subslot";
      if (i === this.activeKillstreakSlot) btn.classList.add("active");
      btn.innerHTML = `
        <span class="lo-subslot-key">SLOT ${i + 1}</span>
        <span class="lo-subslot-item">${item?.name ?? "AUCUN"}</span>
      `;
      btn.addEventListener("pointerenter", () => this.sounds.hover());
      btn.addEventListener("click", () => {
        this.sounds.click();
        this.activeKillstreakSlot = i as 0 | 1 | 2;
        this.inspectedId = this.equippedId();
        this.renderSubSlots();
        this.renderList();
        this.renderDetail();
      });
      this.subslotsEl.appendChild(btn);
    }
  }

  private renderList(): void {
    this.listEl.innerHTML = "";
    for (const item of this.activeSlot.items) {
      const equipped = this.equippedId() === item.id;
      const card = document.createElement("button");
      card.type = "button";
      card.className = "lo-card";
      if (item.id === this.inspectedId) card.classList.add("inspected");
      if (item.locked) card.classList.add("locked");
      card.innerHTML = `
        <div class="lo-card-name">${item.name}</div>
        <div class="lo-card-tagline">${item.tagline}</div>
        ${equipped ? `<div class="lo-card-equipped">ÉQUIPÉ</div>` : ""}
        ${item.locked ? `<div class="lo-card-lock">VERROUILLÉ</div>` : ""}
      `;
      card.addEventListener("pointerenter", () => this.sounds.hover());
      card.addEventListener("click", () => {
        this.sounds.click();
        this.inspectedId = item.id;
        this.renderList();
        this.renderDetail();
      });
      this.listEl.appendChild(card);
    }
  }

  private renderDetail(): void {
    const item =
      this.activeSlot.items.find((i) => i.id === this.inspectedId) ?? this.activeSlot.items[0];
    const equipped = this.equippedId() === item.id;

    const abilities = item.abilities
      .map(
        (a) => `
        <div class="lo-ability">
          <div class="lo-ability-trigger">${a.trigger}</div>
          <div class="lo-ability-name">${a.name}</div>
          <div class="lo-ability-desc">${a.description}</div>
          <div class="lo-stats">
            ${a.stats
              .map(
                (s) => `
                <div class="lo-stat">
                  <div class="lo-stat-label">${s.label}</div>
                  <div class="lo-stat-value">${s.value}</div>
                </div>`,
              )
              .join("")}
          </div>
        </div>`,
      )
      .join("");

    this.detailEl.innerHTML = `
      <div class="lo-detail-name">${item.name}</div>
      <div class="lo-detail-tagline">${item.tagline}</div>
      <div class="lo-detail-summary">${item.summary}</div>
      ${abilities}
      <button class="lo-equip ${equipped ? "equipped" : ""}" type="button"
        ${item.locked || equipped ? "disabled" : ""}>
        ${item.locked ? "VERROUILLÉ" : equipped ? "ÉQUIPÉ" : "ÉQUIPER"}
      </button>
    `;

    const equipBtn = this.detailEl.querySelector<HTMLButtonElement>(".lo-equip")!;
    equipBtn.addEventListener("pointerenter", () => this.sounds.hover());
    equipBtn.addEventListener("click", () => {
      if (item.locked || this.equippedId() === item.id) return;
      this.sounds.click();
      if (this.activeSlot.key === "killstreak") {
        const id = item.id as KillstreakId;
        // A non-NONE killstreak can only live in ONE slot at a time.
        if (id !== "NONE") {
          for (let i = 0; i < 3; i++) {
            if (i !== this.activeKillstreakSlot && this.selection.killstreaks[i] === id) {
              this.selection.killstreaks[i] = "NONE";
            }
          }
        }
        this.selection.killstreaks[this.activeKillstreakSlot] = id;
      } else {
        // Type-safe narrow: each slot only offers ids valid for its key.
        (this.selection as unknown as Record<"melee" | "primary", string>)[
          this.activeSlot.key
        ] = item.id;
      }
      saveLoadout(this.selection);
      this.renderSubSlots();
      this.renderList();
      this.renderDetail();
    });
  }
}

let stylesInjected = false;

function injectStyles(): void {
  if (stylesInjected) return;
  stylesInjected = true;
  const style = document.createElement("style");
  style.textContent = `
    #loadout-menu {
      position: fixed;
      inset: 0;
      z-index: 60;
      display: none;
      align-items: center;
      justify-content: center;
      background: rgba(2, 10, 5, 0.82);
      backdrop-filter: blur(6px);
      font-family: "Baloo 2", "Segoe UI", system-ui, sans-serif;
      color: #e3f7e6;
    }
    #loadout-menu.open { display: flex; animation: lo-fade 0.18s ease; }
    @keyframes lo-fade { from { opacity: 0; } to { opacity: 1; } }

    #loadout-menu .lo-panel {
      width: min(980px, 94vw);
      max-height: 90vh;
      display: flex;
      flex-direction: column;
      background: linear-gradient(160deg, rgba(10, 28, 16, 0.96), rgba(5, 15, 9, 0.96));
      border: 2px solid rgba(74, 222, 128, 0.35);
      border-radius: 22px;
      box-shadow: 0 0 60px rgba(20, 83, 45, 0.35), inset 0 0 40px rgba(20, 83, 45, 0.08);
      padding: 26px 30px 30px;
    }

    #loadout-menu .lo-header {
      display: flex;
      justify-content: space-between;
      align-items: flex-start;
      margin-bottom: 18px;
    }
    #loadout-menu .lo-title {
      font-family: "Luckiest Guy", cursive;
      font-size: 26px;
      font-weight: 400;
      letter-spacing: 0.42em;
      color: #f0fdf4;
      text-shadow: 0 0 18px rgba(74, 222, 128, 0.55);
    }
    #loadout-menu .lo-subtitle {
      margin-top: 4px;
      font-size: 10px;
      letter-spacing: 0.34em;
      color: rgba(187, 247, 208, 0.5);
    }
    #loadout-menu .lo-back {
      background: none;
      border: 1px solid rgba(74, 222, 128, 0.35);
      border-radius: 12px;
      color: #bbf7d0;
      font-size: 11px;
      letter-spacing: 0.28em;
      padding: 8px 18px;
      cursor: pointer;
      transition: background 0.15s ease, border-color 0.15s ease;
    }
    #loadout-menu .lo-back:hover {
      background: rgba(74, 222, 128, 0.14);
      border-color: rgba(187, 247, 208, 0.7);
    }

    #loadout-menu .lo-tabs {
      display: flex;
      gap: 8px;
      margin-bottom: 16px;
    }
    #loadout-menu .lo-tab {
      flex: 1;
      background: rgba(20, 83, 45, 0.08);
      border: 1px solid rgba(74, 222, 128, 0.2);
      border-radius: 12px;
      color: rgba(187, 247, 208, 0.6);
      font-size: 11px;
      letter-spacing: 0.26em;
      padding: 10px 0;
      cursor: pointer;
      transition: all 0.15s ease;
    }
    #loadout-menu .lo-tab:hover { border-color: rgba(187, 247, 208, 0.55); color: #e3f7e6; }
    #loadout-menu .lo-tab.active {
      background: rgba(22, 163, 74, 0.18);
      border-color: rgba(187, 247, 208, 0.85);
      color: #f0fdf4;
      box-shadow: 0 0 18px rgba(22, 163, 74, 0.25);
    }

    #loadout-menu .lo-subslots {
      display: none;
      gap: 8px;
      margin: -6px 0 14px;
    }
    #loadout-menu .lo-subslots.visible { display: flex; }
    #loadout-menu .lo-subslot {
      flex: 1;
      display: flex;
      flex-direction: column;
      gap: 4px;
      align-items: center;
      background: rgba(20, 83, 45, 0.06);
      border: 1px solid rgba(74, 222, 128, 0.18);
      border-radius: 12px;
      color: rgba(187, 247, 208, 0.55);
      padding: 8px 0;
      cursor: pointer;
      transition: all 0.15s ease;
    }
    #loadout-menu .lo-subslot:hover { border-color: rgba(187, 247, 208, 0.5); color: #e3f7e6; }
    #loadout-menu .lo-subslot.active {
      background: rgba(22, 163, 74, 0.16);
      border-color: rgba(187, 247, 208, 0.8);
      color: #f0fdf4;
      box-shadow: 0 0 14px rgba(22, 163, 74, 0.2);
    }
    #loadout-menu .lo-subslot-key { font-size: 9px; letter-spacing: 0.3em; }
    #loadout-menu .lo-subslot-item { font-size: 11px; font-weight: 600; letter-spacing: 0.14em; }

    #loadout-menu .lo-body {
      display: grid;
      grid-template-columns: 280px 1fr;
      gap: 16px;
      min-height: 0;
      overflow: hidden;
    }
    #loadout-menu .lo-list {
      display: flex;
      flex-direction: column;
      gap: 10px;
      overflow-y: auto;
      padding-right: 4px;
    }
    #loadout-menu .lo-card {
      position: relative;
      text-align: left;
      background: rgba(12, 34, 20, 0.7);
      border: 1px solid rgba(74, 222, 128, 0.22);
      border-radius: 14px;
      padding: 14px 16px;
      cursor: pointer;
      color: inherit;
      transition: border-color 0.15s ease, background 0.15s ease, transform 0.1s ease;
    }
    #loadout-menu .lo-card:hover { border-color: rgba(187, 247, 208, 0.6); transform: translateX(2px); }
    #loadout-menu .lo-card.inspected {
      background: rgba(22, 163, 74, 0.16);
      border-color: rgba(187, 247, 208, 0.9);
      box-shadow: 0 0 16px rgba(22, 163, 74, 0.25);
    }
    #loadout-menu .lo-card.locked { opacity: 0.55; }
    #loadout-menu .lo-card-name { font-size: 14px; font-weight: 600; letter-spacing: 0.16em; }
    #loadout-menu .lo-card-tagline { margin-top: 3px; font-size: 10px; letter-spacing: 0.14em; color: rgba(187, 247, 208, 0.55); }
    #loadout-menu .lo-card-equipped,
    #loadout-menu .lo-card-lock {
      position: absolute;
      top: 10px;
      right: 12px;
      font-size: 9px;
      letter-spacing: 0.22em;
      color: #bbf7d0;
      border: 1px solid rgba(187, 247, 208, 0.5);
      border-radius: 8px;
      padding: 3px 8px;
    }
    #loadout-menu .lo-card-lock { color: rgba(227, 247, 230, 0.5); border-color: rgba(227, 247, 230, 0.25); }

    #loadout-menu .lo-detail {
      overflow-y: auto;
      border: 1px solid rgba(74, 222, 128, 0.18);
      border-radius: 14px;
      background: rgba(7, 20, 12, 0.6);
      padding: 22px 24px;
    }
    #loadout-menu .lo-detail-name {
      font-family: "Luckiest Guy", cursive;
      font-size: 20px;
      font-weight: 400;
      letter-spacing: 0.3em;
      color: #f0fdf4;
      text-shadow: 0 0 14px rgba(74, 222, 128, 0.45);
    }
    #loadout-menu .lo-detail-tagline { margin-top: 4px; font-size: 10px; letter-spacing: 0.26em; color: rgba(187, 247, 208, 0.55); }
    #loadout-menu .lo-detail-summary {
      margin: 14px 0 6px;
      font-size: 13px;
      line-height: 1.55;
      color: rgba(227, 247, 230, 0.85);
    }
    #loadout-menu .lo-ability {
      margin-top: 16px;
      border-top: 1px solid rgba(74, 222, 128, 0.16);
      padding-top: 14px;
    }
    #loadout-menu .lo-ability-trigger { font-size: 9px; letter-spacing: 0.26em; color: rgba(187, 247, 208, 0.5); }
    #loadout-menu .lo-ability-name { margin-top: 3px; font-size: 14px; font-weight: 600; letter-spacing: 0.2em; color: #bbf7d0; }
    #loadout-menu .lo-ability-desc { margin-top: 6px; font-size: 12px; line-height: 1.5; color: rgba(227, 247, 230, 0.75); }
    #loadout-menu .lo-stats {
      display: grid;
      grid-template-columns: repeat(4, 1fr);
      gap: 8px;
      margin-top: 12px;
    }
    #loadout-menu .lo-stat {
      background: rgba(20, 83, 45, 0.12);
      border: 1px solid rgba(74, 222, 128, 0.2);
      border-radius: 10px;
      padding: 8px 10px;
    }
    #loadout-menu .lo-stat-label { font-size: 8px; letter-spacing: 0.22em; color: rgba(187, 247, 208, 0.5); }
    #loadout-menu .lo-stat-value { margin-top: 4px; font-size: 12px; font-weight: 600; letter-spacing: 0.08em; color: #f0fdf4; }

    #loadout-menu .lo-equip {
      margin-top: 22px;
      width: 100%;
      background: rgba(22, 163, 74, 0.2);
      border: 1px solid rgba(187, 247, 208, 0.75);
      border-radius: 14px;
      color: #f0fdf4;
      font-size: 13px;
      font-weight: 600;
      letter-spacing: 0.34em;
      padding: 13px 0;
      cursor: pointer;
      transition: background 0.15s ease, box-shadow 0.15s ease;
    }
    #loadout-menu .lo-equip:hover:not(:disabled) {
      background: rgba(22, 163, 74, 0.38);
      box-shadow: 0 0 22px rgba(22, 163, 74, 0.4);
    }
    #loadout-menu .lo-equip:disabled { cursor: default; opacity: 0.55; }
    #loadout-menu .lo-equip.equipped { border-color: rgba(250, 204, 21, 0.6); color: #fef9c3; opacity: 0.85; }

    @media (max-width: 760px) {
      #loadout-menu .lo-body { grid-template-columns: 1fr; }
      #loadout-menu .lo-stats { grid-template-columns: repeat(2, 1fr); }
    }
  `;
  document.head.appendChild(style);
}