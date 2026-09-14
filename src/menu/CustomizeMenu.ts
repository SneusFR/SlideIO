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
 *   │ APERÇU ········ [EFFETS] │ CHOISIR UN SKIN · N skins  [arme ▾]  │
 *   │  ‹  [ballon 3D]  ›       │ 🔍 recherche ············ [Rareté ▾] │
 *   │  Glisser pour tourner    │ grille de cartes bleues              │
 *   │  (RARETÉ) NOM · tagline  │   ✓ ÉQUIPÉ / APERÇU badges           │
 *   │  Skin de Goofy Basket    │                                      │
 *   │ [   ÉQUIPER CE SKIN    ] │ note (cosmétique / équipé / bientôt) │
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
  private readonly previewRarityEl: HTMLElement;
  private readonly previewOwnerEl: HTMLElement;
  private readonly boardTitleEl: HTMLElement;
  private readonly boardCountEl: HTMLElement;
  private readonly boardFootEl: HTMLElement;
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
            <div class="cz-preview-top">
              <div class="cz-preview-badge">APERÇU</div>
              <label class="cz-fx">
                <span>EFFETS</span>
                <input class="cz-fx-input" type="checkbox" checked>
                <span class="cz-fx-track"><span class="cz-fx-knob"></span></span>
              </label>
            </div>
            <div class="cz-preview-stage">
              <button class="cz-preview-arrow cz-preview-arrow-l" type="button" aria-label="Tourner à gauche">‹</button>
              <button class="cz-preview-arrow cz-preview-arrow-r" type="button" aria-label="Tourner à droite">›</button>
            </div>
            <div class="cz-preview-hint">Glisser pour tourner</div>
            <div class="cz-preview-caption">
              <div class="cz-preview-rarity"></div>
              <div class="cz-preview-name"></div>
              <div class="cz-preview-sub"></div>
              <div class="cz-preview-owner"></div>
            </div>
            <footer class="cz-footer"></footer>
          </aside>
          <section class="cz-board">
            <div class="cz-board-head">
              <div class="cz-board-heading">
                <div class="cz-board-title"></div>
                <div class="cz-board-count"></div>
              </div>
              <div class="cz-sub"></div>
            </div>
            <div class="cz-toolbar"></div>
            <div class="cz-grid"></div>
            <div class="cz-board-foot"></div>
          </section>
        </section>
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
    this.previewRarityEl = this.root.querySelector(".cz-preview-rarity")!;
    this.previewOwnerEl = this.root.querySelector(".cz-preview-owner")!;
    this.boardTitleEl = this.root.querySelector(".cz-board-title")!;
    this.boardCountEl = this.root.querySelector(".cz-board-count")!;
    this.boardFootEl = this.root.querySelector(".cz-board-foot")!;
    // Canvas goes UNDER the ‹ › arrows (they're absolutely positioned).
    this.root.querySelector(".cz-preview-stage")!.prepend(this.preview.canvas);

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

    // EFFETS toggle: aura / plasma of the previewed skin on or off.
    const fx = this.root.querySelector<HTMLInputElement>(".cz-fx-input")!;
    hover(fx.parentElement!);
    fx.addEventListener("change", () => {
      this.sounds.click();
      this.preview.setEffectsEnabled(fx.checked);
    });

    // ‹ › arrows: give the turntable a push in either direction.
    for (const arrow of this.root.querySelectorAll<HTMLButtonElement>(".cz-preview-arrow")) {
      hover(arrow);
      arrow.addEventListener("click", () => {
        this.sounds.click();
        this.preview.nudge(arrow.classList.contains("cz-preview-arrow-l") ? -1 : 1);
      });
    }
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
    this.renderHeading();
    this.renderSub();
    this.renderToolbar();
    this.renderGrid();
    this.renderFooter();
    this.renderPreviewCaption();
  }

  /** "CHOISIR UN SKIN · 5 skins disponibles" above the grid. */
  private renderHeading(): void {
    const total = this.currentCards().length;
    if (this.tab === "weapons") {
      this.boardTitleEl.textContent = "CHOISIR UN SKIN";
      this.boardCountEl.textContent = `${total} skin${total > 1 ? "s" : ""} disponible${total > 1 ? "s" : ""}`;
    } else if (this.tab === "character") {
      this.boardTitleEl.textContent = "TON HARICOT";
      this.boardCountEl.textContent = `${total} objet${total > 1 ? "s" : ""} · bientôt`;
    } else {
      this.boardTitleEl.textContent = "EMOTES";
      this.boardCountEl.textContent = `${total} emote${total > 1 ? "s" : ""} · bientôt`;
    }
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
      // Weapon picker: icon · <select> · chevron, styled like the mock's dropdown.
      const wrap = document.createElement("label");
      wrap.className = "cz-weapon-select";
      wrap.innerHTML = `
        <span class="cz-subtab-icon"></span>
        <select aria-label="Arme"></select>
        <svg class="cz-chevron" viewBox="0 0 24 24" aria-hidden="true">
          <path d="M6 9l6 6 6-6" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/>
        </svg>
      `;
      this.mountIcon(wrap.querySelector(".cz-subtab-icon")!, this.weaponSet.weapon, DEFAULT_WEAPON_SKIN);
      const select = wrap.querySelector<HTMLSelectElement>("select")!;
      for (const set of WEAPON_SKIN_SETS) {
        const opt = document.createElement("option");
        opt.value = set.weapon;
        const live = set.skins.some((s) => !s.locked && s.id !== DEFAULT_WEAPON_SKIN);
        opt.textContent = live ? `${set.weaponName}  (${set.skins.length - 1} skins)` : set.weaponName;
        opt.selected = set === this.weaponSet;
        select.appendChild(opt);
      }
      wrap.addEventListener("pointerenter", () => this.sounds.hover());
      select.addEventListener("change", () => {
        const set = WEAPON_SKIN_SETS.find((s) => s.weapon === select.value);
        if (!set || set === this.weaponSet) return;
        this.sounds.click();
        this.weaponSet = set;
        this.search = "";
        this.inspectedId = this.equippedId();
        this.refreshBoard();
      });
      this.subEl.appendChild(wrap);
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
    const what = this.tab === "weapons" ? "un skin" : this.tab === "character" ? "un objet" : "une emote";
    this.toolbarEl.innerHTML = `
      <label class="cz-search">
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <circle cx="10.5" cy="10.5" r="6" fill="none" stroke="currentColor" stroke-width="2.4"/>
          <path d="M15 15l5 5" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"/>
        </svg>
        <input type="text" placeholder="Rechercher ${what}..." value="${escapeAttr(this.search)}">
      </label>
      <div class="cz-sort" title="Les cartes sont triées par rareté">
        <span>Rareté</span>
        <svg class="cz-chevron" viewBox="0 0 24 24" aria-hidden="true">
          <path d="M6 9l6 6 6-6" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/>
        </svg>
      </div>
    `;
    const input = this.toolbarEl.querySelector<HTMLInputElement>("input")!;
    input.addEventListener("input", () => {
      this.search = input.value.trim();
      this.renderGrid();
      this.renderHeading();
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
        ${isEquipped ? `<div class="cz-card-check">✓ ÉQUIPÉ</div>` : ""}
        <div class="cz-card-peek">APERÇU</div>
        ${card.locked ? `<div class="cz-card-lock">🔒</div>` : ""}
        <div class="cz-card-icon"></div>
        <div class="cz-card-name">${card.name}</div>
        <div class="cz-card-rarity"><i class="cz-dot"></i>${rarity.label}</div>
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
      this.previewSubEl.textContent = card?.tagline ?? "";
      this.previewOwnerEl.textContent = `Skin de ${titleCase(this.weaponSet.weaponName)}`;
      this.setPreviewRarity(card);
    } else {
      this.previewEl.classList.add("placeholder");
      this.preview.setSkin(DEFAULT_WEAPON_SKIN);
      this.preview.canvas.style.display = "none";
      this.showPreviewFallback(null);
      this.previewTitleEl.textContent = card
        ? card.name
        : this.tab === "character"
          ? "TON HARICOT"
          : "EMOTES";
      this.previewSubEl.textContent = card ? (card.tagline ?? "Bientôt disponible") : "Aperçu bientôt disponible";
      this.previewOwnerEl.textContent =
        this.tab === "character" ? `Objet · ${this.characterCategory.label}` : "Emote";
      this.setPreviewRarity(card);
    }
  }

  /** Rarity pill above the previewed name (hidden when nothing is inspected). */
  private setPreviewRarity(card: SkinCard | null): void {
    if (!card) {
      this.previewRarityEl.style.display = "none";
      return;
    }
    const rarity = RARITIES[card.rarity];
    this.previewRarityEl.style.display = "";
    this.previewRarityEl.textContent = rarity.label;
    this.previewRarityEl.style.setProperty("--rarity", rarity.color);
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
      this.boardFootEl.textContent = "";
      return;
    }
    const equipped = this.tab === "weapons" && !card.locked && card.id === this.equippedId();
    const label = this.tab === "weapons" ? "CE SKIN" : this.tab === "character" ? "CET OBJET" : "CETTE EMOTE";
    this.footerEl.innerHTML = `
      <button class="cz-equip ${equipped ? "equipped" : ""}" type="button" ${card.locked || equipped ? "disabled" : ""}>
        ${card.locked ? "🔒 BIENTÔT" : equipped ? "✔ ÉQUIPÉ" : `ÉQUIPER ${label}`}
      </button>
    `;
    // Right-side note under the grid: what the button will do.
    this.boardFootEl.textContent = card.locked
      ? "Cet élément arrive bientôt — il n'est pas encore équipable."
      : equipped
        ? `${card.name} est équipé · appliqué en partie et au respawn.`
        : `Cosmétique uniquement · aucun impact sur le gameplay.`;

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

/** "GOOFY BASKET" → "Goofy Basket" (weapon names are stored upper-case). */
function titleCase(value: string): string {
  return value.toLowerCase().replace(/(^|[\s-])\p{L}/gu, (m) => m.toUpperCase());
}

function escapeAttr(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
}

