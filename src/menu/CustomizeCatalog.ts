import type { PrimaryWeaponId } from "../loadout/Loadout";
import { PRIMARY_ITEMS } from "../loadout/Loadout";
import { DEFAULT_WEAPON_SKIN } from "../../shared/combat/WeaponSkins";
import { BASKET_SKINS } from "../weapons/goofybasket/skins/runtime/GoofyBasketSkins";
import { CHARACTER_COSMETIC_IDS, type CharacterCosmeticSlot } from "../../shared/combat/CharacterCosmetics";
import { DEFAULT_CHARACTER_COSMETIC } from "../loadout/Cosmetics";
// Potato Astronaut pack: ids + labels from catalog.astronaut.json, icons
// from the pack's apercus/icones (512×512 transparent PNGs).
import astronautCatalog from "../cosmetics/astronaut/catalog.astronaut.json";
import astroBootsIcon from "../cosmetics/astronaut/icons/Bottes.png";
import astroPantsIcon from "../cosmetics/astronaut/icons/Pantalon.png";
import astroTopIcon from "../cosmetics/astronaut/icons/Haut.png";
import astroBagIcon from "../cosmetics/astronaut/icons/Sac.png";
import astroHelmetIcon from "../cosmetics/astronaut/icons/Casque.png";

/**
 * Display catalog of the CUSTOMIZE menu. Skins are pure cosmetics: the
 * GoofyBasket entries come straight from the integration pack's catalog
 * (ids validated by shared/combat/WeaponSkins.ts); everything else is a
 * PLACEHOLDER waiting for its assets (locked cards, "bientôt").
 */

export type Rarity = "standard" | "peu_commun" | "rare" | "epique" | "legendaire";

export interface RarityStyle {
  label: string;
  /** CSS color of the rarity label / accents. */
  color: string;
}

export const RARITIES: Record<Rarity, RarityStyle> = {
  standard: { label: "STANDARD", color: "#c9d3dd" },
  peu_commun: { label: "PEU COMMUN", color: "#7ddc4c" },
  rare: { label: "RARE", color: "#5fb8ff" },
  epique: { label: "ÉPIQUE", color: "#c07dff" },
  legendaire: { label: "LÉGENDAIRE", color: "#ffbd3a" },
};

/** Sort weight — used by the "Rareté" ordering of the grid. */
const RARITY_ORDER: Record<Rarity, number> = {
  standard: 0,
  peu_commun: 1,
  rare: 2,
  epique: 3,
  legendaire: 4,
};

export interface SkinCard {
  id: string;
  name: string;
  rarity: Rarity;
  /** Short flavor line under the name in the bottom bar. */
  tagline?: string;
  /** Not equippable yet (placeholder / assets pending). */
  locked?: boolean;
  /** Real card icon (character pieces) — placeholders use the bean. */
  icon?: string;
}

export interface WeaponSkinSet {
  weapon: PrimaryWeaponId;
  weaponName: string;
  skins: SkinCard[];
}

function rarityFromPack(label: string): Rarity {
  const key = label.toLowerCase();
  if (key.startsWith("peu")) return "peu_commun";
  if (key.startsWith("rare")) return "rare";
  if (key.startsWith("epic") || key.startsWith("épi")) return "epique";
  if (key.startsWith("lég") || key.startsWith("leg")) return "legendaire";
  return "standard";
}

const DEFAULT_CARD: SkinCard = {
  id: DEFAULT_WEAPON_SKIN,
  name: "CLASSIQUE",
  rarity: "standard",
  tagline: "L'apparence d'origine",
};

const GOOFY_BASKET_TAGLINES: Record<string, string> = {
  mandarine: "Orange vitaminée, rainures charbon",
  street_pop: "Crème, corail, violet — graphismes imprimés",
  haute_tension: "Circuits cyan et arcs électriques",
  eclipse_solaire: "Roche noire, lave vivante et plasma solaire",
};

/** Primary weapons in the loadout catalog order — each keeps its own skin. */
export const WEAPON_SKIN_SETS: WeaponSkinSet[] = PRIMARY_ITEMS.map((item) => {
  const weapon = item.id as PrimaryWeaponId;
  const skins: SkinCard[] = [DEFAULT_CARD];
  if (weapon === "GOOFY_BASKET") {
    for (const s of BASKET_SKINS) {
      skins.push({
        id: s.id,
        name: s.name.toUpperCase(),
        rarity: rarityFromPack(s.rarity),
        tagline: GOOFY_BASKET_TAGLINES[s.id],
      });
    }
  } else {
    // Placeholders: the visual identity exists, the assets do not yet.
    skins.push(
      { id: "__soon_1", name: "BIENTÔT", rarity: "rare", tagline: "Skin en préparation", locked: true },
      { id: "__soon_2", name: "BIENTÔT", rarity: "epique", tagline: "Skin en préparation", locked: true },
    );
  }
  return { weapon, weaponName: item.name, skins };
});

export function sortByRarity(cards: SkinCard[]): SkinCard[] {
  return [...cards].sort((a, b) => RARITY_ORDER[a.rarity] - RARITY_ORDER[b.rarity]);
}

// ---------------------------------------------------------------------
// Character placeholders (hats / bags / tops / pants / shoes)
// ---------------------------------------------------------------------

export interface CharacterCategory {
  key: CharacterCosmeticSlot;
  label: string;
  /** Inline SVG path (24×24) of the tab icon. */
  icon: string;
  items: SkinCard[];
}

/** "Nothing equipped" card of every character slot (first in each grid). */
export const BASE_CHARACTER_CARD: SkinCard = {
  id: DEFAULT_CHARACTER_COSMETIC,
  name: "AUCUN",
  rarity: "standard",
  tagline: "L'apparence d'origine du haricot",
};

// ---- Potato Astronaut pack (LÉGENDAIRE) — real, equippable pieces ----
interface AstronautCatalogItem {
  id: string;
  slot: string;
  label: string;
  icon: string;
}
const ASTRONAUT_ICONS: Record<string, string> = {
  astronaut_shoes: astroBootsIcon,
  astronaut_pants: astroPantsIcon,
  astronaut_top: astroTopIcon,
  astronaut_backpack: astroBagIcon,
  astronaut_helmet: astroHelmetIcon,
};
const ASTRONAUT_TAGLINES: Record<string, string> = {
  astronaut_shoes: "Bottes magnétiques, semelles lunaires",
  astronaut_pants: "Pantalon pressurisé, genouillères renforcées",
  astronaut_top: "Haut de combinaison — manches visibles en vue FP",
  astronaut_backpack: "Module de survie dorsal",
  astronaut_helmet: "Casque fermé, visière intégrée et joint souple",
};

/** Astronaut cards of one slot (ids validated against the shared whitelist). */
function astronautCards(slot: CharacterCosmeticSlot): SkinCard[] {
  const items = (astronautCatalog as { items: AstronautCatalogItem[] }).items;
  return items
    .filter((item) => item.slot === slot && CHARACTER_COSMETIC_IDS[slot].includes(item.id))
    .map((item) => ({
      id: item.id,
      name: item.label.toUpperCase(),
      rarity: "legendaire" as Rarity,
      tagline: ASTRONAUT_TAGLINES[item.id],
      icon: ASTRONAUT_ICONS[item.id],
    }));
}

export const CHARACTER_CATEGORIES: CharacterCategory[] = [
  {
    key: "hats",
    label: "CHAPEAUX",
    icon: "M4 15c4 2 12 2 16 0v2c-4 2-12 2-16 0v-2zm3-1c0-3 1-6 5-6s5 3 5 6c-3 1-7 1-10 0z",
    items: [
      BASE_CHARACTER_CARD,
      ...astronautCards("hats"),
      { id: "__hat_1", name: "PANIER PERCHÉ", rarity: "rare", locked: true },
      { id: "__hat_2", name: "COIN-COIN", rarity: "rare", locked: true },
      { id: "__hat_3", name: "ŒUF AU PLAT", rarity: "peu_commun", locked: true },
      { id: "__hat_4", name: "POUSSE PUNK", rarity: "peu_commun", locked: true },
      { id: "__hat_5", name: "COSMIC CAP", rarity: "epique", locked: true },
      { id: "__hat_6", name: "COURONNE SOLAIRE", rarity: "legendaire", locked: true },
    ],
  },
  {
    key: "bags",
    label: "SACS",
    icon: "M8 7V6a4 4 0 0 1 8 0v1h2a1 1 0 0 1 1 1v11a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V8a1 1 0 0 1 1-1h2zm2 0h4V6a2 2 0 0 0-4 0v1z",
    items: [
      BASE_CHARACTER_CARD,
      ...astronautCards("bags"),
      { id: "__bag_1", name: "SAC PROVISIONS", rarity: "peu_commun", locked: true },
      { id: "__bag_2", name: "SAC DE SPORT", rarity: "rare", locked: true },
    ],
  },
  {
    key: "tops",
    label: "HAUTS",
    icon: "M8 4l4 2 4-2 4 3-2 3-2-1v11H8V9L6 10 4 7l4-3z",
    items: [
      BASE_CHARACTER_CARD,
      ...astronautCards("tops"),
      { id: "__top_1", name: "VESTE TEDDY", rarity: "rare", locked: true },
      { id: "__top_2", name: "MAILLOT B", rarity: "peu_commun", locked: true },
    ],
  },
  {
    key: "pants",
    label: "PANTALONS",
    icon: "M7 3h10l1 18h-4l-2-9-2 9H6L7 3z",
    items: [
      BASE_CHARACTER_CARD,
      ...astronautCards("pants"),
      { id: "__pants_1", name: "SHORT DE MATCH", rarity: "peu_commun", locked: true },
    ],
  },
  {
    key: "shoes",
    label: "CHAUSSURES",
    icon: "M3 15l6-2 3-4 2 3 6 2v3H3v-2z",
    items: [
      BASE_CHARACTER_CARD,
      ...astronautCards("shoes"),
      { id: "__shoes_1", name: "BASKETS CITRUS", rarity: "rare", locked: true },
    ],
  },
];

/** True when at least one real (unlocked, non-base) piece exists in `cat`. */
export function hasEquippableCharacterItems(cat: CharacterCategory): boolean {
  return cat.items.some((c) => !c.locked && c.id !== DEFAULT_CHARACTER_COSMETIC);
}

export const EMOTE_PLACEHOLDERS: SkinCard[] = [
  { id: "__emote_1", name: "DUNK", rarity: "rare", locked: true },
  { id: "__emote_2", name: "DRIBBLE FOU", rarity: "epique", locked: true },
  { id: "__emote_3", name: "SALUT DU HARICOT", rarity: "peu_commun", locked: true },
];
