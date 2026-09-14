import { MenuAudio } from "./MenuAudio";
import { CustomizePreview } from "./CustomizePreview";
import { injectCustomizeStyles } from "./CustomizeStyles";
import {
  CHARACTER_CATEGORIES,
  EMOTE_PLACEHOLDERS,
  RARITIES,
  WEAPON_SKIN_SETS,
  sortByRarity,
  type SkinCard,
  type WeaponSkinSet,
} from "./CustomizeCatalog";
import { loadWeaponSkin, saveWeaponSkin } from "../loadout/Cosmetics";
import { loadLoadout, type PrimaryWeaponId } from "../loadout/Loadout";
import { getWeaponIconUrl, hasWeaponIcon } from "./WeaponIconRenderer";
import { DEFAULT_WEAPON_SKIN } from "../../shared/combat/WeaponSkins";
import logoUrl from "../assets/logo.png";
import haricotUrl from "../assets/haricot.png";

type MainTab = "character" | "weapons" | "emotes";

/**
 * CUSTOMIZE overlay — "Ton haricot. Ton style." Same bean-prairie cartoon
 * theme as the Loadout menu (parchment board, wooden preview panel, leafy
 * green tabs, chunky rounded cards), laid out like the reference mocks:
 *
 *   ┌ logo + CUSTOMIZE ──── PERSONNAGE | ARMES | EMOTES ──── ✕ RETOUR ┐
 *   │ [APERÇU 3D, faire tourner]  │ sous-onglets / sélecteur d'arme    │
 *   │                             │ recherche · N skins                 │
 *   │                             │ grille de cartes bleues (rareté)   │
 *   ├─ [icône] NOM · Type · Rareté ───────────── [ ÉQUIPER CE SKIN ] ─┤
 *
 * ARMES is live for the GoofyBasket (4 pack skins previewed on the REAL
 * ball through the shared skin runtime); other weapons, PERSONNAGE and
 * EMOTES are placeholders. "ÉQUIPER" persists via saveWeaponSkin(); the
 * game re-reads the cosmetics when entering the match / on respawn.
 */
export class CustomizeMenu {
  onClose: (() => void) | null = null;

  private readonly root: HTMLElement;
  private readonly tabsEl: HTMLElement;
  private readonly subEl: HTMLElement;
  private readonly toolbarEl: HTMLElement;
  private readonly gridEl: HTMLElement;
  private readonly footerEl: HTMLElement;
  private readonly previewEl: HTMLElement;
  private readonly previewTitleEl: HTMLElement;
  private readonly previewSubEl: HTMLElement;
  private readonly chargeEl: HTMLElement;
  private readonly preview: CustomizePreview;

  private tab: MainTab = "weapons";
  private weaponSet: WeaponSkinSet = WEAPON_SKIN_SETS[0];
  private characterCategory = CHARACTER_CATEGORIES[0];
  /** Card currently INSPECTED / previewed (not necessarily equipped). */
  private inspectedId = DEFAULT_WEAPON_SKIN;
  private search = "";

  constructor(private readonly sounds: MenuAudio) {
    injectCustomizeStyles();
    this.preview = new CustomizePreview();

    this.root = document.createElement("div");
    this.root.id = "customize-menu";
    this.root.innerHTML = `
      <div class="cz-frame">
        <img class="cz-leaf cz-leaf-tl" src="${haricotUrl}" alt="" draggable="false">
        <img class="cz-leaf cz-leaf-br" src="${haricotUrl}" alt="" draggable="false">
        <header class="cz-header">
          <div class="cz-brand">
            <img class="cz-logo" src="${logoUrl}" alt="Beanzo.io" draggable="false">
            <div>
              <div class="cz-title">CUSTOMIZE</div>
              <div class="cz-subtitle">TON HARICOT. TON STYLE.</div>
            </div>
          </div>
          <nav class="cz-tabs"></nav>
          <button class="cz-back" type="button">✕ RETOUR</button>
        </header>
        <section class="cz-body">
          <aside class="cz-preview">
            <div class="cz-preview-badge">APERÇU</div>
            <div class="cz-preview-stage"></div>
            <div class="cz-preview-caption">
              <div class="cz-preview-name"></div>
              <div class="cz-preview-sub"></div>
            </div>
            <div class="cz-charge">
              <span class="cz-charge-label">CHARGE</span>
              <input class="cz-charge-input" type="range" min="0" max="100" value="0">
              <span class="cz-charge-value">0%</span>
            </div>
            <div class="cz-turn">
              <button class="cz-turn-btn" data-dir="-1" type="button">‹</button>
              <span class="cz-turn-label">FAIRE TOURNER</span>
              <button class="cz-turn-btn" data-dir="1" type="button">›</button>
            </div>
            <button class="cz-reset" type="button">RÉINITIALISER L'APERÇU</button>
          </aside>
          <section class="cz-board">
            <div class="cz-sub"></div>
            <div class="cz-toolbar"></div>
            <div class="cz-grid"></div>
          </section>
        </section>
        <footer class="cz-footer"></footer>
      </div>
    `;
    document.body.appendChild(this.root);

    this.tabsEl = this.root.querySelector(".cz-tabs")!;
    this.subEl = this.root.querySelector(".cz-sub")!;
    this.toolbarEl = this.root.querySelector(".cz-toolbar")!;
    this.gridEl = this.root.querySelector(".cz-grid")!;
    this.footerEl = this.root.querySelector(".cz-footer")!;
    this.previewEl = this.root.querySelector(".cz-preview")!;
    this.previewTitleEl = this.root.querySelector(".cz-preview-name")!;
    this.previewSubEl = this.root.querySelector(".cz-preview-sub")!;
    this.chargeEl = this.root.querySelector(".cz-charge")!;
    this.root.querySelector(".cz-preview-stage")!.appendChild(this.preview.canvas);

    this.wireStaticControls();
    this.renderTabs();
    this.setTab("weapons");
  }

  // ------------------------------------------------------------------
  // Open / close
  // ------------------------------------------------------------------

  private readonly onKeyDown = (e: KeyboardEvent): void => {
    if (e.code === "Escape" && this.isOpen) this.close();
  };

  get isOpen(): boolean {
    return this.root.classList.contains("open");
  }

  open(): void {
    // Land on the weapon the player actually plays (its skin is what matters).
    const primary = loadLoadout().primary;
    this.weaponSet = WEAPON_SKIN_SETS.find((s) => s.weapon === primary) ?? WEAPON_SKIN_SETS[0];
    this.setTab("weapons");
    this.root.classList.add("open");
    this.preview.start();
    document.addEventListener("keydown", this.onKeyDown);
  }

  close(): void {
    if (!this.isOpen) return;
    this.root.classList.remove("open");
    this.preview.stop();
    document.removeEventListener("keydown", this.onKeyDown);
    this.onClose?.();
  }

  dispose(): void {
    document.removeEventListener("keydown", this.onKeyDown);
    this.preview.dispose();
    this.root.remove();
  }

  // ------------------------------------------------------------------
  // Static controls (preview panel + back)
  // ------------------------------------------------------------------

  private wireStaticControls(): void {
    const hover = (el: Element) => el.addEventListener("pointerenter", () => this.sounds.hover());
    const back = this.root.querySelector<HTMLButtonElement>(".cz-back")!;
    hover(back);
    back.addEventListener("click", () => {
      this.sounds.click();
      this.close();
    });
    for (const btn of this.root.querySelectorAll<HTMLButtonElement>(".cz-turn-btn")) {
      hover(btn);
      btn.addEventListener("click", () => {
        this.sounds.click();
        this.preview.spin(btn.dataset.dir === "-1" ? -1 : 1);
      });
    }
    const reset = this.root.querySelector<HTMLButtonElement>(".cz-reset")!;
    hover(reset);
    const chargeInput = this.root.querySelector<HTMLInputElement>(".cz-charge-input")!;
    const chargeValue = this.root.querySelector<HTMLElement>(".cz-charge-value")!;
    reset.addEventListener("click", () => {
      this.sounds.click();
      this.preview.resetView();
      chargeInput.value = "0";
      chargeValue.textContent = "0%";
      this.inspectedId = this.equippedId();
      this.refreshBoard();
    });
    chargeInput.addEventListener("input", () => {
      const v = Number(chargeInput.value) / 100;
      chargeValue.textContent = `${Math.round(v * 100)}%`;
      this.preview.setCharge(v);
    });
  }

  // ------------------------------------------------------------------
  // Main tabs
  // ------------------------------------------------------------------

  private renderTabs(): void {
    const tabs: { key: MainTab; label: string }[] = [
      { key: "character", label: "PERSONNAGE" },
      { key: "weapons", label: "ARMES" },
      { key: "emotes", label: "EMOTES" },
    ];
    this.tabsEl.innerHTML = "";
    for (const t of tabs) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "cz-tab";
      btn.dataset.tab = t.key;
      btn.textContent = t.label;
      btn.addEventListener("pointerenter", () => this.sounds.hover());
      btn.addEventListener("click", () => {
        this.sounds.click();
        this.setTab(t.key);
      });
      this.tabsEl.appendChild(btn);
    }
  }

  private setTab(tab: MainTab): void {
    this.tab = tab;
    this.search = "";
    for (const btn of this.tabsEl.querySelectorAll<HTMLButtonElement>(".cz-tab")) {
      btn.classList.toggle("active", btn.dataset.tab === tab);
    }
    this.inspectedId = this.equippedId();
    this.refreshBoard();
  }

  /** Equipped id in the current context (weapons: persisted skin; others: none). */
  private equippedId(): string {
    if (this.tab === "weapons") return loadWeaponSkin(this.weaponSet.weapon);
    return "";
  }

  private currentCards(): SkinCard[] {
    let cards: SkinCard[];
    if (this.tab === "weapons") cards = sortByRarity(this.weaponSet.skins);
    else if (this.tab === "character") cards = this.characterCategory.items;
    else cards = EMOTE_PLACEHOLDERS;
    if (this.search) {
      const q = this.search.toLowerCase();
      cards = cards.filter((c) => c.name.toLowerCase().includes(q));
    }
    return cards;
  }

  private refreshBoard(): void {
    this.renderSub();
    this.renderToolbar();
    this.renderGrid();
    this.renderFooter();
    this.renderPreviewCaption();
  }

  private inspectedCard(): SkinCard | null {
    const cards = this.currentCards();
    return cards.find((c) => c.id === this.inspectedId) ?? cards[0] ?? null;
  }

  // ------------------------------------------------------------------
  // Sub-navigation (weapon selector / character categories)
  // ------------------------------------------------------------------

  private renderSub(): void {
    this.subEl.innerHTML = "";
    if (this.tab === "weapons") {
      for (const set of WEAPON_SKIN_SETS) {
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = "cz-subtab cz-weapon-tab";
        if (set === this.weaponSet) btn.classList.add("active");
        const live = set.skins.some((s) => !s.locked && s.id !== DEFAULT_WEAPON_SKIN);
        btn.innerHTML = `
          <span class="cz-subtab-icon"></span>
          <span class="cz-subtab-label">${set.weaponName}</span>
          ${live ? `<span class="cz-subtab-badge">${set.skins.length - 1}</span>` : ""}
        `;
        this.mountIcon(btn.querySelector(".cz-subtab-icon")!, set.weapon, DEFAULT_WEAPON_SKIN);
        btn.addEventListener("pointerenter", () => this.sounds.hover());
        btn.addEventListener("click", () => {
          if (set === this.weaponSet) return;
          this.sounds.click();
          this.weaponSet = set;
          this.search = "";
          this.inspectedId = this.equippedId();
          this.refreshBoard();
        });
        this.subEl.appendChild(btn);
      }
    } else if (this.tab === "character") {
      for (const cat of CHARACTER_CATEGORIES) {
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = "cz-subtab";
        if (cat === this.characterCategory) btn.classList.add("active");
        btn.innerHTML = `
          <svg class="cz-subtab-svg" viewBox="0 0 24 24" aria-hidden="true"><path d="${cat.icon}"/></svg>
          <span class="cz-subtab-label">${cat.label}</span>
        `;
        btn.addEventListener("pointerenter", () => this.sounds.hover());
        btn.addEventListener("click", () => {
          if (cat === this.characterCategory) return;
          this.sounds.click();
          this.characterCategory = cat;
          this.search = "";
          this.inspectedId = "";
          this.refreshBoard();
        });
        this.subEl.appendChild(btn);
      }
    } else {
      const note = document.createElement("div");
      note.className = "cz-sub-note";
      note.textContent = "Les emotes arrivent bientôt — voici un aperçu de la collection.";
      this.subEl.appendChild(note);
    }
  }

  // ------------------------------------------------------------------
  // Toolbar (search + counter)
  // ------------------------------------------------------------------

  private renderToolbar(): void {
    const total = this.currentCards().length;
    const label =
      this.tab === "weapons" ? "skins" : this.tab === "character" ? "objets" : "emotes";
    this.toolbarEl.innerHTML = `
      <label class="cz-search">
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <circle cx="10.5" cy="10.5" r="6" fill="none" stroke="currentColor" stroke-width="2.4"/>
          <path d="M15 15l5 5" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"/>
        </svg>
        <input type="text" placeholder="Rechercher…" value="${escapeAttr(this.search)}">
      </label>
      <div class="cz-count"><b>${total}</b> ${label}</div>
      <div class="cz-sort">Tri : <b>Rareté</b></div>
    `;
    const input = this.toolbarEl.querySelector<HTMLInputElement>("input")!;
    input.addEventListener("input", () => {
      this.search = input.value.trim();
      this.renderGrid();
      const count = this.toolbarEl.querySelector<HTMLElement>(".cz-count b");
      if (count) count.textContent = String(this.currentCards().length);
    });
  }

  // ------------------------------------------------------------------
  // Card grid
  // ------------------------------------------------------------------

  private renderGrid(): void {
    this.gridEl.innerHTML = "";
    const cards = this.currentCards();
    if (cards.length === 0) {
      const empty = document.createElement("div");
      empty.className = "cz-empty";
      empty.textContent = "Aucun résultat.";
      this.gridEl.appendChild(empty);
      return;
    }
    const equipped = this.equippedId();
    for (const card of cards) {
      const rarity = RARITIES[card.rarity];
      const el = document.createElement("button");
      el.type = "button";
      el.className = `cz-card rarity-${card.rarity}`;
      el.style.setProperty("--rarity", rarity.color);
      if (card.id === this.inspectedId) el.classList.add("inspected");
      if (card.locked) el.classList.add("locked");
      const isEquipped = !card.locked && card.id === equipped;
      el.innerHTML = `
        ${isEquipped ? `<div class="cz-card-check">✔</div>` : ""}
        ${card.locked ? `<div class="cz-card-lock">🔒</div>` : ""}
        <div class="cz-card-icon"></div>
        <div class="cz-card-name">${card.name}</div>
        <div class="cz-card-rarity">${rarity.label}</div>
      `;
      const holder = el.querySelector<HTMLElement>(".cz-card-icon")!;
      if (this.tab === "weapons") this.mountIcon(holder, this.weaponSet.weapon, card.id);
      else this.mountPlaceholderIcon(holder, card);
      el.addEventListener("pointerenter", () => this.sounds.hover());
      el.addEventListener("click", () => {
        this.sounds.click();
        this.inspectedId = card.id;
        for (const other of this.gridEl.querySelectorAll<HTMLElement>(".cz-card")) {
          other.classList.toggle("inspected", other === el);
        }
        this.renderFooter(true);
        this.renderPreviewCaption();
      });
      this.gridEl.appendChild(el);
    }
  }

  /** Weapon icon with the given skin (3D snapshot, cache keyed weapon+skin). */
  private mountIcon(holder: HTMLElement, weapon: PrimaryWeaponId, skinId: string): void {
    if (!hasWeaponIcon(weapon)) {
      const emoji = document.createElement("span");
      emoji.className = "cz-icon-emoji";
      emoji.textContent = "🫘";
      holder.appendChild(emoji);
      return;
    }
    const img = document.createElement("img");
    img.alt = "";
    img.draggable = false;
    img.addEventListener("load", () => img.classList.add("ready"));
    holder.appendChild(img);
    // Placeholder skins ("__soon_*") sanitize to the default icon.
    void getWeaponIconUrl(weapon, skinId).then((url) => {
      if (url && img.isConnected) img.src = url;
    });
  }

  /** Placeholder visuals (character / emotes): a bean silhouette tinted by rarity. */
  private mountPlaceholderIcon(holder: HTMLElement, card: SkinCard): void {
    const img = document.createElement("img");
    img.className = "cz-icon-placeholder ready";
    img.src = haricotUrl;
    img.alt = "";
    img.draggable = false;
    holder.appendChild(img);
    const tag = document.createElement("span");
    tag.className = "cz-icon-soon";
    tag.textContent = "BIENTÔT";
    tag.style.setProperty("--rarity", RARITIES[card.rarity].color);
    holder.appendChild(tag);
  }

  // ------------------------------------------------------------------
  // Preview caption (left panel)
  // ------------------------------------------------------------------

  private renderPreviewCaption(): void {
    const card = this.inspectedCard();
    if (this.tab === "weapons") {
      this.previewEl.classList.remove("placeholder");
      const isBasket = this.weaponSet.weapon === "GOOFY_BASKET";
      this.chargeEl.style.display = isBasket ? "" : "none";
      const skinId = card && !card.locked ? card.id : DEFAULT_WEAPON_SKIN;
      // Live 3D preview only exists for the GoofyBasket today; the other
      // weapons show their icon snapshot instead.
      if (isBasket) {
        this.preview.setSkin(skinId);
        this.preview.canvas.style.display = "";
        this.clearPreviewFallback();
      } else {
        this.preview.setSkin(DEFAULT_WEAPON_SKIN);
        this.preview.canvas.style.display = "none";
        this.showPreviewFallback(this.weaponSet.weapon);
      }
      this.previewTitleEl.textContent = card ? card.name : this.weaponSet.weaponName;
      this.previewSubEl.textContent = card
        ? `${this.weaponSet.weaponName} · ${RARITIES[card.rarity].label}`
        : "";
      this.previewSubEl.style.setProperty("--rarity", card ? RARITIES[card.rarity].color : "#c9d3dd");
    } else {
      this.previewEl.classList.add("placeholder");
      this.chargeEl.style.display = "none";
      this.preview.setSkin(DEFAULT_WEAPON_SKIN);
      this.preview.canvas.style.display = "none";
      this.showPreviewFallback(null);
      this.previewTitleEl.textContent = card
        ? card.name
        : this.tab === "character"
          ? "TON HARICOT"
          : "EMOTES";
      this.previewSubEl.textContent = card
        ? `${RARITIES[card.rarity].label} · bientôt disponible`
        : "Aperçu bientôt disponible";
      this.previewSubEl.style.setProperty("--rarity", card ? RARITIES[card.rarity].color : "#c9d3dd");
    }
  }

  private showPreviewFallback(weapon: PrimaryWeaponId | null): void {
    const stage = this.previewEl.querySelector<HTMLElement>(".cz-preview-stage")!;
    let fallback = stage.querySelector<HTMLElement>(".cz-preview-fallback");
    if (!fallback) {
      fallback = document.createElement("div");
      fallback.className = "cz-preview-fallback";
      stage.appendChild(fallback);
    }
    fallback.innerHTML = "";
    if (weapon) this.mountIcon(fallback, weapon, DEFAULT_WEAPON_SKIN);
    else {
      const bean = document.createElement("img");
      bean.className = "cz-preview-bean";
      bean.src = haricotUrl;
      bean.alt = "";
      bean.draggable = false;
      fallback.appendChild(bean);
    }
  }

  private clearPreviewFallback(): void {
    this.previewEl.querySelector(".cz-preview-fallback")?.remove();
  }

  // ------------------------------------------------------------------
  // Footer (name · type · rarity + ÉQUIPER)
  // ------------------------------------------------------------------

  private renderFooter(pop = false): void {
    const card = this.inspectedCard();
    if (!card) {
      this.footerEl.innerHTML = "";
      return;
    }
    const rarity = RARITIES[card.rarity];
    const equipped = this.tab === "weapons" && !card.locked && card.id === this.equippedId();
    const typeLabel =
      this.tab === "weapons"
        ? `Skin · ${this.weaponSet.weaponName}`
        : this.tab === "character"
          ? `Objet · ${this.characterCategory.label}`
          : "Emote";
    this.footerEl.innerHTML = `
      <div class="cz-footer-icon" style="--rarity:${rarity.color}"></div>
      <div class="cz-footer-text">
        <div class="cz-footer-name">${card.name}</div>
        <div class="cz-footer-meta">
          <span>${typeLabel}</span>
          <span class="cz-footer-rarity" style="--rarity:${rarity.color}">${rarity.label}</span>
          ${card.tagline ? `<span class="cz-footer-tagline">${card.tagline}</span>` : ""}
        </div>
      </div>
      <button class="cz-equip ${equipped ? "equipped" : ""}" type="button" ${card.locked || equipped ? "disabled" : ""}>
        ${card.locked ? "🔒 BIENTÔT" : equipped ? "✔ ÉQUIPÉ" : "ÉQUIPER CE SKIN"}
      </button>
    `;
    const holder = this.footerEl.querySelector<HTMLElement>(".cz-footer-icon")!;
    if (this.tab === "weapons") this.mountIcon(holder, this.weaponSet.weapon, card.id);
    else this.mountPlaceholderIcon(holder, card);

    if (pop) {
      this.footerEl.classList.remove("pop");
      void this.footerEl.offsetWidth; // reflow → animation restarts
      this.footerEl.classList.add("pop");
    }

    const equipBtn = this.footerEl.querySelector<HTMLButtonElement>(".cz-equip")!;
    equipBtn.addEventListener("pointerenter", () => this.sounds.hover());
    equipBtn.addEventListener("click", () => {
      if (card.locked || this.tab !== "weapons" || card.id === this.equippedId()) return;
      this.sounds.click();
      // Cosmetic only: persisted in its OWN store (never a loadout change).
      saveWeaponSkin(this.weaponSet.weapon, card.id);
      this.renderSub();
      this.renderGrid();
      this.renderFooter();
    });
  }
}

function escapeAttr(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
}

