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
import { getWeaponIconUrl, hasWeaponIcon } from "./WeaponIconRenderer";
import haricotUrl from "../assets/haricot.png";

type SlotKey = "melee" | "primary" | "killstreak";

interface SlotDef {
  key: SlotKey;
  label: string;
  items: LoadoutItem[];
}

const SLOTS: SlotDef[] = [
  { key: "primary", label: "ARME PRINCIPALE", items: PRIMARY_ITEMS },
  { key: "melee", label: "ARME DE MÊLÉE", items: MELEE_ITEMS },
  { key: "killstreak", label: "KILLSTREAKS", items: KILLSTREAK_ITEMS },
];

/** Goofy emoji fallbacks for items without a 3D model (killstreaks). */
const EMOJI_ICONS: Record<string, string> = {
  NONE: "💤",
  MOLE_STRIKE: "🕳️",
  ORBITAL_SCAN: "📡",
  NOVA_STRIKE: "☄️",
};

/**
 * LOADOUT overlay — goofy bean-prairie cartoon theme (wooden panels,
 * parchment board, chunky leaf-green accents, hand-game UI vibes).
 *
 * Layout inspired by the reference mock: a parchment board on the right
 * with slot tabs + a grid of weapon cards (each showing its REAL 3D
 * model snapshotted by WeaponIconRenderer), and a wooden detail panel
 * on the LEFT that pops open with the selected item's full info
 * (summary, abilities, real gameplay stats) and the ÉQUIPER button.
 *
 * "ÉQUIPER" persists via saveLoadout(); the game re-reads the selection
 * when the player enters the match. Fully self-contained: own DOM +
 * injected CSS, nothing else touched.
 */
export class LoadoutMenu {
  /** Fired when the overlay closes (menu restores its idle state). */
  onClose: (() => void) | null = null;

  private readonly root: HTMLElement;
  private readonly gridEl: HTMLElement;
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
      <div class="lo-frame">
        <aside class="lo-detail"></aside>
        <section class="lo-board">
          <img class="lo-leaf lo-leaf-tl" src="${haricotUrl}" alt="" draggable="false">
          <img class="lo-leaf lo-leaf-br" src="${haricotUrl}" alt="" draggable="false">
          <div class="lo-header">
            <div>
              <div class="lo-title">LOADOUT</div>
              <div class="lo-subtitle">PRÉPARE TON HARICOT AU COMBAT</div>
            </div>
            <button class="lo-back" type="button">✕ RETOUR</button>
          </div>
          <div class="lo-tabs"></div>
          <div class="lo-subslots"></div>
          <div class="lo-grid"></div>
        </section>
      </div>
    `;
    document.body.appendChild(this.root);

    this.tabsEl = this.root.querySelector(".lo-tabs")!;
    this.subslotsEl = this.root.querySelector(".lo-subslots")!;
    this.gridEl = this.root.querySelector(".lo-grid")!;
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
    this.renderGrid();
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
        this.renderGrid();
        this.renderDetail();
      });
      this.subslotsEl.appendChild(btn);
    }
  }

  private renderGrid(): void {
    this.gridEl.innerHTML = "";
    for (const item of this.activeSlot.items) {
      const equipped = this.equippedId() === item.id;
      const card = document.createElement("button");
      card.type = "button";
      card.className = "lo-card";
      if (item.id === this.inspectedId) card.classList.add("inspected");
      if (item.locked) card.classList.add("locked");
      card.innerHTML = `
        ${equipped ? `<div class="lo-card-check">✔</div>` : ""}
        ${item.locked ? `<div class="lo-card-lock">🔒</div>` : ""}
        <div class="lo-card-icon"></div>
        <div class="lo-card-name">${item.name}</div>
      `;
      this.mountIcon(card.querySelector(".lo-card-icon")!, item.id);
      card.addEventListener("pointerenter", () => this.sounds.hover());
      card.addEventListener("click", () => {
        this.sounds.click();
        this.inspectedId = item.id;
        this.renderGrid();
        this.renderDetail(true);
      });
      this.gridEl.appendChild(card);
    }
  }

  /** Fill an icon holder with the weapon's 3D snapshot (or a goofy emoji). */
  private mountIcon(holder: HTMLElement, itemId: string): void {
    if (hasWeaponIcon(itemId)) {
      const img = document.createElement("img");
      img.alt = "";
      img.draggable = false;
      img.addEventListener("load", () => img.classList.add("ready"));
      holder.appendChild(img);
      void getWeaponIconUrl(itemId).then((url) => {
        if (url && img.isConnected) img.src = url;
      });
    } else {
      const emoji = document.createElement("span");
      emoji.className = "lo-icon-emoji";
      emoji.textContent = EMOJI_ICONS[itemId] ?? "🫘";
      holder.appendChild(emoji);
    }
  }

  private renderDetail(pop = false): void {
    const item =
      this.activeSlot.items.find((i) => i.id === this.inspectedId) ?? this.activeSlot.items[0];
    const equipped = this.equippedId() === item.id;

    const abilities = item.abilities
      .map(
        (a) => `
        <div class="lo-abil">
          <div class="lo-abil-trigger">${a.trigger}</div>
          <div class="lo-abil-name">${a.name}</div>
          <div class="lo-abil-desc">${a.description}</div>
          <div class="lo-abil-stats">
            ${a.stats
              .map(
                (s) => `
                <div class="lo-stat">
                  <span class="lo-stat-label">${s.label}</span>
                  <span class="lo-stat-value">${s.value}</span>
                </div>`,
              )
              .join("")}
          </div>
        </div>`,
      )
      .join("");

    const r = item.ratings;
    const bars = r
      ? `
      <div class="lo-bars">
        ${barRow("PUISSANCE", r.power)}
        ${barRow("PRÉCISION", r.precision)}
        ${barRow("DIFFICULTÉ", r.difficulty)}
      </div>`
      : "";

    this.detailEl.innerHTML = `
      <div class="lo-d-scroll">
        <div class="lo-d-icon"></div>
        <div class="lo-d-name">${item.name}</div>
        <div class="lo-d-tagline">${item.tagline}</div>
        ${bars}
        <div class="lo-d-abilities">${abilities}</div>
      </div>
      <button class="lo-equip ${equipped ? "equipped" : ""}" type="button"
        ${item.locked || equipped ? "disabled" : ""}>
        ${item.locked ? "🔒 VERROUILLÉ" : equipped ? "✔ ÉQUIPÉ" : "ÉQUIPER"}
      </button>
    `;
    this.mountIcon(this.detailEl.querySelector(".lo-d-icon")!, item.id);

    if (pop) {
      // Restart the pop-in animation so a new selection visibly "opens".
      this.detailEl.classList.remove("pop");
      void this.detailEl.offsetWidth; // reflow → animation restarts
      this.detailEl.classList.add("pop");
    }

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
      this.renderGrid();
      this.renderDetail();
    });
  }
}

/** One chunky power-bar row (label + green fill + value), image-style. */
function barRow(label: string, value: number): string {
  const v = Math.max(0, Math.min(100, Math.round(value)));
  return `
    <div class="lo-bar-row">
      <span class="lo-bar-label">${label}</span>
      <div class="lo-bar-track"><div class="lo-bar-fill" style="width:${v}%"></div></div>
      <span class="lo-bar-value">${v}</span>
    </div>`;
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
      background: rgba(26, 18, 8, 0.72);
      backdrop-filter: blur(7px);
      font-family: "Baloo 2", "Segoe UI", system-ui, sans-serif;
      color: #4a3117;
    }
    #loadout-menu.open { display: flex; animation: lo-fade 0.2s ease; }
    @keyframes lo-fade { from { opacity: 0; } to { opacity: 1; } }

    #loadout-menu .lo-frame {
      display: grid;
      grid-template-columns: 340px 1fr;
      gap: 20px;
      width: min(1180px, 96vw);
      /* FIXED height: both panels' borders always fully on screen,
         everything overflowing scrolls INSIDE the panels. */
      height: min(820px, 90vh);
      align-items: stretch;
    }

    /* ============ RIGHT: parchment board (tabs + weapon grid) ============ */
    #loadout-menu .lo-board {
      position: relative;
      display: flex;
      flex-direction: column;
      min-height: 0;
      background:
        radial-gradient(120% 90% at 20% 0%, rgba(255, 250, 232, 0.55), transparent 55%),
        linear-gradient(165deg, #f4e8ca 0%, #ecdcb4 60%, #e3d1a4 100%);
      border: 7px solid #6b4a2b;
      border-radius: 30px;
      box-shadow:
        0 18px 50px rgba(0, 0, 0, 0.45),
        inset 0 0 0 3px rgba(255, 248, 226, 0.65),
        inset 0 -14px 30px rgba(107, 74, 43, 0.16);
      padding: 24px 26px 26px;
    }
    /* Bean mascots pinned EXACTLY on the panel's corner edge: anchored on
       the rounded corner's diagonal point, then centered on it. */
    #loadout-menu .lo-leaf {
      position: absolute;
      width: 36px;
      height: 36px;
      object-fit: contain;
      filter: drop-shadow(0 3px 3px rgba(0, 0, 0, 0.3));
      pointer-events: none;
      user-select: none;
      z-index: 2;
    }
    #loadout-menu .lo-leaf-tl {
      top: 2px;
      left: 2px;
      transform: translate(-50%, -50%) rotate(-15deg);
    }
    #loadout-menu .lo-leaf-br {
      bottom: 2px;
      right: 2px;
      transform: translate(50%, 50%) rotate(165deg);
    }

    #loadout-menu .lo-header {
      display: flex;
      justify-content: space-between;
      align-items: flex-start;
      margin-bottom: 16px;
    }
    #loadout-menu .lo-title {
      font-family: "Luckiest Guy", cursive;
      font-size: 34px;
      line-height: 1;
      color: #5b3d21;
      text-shadow:
        0 2px 0 rgba(255, 248, 226, 0.9),
        0 4px 8px rgba(91, 61, 33, 0.25);
      letter-spacing: 0.06em;
    }
    #loadout-menu .lo-subtitle {
      margin-top: 5px;
      font-size: 11px;
      font-weight: 700;
      letter-spacing: 0.22em;
      color: #7d9a3c;
    }
    #loadout-menu .lo-back {
      background: linear-gradient(180deg, #7a5533, #5b3d21);
      border: 3px solid #3d2913;
      border-radius: 14px;
      color: #f7ecd2;
      font-family: "Baloo 2", sans-serif;
      font-weight: 700;
      font-size: 12px;
      letter-spacing: 0.18em;
      padding: 9px 18px;
      cursor: pointer;
      box-shadow: 0 4px 0 #3d2913;
      transition: transform 0.1s ease, box-shadow 0.1s ease, filter 0.15s ease;
    }
    #loadout-menu .lo-back:hover { filter: brightness(1.12); }
    #loadout-menu .lo-back:active { transform: translateY(3px); box-shadow: 0 1px 0 #3d2913; }

    /* ---- Slot tabs ---- */
    #loadout-menu .lo-tabs {
      display: flex;
      gap: 10px;
      margin-bottom: 14px;
    }
    #loadout-menu .lo-tab {
      flex: 1;
      background: linear-gradient(180deg, #fbf3dd, #efe2c0);
      border: 3px solid #6b4a2b;
      border-radius: 14px;
      color: #6b4a2b;
      font-family: "Luckiest Guy", cursive;
      font-size: 14px;
      letter-spacing: 0.06em;
      padding: 11px 4px 9px;
      cursor: pointer;
      box-shadow: 0 4px 0 rgba(107, 74, 43, 0.55);
      transition: transform 0.1s ease, box-shadow 0.1s ease, filter 0.15s ease;
    }
    #loadout-menu .lo-tab:hover { filter: brightness(1.05); transform: translateY(-1px); }
    #loadout-menu .lo-tab.active {
      background: linear-gradient(180deg, #a8d94a, #78ac1e);
      border-color: #4c6b1f;
      color: #ffffff;
      text-shadow: 0 2px 0 rgba(60, 90, 20, 0.6);
      box-shadow: 0 4px 0 #4c6b1f, 0 0 18px rgba(140, 195, 60, 0.45);
    }

    /* ---- Killstreak sub-slots ---- */
    #loadout-menu .lo-subslots {
      display: none;
      gap: 10px;
      margin: -2px 0 14px;
    }
    #loadout-menu .lo-subslots.visible { display: flex; }
    #loadout-menu .lo-subslot {
      flex: 1;
      display: flex;
      flex-direction: column;
      gap: 3px;
      align-items: center;
      background: rgba(255, 250, 232, 0.55);
      border: 2px dashed #a98d5f;
      border-radius: 12px;
      color: #7a5b33;
      padding: 8px 0;
      cursor: pointer;
      font-family: "Baloo 2", sans-serif;
      transition: all 0.15s ease;
    }
    #loadout-menu .lo-subslot:hover { border-color: #6b4a2b; }
    #loadout-menu .lo-subslot.active {
      background: rgba(168, 217, 74, 0.28);
      border: 2px solid #78ac1e;
      color: #4c6b1f;
    }
    #loadout-menu .lo-subslot-key { font-size: 9px; font-weight: 700; letter-spacing: 0.28em; }
    #loadout-menu .lo-subslot-item { font-size: 12px; font-weight: 800; letter-spacing: 0.1em; }

    /* ---- Weapon grid ---- */
    #loadout-menu .lo-grid {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(165px, 1fr));
      gap: 16px;
      overflow-y: auto;
      overflow-x: hidden;
      padding: 12px 4px 2px;
      min-height: 0;
      align-content: start;
    }
    #loadout-menu .lo-card {
      position: relative;
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 8px;
      background: linear-gradient(160deg, #35618d 0%, #234666 55%, #1b3852 100%);
      border: 3px solid #6fa8d6;
      border-radius: 20px;
      padding: 14px 10px 12px;
      cursor: pointer;
      color: #f2f8ff;
      box-shadow:
        inset 0 0 22px rgba(10, 25, 40, 0.55),
        0 6px 0 rgba(20, 40, 60, 0.55);
      transition: transform 0.12s ease, border-color 0.15s ease, box-shadow 0.15s ease;
    }
    #loadout-menu .lo-card:hover {
      transform: translateY(-3px);
      border-color: #a5d3f5;
    }
    #loadout-menu .lo-card.inspected {
      border-color: #ffffff;
      box-shadow:
        inset 0 0 22px rgba(10, 25, 40, 0.55),
        0 6px 0 rgba(20, 40, 60, 0.55),
        0 0 22px rgba(160, 215, 255, 0.75);
    }
    #loadout-menu .lo-card.locked { filter: grayscale(0.8); opacity: 0.6; }

    #loadout-menu .lo-card-icon {
      width: 100%;
      height: 118px;
      display: flex;
      align-items: center;
      justify-content: center;
    }
    #loadout-menu .lo-card-icon img {
      width: 100%;
      height: 100%;
      object-fit: contain;
      opacity: 0;
      transform: scale(0.85);
      transition: opacity 0.25s ease, transform 0.25s ease;
      filter: drop-shadow(0 6px 8px rgba(0, 0, 0, 0.45));
    }
    #loadout-menu .lo-card-icon img.ready { opacity: 1; transform: scale(1); }
    #loadout-menu .lo-icon-emoji {
      font-size: 58px;
      filter: drop-shadow(0 5px 6px rgba(0, 0, 0, 0.4));
    }

    #loadout-menu .lo-card-name {
      font-family: "Baloo 2", sans-serif;
      font-weight: 800;
      font-size: 13px;
      letter-spacing: 0.08em;
      text-align: center;
      text-shadow: 0 2px 3px rgba(0, 0, 0, 0.5);
    }
    #loadout-menu .lo-card-check {
      position: absolute;
      top: -10px;
      right: -8px;
      width: 30px;
      height: 30px;
      display: flex;
      align-items: center;
      justify-content: center;
      background: linear-gradient(180deg, #a8d94a, #78ac1e);
      border: 3px solid #ffffff;
      border-radius: 50%;
      color: #fff;
      font-size: 14px;
      box-shadow: 0 3px 6px rgba(0, 0, 0, 0.35);
      z-index: 1;
    }
    #loadout-menu .lo-card-lock {
      position: absolute;
      top: 8px;
      right: 10px;
      font-size: 16px;
      z-index: 1;
    }

    /* ============ LEFT: wooden detail panel ============ */
    #loadout-menu .lo-detail {
      display: flex;
      flex-direction: column;
      min-height: 0;
      background:
        radial-gradient(140% 60% at 50% 0%, rgba(255, 220, 160, 0.14), transparent 60%),
        linear-gradient(170deg, #6a4a2a 0%, #543a1f 55%, #46301a 100%);
      border: 7px solid #3a2814;
      border-radius: 28px;
      box-shadow:
        0 18px 50px rgba(0, 0, 0, 0.5),
        inset 0 0 0 2px rgba(255, 226, 178, 0.14),
        inset 0 -18px 36px rgba(0, 0, 0, 0.28);
      padding: 20px 20px 22px;
      color: #f5ead2;
    }
    #loadout-menu .lo-detail.pop { animation: lo-pop 0.28s cubic-bezier(0.2, 1.4, 0.4, 1); }
    @keyframes lo-pop {
      from { transform: translateX(-18px) scale(0.97); opacity: 0.4; }
      to { transform: translateX(0) scale(1); opacity: 1; }
    }
    /* Inner scroll area: the panel frame + ÉQUIPER button never move. */
    #loadout-menu .lo-d-scroll {
      flex: 1;
      min-height: 0;
      overflow-y: auto;
      padding-right: 6px;
    }

    #loadout-menu .lo-d-icon {
      height: 130px;
      display: flex;
      align-items: center;
      justify-content: center;
      margin-bottom: 4px;
      background: radial-gradient(60% 70% at 50% 55%, rgba(255, 240, 200, 0.12), transparent 75%);
      border-radius: 18px;
    }
    #loadout-menu .lo-d-icon img {
      height: 100%;
      object-fit: contain;
      opacity: 0;
      transform: scale(0.85) rotate(-3deg);
      transition: opacity 0.25s ease, transform 0.3s cubic-bezier(0.2, 1.5, 0.4, 1);
      filter: drop-shadow(0 8px 10px rgba(0, 0, 0, 0.5));
    }
    #loadout-menu .lo-d-icon img.ready { opacity: 1; transform: scale(1) rotate(0deg); }
    #loadout-menu .lo-d-icon .lo-icon-emoji { font-size: 72px; }

    #loadout-menu .lo-d-name {
      font-family: "Luckiest Guy", cursive;
      font-size: 24px;
      line-height: 1.05;
      color: #fff6e0;
      text-shadow: 0 3px 0 rgba(40, 26, 10, 0.65), 0 0 16px rgba(255, 214, 140, 0.25);
    }
    #loadout-menu .lo-d-tagline {
      margin-top: 3px;
      font-size: 11px;
      font-weight: 700;
      letter-spacing: 0.2em;
      color: #b7e05f;
    }
    /* ---- Power bars (image-style gauges) ---- */
    #loadout-menu .lo-bars {
      display: flex;
      flex-direction: column;
      gap: 9px;
      margin-top: 14px;
    }
    #loadout-menu .lo-bar-row {
      display: grid;
      grid-template-columns: 82px 1fr 30px;
      align-items: center;
      gap: 9px;
    }
    #loadout-menu .lo-bar-label {
      font-size: 9px;
      font-weight: 800;
      letter-spacing: 0.14em;
      color: rgba(245, 234, 210, 0.9);
    }
    #loadout-menu .lo-bar-track {
      height: 15px;
      background: rgba(20, 12, 4, 0.62);
      border: 2px solid rgba(255, 226, 178, 0.18);
      border-radius: 10px;
      overflow: hidden;
      box-shadow: inset 0 2px 5px rgba(0, 0, 0, 0.55);
    }
    #loadout-menu .lo-bar-fill {
      height: 100%;
      background: linear-gradient(180deg, #cde98a, #8bc34a 45%, #6ea31a);
      border-radius: 8px;
      box-shadow: 0 0 8px rgba(140, 195, 60, 0.55);
      animation: lo-bar-grow 0.55s cubic-bezier(0.2, 0.9, 0.3, 1);
    }
    @keyframes lo-bar-grow { from { width: 0; } }
    #loadout-menu .lo-bar-value {
      font-size: 13px;
      font-weight: 800;
      color: #b7e05f;
      text-align: right;
    }

    #loadout-menu .lo-abil {
      margin-top: 12px;
      background: rgba(30, 18, 6, 0.38);
      border: 2px solid rgba(255, 226, 178, 0.14);
      border-radius: 16px;
      padding: 12px 14px;
    }
    #loadout-menu .lo-abil-trigger {
      display: inline-block;
      font-size: 9px;
      font-weight: 800;
      letter-spacing: 0.2em;
      color: #46301a;
      background: linear-gradient(180deg, #cde98a, #a8d94a);
      border-radius: 8px;
      padding: 3px 9px;
    }
    #loadout-menu .lo-abil-name {
      margin-top: 7px;
      font-size: 14px;
      font-weight: 800;
      letter-spacing: 0.14em;
      color: #ffe9b0;
    }
    #loadout-menu .lo-abil-desc {
      margin-top: 5px;
      font-size: 12px;
      line-height: 1.45;
      color: rgba(245, 234, 210, 0.78);
    }
    #loadout-menu .lo-abil-stats {
      display: grid;
      grid-template-columns: repeat(2, 1fr);
      gap: 6px;
      margin-top: 10px;
    }
    #loadout-menu .lo-stat {
      display: flex;
      flex-direction: column;
      gap: 2px;
      background: rgba(124, 181, 24, 0.14);
      border: 1px solid rgba(183, 224, 95, 0.35);
      border-radius: 10px;
      padding: 6px 9px;
    }
    #loadout-menu .lo-stat-label {
      font-size: 8px;
      font-weight: 700;
      letter-spacing: 0.18em;
      color: rgba(245, 234, 210, 0.6);
    }
    #loadout-menu .lo-stat-value {
      font-size: 12px;
      font-weight: 800;
      letter-spacing: 0.04em;
      color: #b7e05f;
    }

    #loadout-menu .lo-equip {
      margin-top: 16px;
      flex-shrink: 0;
      width: 100%;
      background: linear-gradient(180deg, #a8d94a, #78ac1e);
      border: 3px solid #4c6b1f;
      border-radius: 16px;
      color: #ffffff;
      font-family: "Luckiest Guy", cursive;
      font-size: 17px;
      letter-spacing: 0.12em;
      text-shadow: 0 2px 0 rgba(60, 90, 20, 0.6);
      padding: 12px 0 10px;
      cursor: pointer;
      box-shadow: 0 5px 0 #4c6b1f;
      transition: transform 0.1s ease, box-shadow 0.1s ease, filter 0.15s ease;
    }
    #loadout-menu .lo-equip:hover:not(:disabled) { filter: brightness(1.1); }
    #loadout-menu .lo-equip:active:not(:disabled) {
      transform: translateY(4px);
      box-shadow: 0 1px 0 #4c6b1f;
    }
    #loadout-menu .lo-equip:disabled { cursor: default; }
    #loadout-menu .lo-equip.equipped {
      background: linear-gradient(180deg, #ffd75e, #e0a72e);
      border-color: #8a6414;
      box-shadow: 0 5px 0 #8a6414;
      text-shadow: 0 2px 0 rgba(120, 84, 12, 0.55);
    }
    #loadout-menu .lo-equip:disabled:not(.equipped) {
      filter: grayscale(0.7);
      opacity: 0.65;
    }

    /* ---- Scrollbars stay on-theme ---- */
    #loadout-menu .lo-grid::-webkit-scrollbar,
    #loadout-menu .lo-d-scroll::-webkit-scrollbar { width: 9px; }
    #loadout-menu .lo-grid::-webkit-scrollbar-thumb {
      background: rgba(107, 74, 43, 0.55);
      border-radius: 8px;
    }
    #loadout-menu .lo-d-scroll::-webkit-scrollbar-thumb {
      background: rgba(255, 226, 178, 0.28);
      border-radius: 8px;
    }

    @media (max-width: 920px) {
      #loadout-menu .lo-frame {
        grid-template-columns: 1fr;
        grid-template-rows: 1fr auto;
        height: 92vh;
      }
      #loadout-menu .lo-detail { order: 2; max-height: 44vh; }
      #loadout-menu .lo-board { order: 1; min-height: 0; }
      #loadout-menu .lo-tabs { flex-wrap: wrap; }
    }
  `;
  document.head.appendChild(style);
}