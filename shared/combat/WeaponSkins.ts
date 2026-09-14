/**
 * SHARED cosmetic weapon skin contract — pure TypeScript DATA only.
 *
 * Imported by BOTH the frontend (Vite) and the backend (Node/Colyseus).
 * MUST NEVER import Three.js, DOM, Rapier or Colyseus code.
 *
 * A skin is a COSMETIC identifier, strictly distinct from the gameplay
 * weapon id (NetworkWeaponId): it never changes damage, speeds, bounces,
 * collisions or timings. The server only VALIDATES the id (whitelist per
 * weapon) and replicates it so the owner, the other players and late
 * joiners all see the same skin.
 */

import { NetworkWeaponId } from "./NetworkWeapons";

/** Skin id of the unskinned base weapon (original GLB materials). */
export const DEFAULT_WEAPON_SKIN = "default";

/** GoofyBasket cosmetic skins (integration pack — see src/weapons/goofybasket/skins). */
export const GOOFY_BASKET_SKIN_IDS = [
  "mandarine",
  "street_pop",
  "haute_tension",
  "eclipse_solaire",
] as const;
export type GoofyBasketSkinId = (typeof GOOFY_BASKET_SKIN_IDS)[number];

/** Every skin id accepted per weapon (the default is always accepted). */
const SKINS_BY_WEAPON: Partial<Record<NetworkWeaponId, readonly string[]>> = {
  [NetworkWeaponId.GOOFY_BASKET]: GOOFY_BASKET_SKIN_IDS,
};

/** True when `skin` is a valid cosmetic id for `weapon` (default included). */
export function isWeaponSkinId(weapon: string, skin: unknown): skin is string {
  if (typeof skin !== "string") return false;
  if (skin === DEFAULT_WEAPON_SKIN) return true;
  const list = SKINS_BY_WEAPON[weapon as NetworkWeaponId];
  return list !== undefined && list.includes(skin);
}

/** Validated skin for `weapon`: unknown / foreign ids fall back to the default. */
export function sanitizeWeaponSkin(weapon: string, skin: unknown): string {
  return isWeaponSkinId(weapon, skin) ? skin : DEFAULT_WEAPON_SKIN;
}

/** True when `skin` is one of the four GoofyBasket pack skins. */
export function isGoofyBasketSkinId(skin: unknown): skin is GoofyBasketSkinId {
  return typeof skin === "string" && (GOOFY_BASKET_SKIN_IDS as readonly string[]).includes(skin);
}
