import type { PrimaryWeaponId } from "./Loadout";
import { DEFAULT_WEAPON_SKIN, sanitizeWeaponSkin } from "../../shared/combat/WeaponSkins";

/**
 * Player COSMETICS: which skin is equipped on each weapon. Persisted in
 * localStorage next to the loadout, but deliberately a SEPARATE store —
 * a skin change alone must never look like a weapon change to the game
 * (no attack cancel, no reset), see Game.applyLoadout.
 *
 * The CUSTOMIZE menu only WRITES this selection; the game reads it when
 * (re)entering the match and on every respawn (same rhythm as the loadout).
 */

export interface CosmeticsSelection {
  /** Equipped skin id per weapon ("default" = base materials). */
  weaponSkins: Partial<Record<PrimaryWeaponId, string>>;
}

const STORAGE_KEY = "slideio.cosmetics.v1";

/** Read the persisted cosmetics (every id re-validated against the shared whitelist). */
export function loadCosmetics(): CosmeticsSelection {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { weaponSkins: {} };
    const parsed = JSON.parse(raw) as Partial<CosmeticsSelection>;
    const out: CosmeticsSelection = { weaponSkins: {} };
    const skins = parsed.weaponSkins;
    if (skins && typeof skins === "object") {
      for (const [weapon, skin] of Object.entries(skins)) {
        const valid = sanitizeWeaponSkin(weapon, skin);
        if (valid !== DEFAULT_WEAPON_SKIN) out.weaponSkins[weapon as PrimaryWeaponId] = valid;
      }
    }
    return out;
  } catch {
    return { weaponSkins: {} };
  }
}

export function saveCosmetics(selection: CosmeticsSelection): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(selection));
  } catch {
    /* private mode etc. — the session selection still applies */
  }
}

/** Equipped skin of one weapon (validated, "default" when none). */
export function loadWeaponSkin(weapon: PrimaryWeaponId): string {
  return loadCosmetics().weaponSkins[weapon] ?? DEFAULT_WEAPON_SKIN;
}

/** Equip a skin on one weapon and persist ("default" clears the entry). */
export function saveWeaponSkin(weapon: PrimaryWeaponId, skin: string): void {
  const selection = loadCosmetics();
  const valid = sanitizeWeaponSkin(weapon, skin);
  if (valid === DEFAULT_WEAPON_SKIN) delete selection.weaponSkins[weapon];
  else selection.weaponSkins[weapon] = valid;
  saveCosmetics(selection);
}
