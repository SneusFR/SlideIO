import type { PrimaryWeaponId } from "./Loadout";
import { DEFAULT_WEAPON_SKIN, sanitizeWeaponSkin } from "../../shared/combat/WeaponSkins";
import {
  sanitizeCharacterCosmetics,
  isCharacterCosmeticId,
  type CharacterCosmeticSlot,
  type CharacterCosmeticsSelection,
} from "../../shared/combat/CharacterCosmetics";

/**
 * Player COSMETICS: which skin is equipped on each weapon AND which outfit
 * piece is equipped on each character slot. Persisted in localStorage next
 * to the loadout, but deliberately a SEPARATE store — a cosmetic change
 * alone must never look like a weapon change to the game (no attack
 * cancel, no reset), see Game.applyLoadout.
 *
 * The CUSTOMIZE menu only WRITES this selection; the game reads it when
 * (re)entering the match and on every respawn (same rhythm as the loadout).
 */

export interface CosmeticsSelection {
  /** Equipped skin id per weapon ("default" = base materials). */
  weaponSkins: Partial<Record<PrimaryWeaponId, string>>;
  /** Equipped outfit piece per character slot (absent slot = base look). */
  characterCosmetics: CharacterCosmeticsSelection;
}

const STORAGE_KEY = "slideio.cosmetics.v1";

/** Id of the base appearance of a character slot (nothing equipped). */
export const DEFAULT_CHARACTER_COSMETIC = "default";

function emptySelection(): CosmeticsSelection {
  return { weaponSkins: {}, characterCosmetics: {} };
}

/**
 * Read the persisted cosmetics (every id re-validated against the shared
 * whitelists). Saves written before the character outfits existed simply
 * yield five empty slots; a draft `face` entry of the astronaut pack
 * (`astronaut_visor`, now part of the helmet) is dropped by the sanitizer,
 * which only keeps the five known slots and their whitelisted ids.
 */
export function loadCosmetics(): CosmeticsSelection {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return emptySelection();
    const parsed = JSON.parse(raw) as Partial<CosmeticsSelection>;
    const out = emptySelection();
    const skins = parsed.weaponSkins;
    if (skins && typeof skins === "object") {
      for (const [weapon, skin] of Object.entries(skins)) {
        const valid = sanitizeWeaponSkin(weapon, skin);
        if (valid !== DEFAULT_WEAPON_SKIN) out.weaponSkins[weapon as PrimaryWeaponId] = valid;
      }
    }
    out.characterCosmetics = sanitizeCharacterCosmetics(parsed.characterCosmetics);
    return out;
  } catch {
    return emptySelection();
  }
}

export function saveCosmetics(selection: CosmeticsSelection): void {
  try {
    // Re-validated on write too: only known slots / ids ever reach the store.
    const clean: CosmeticsSelection = {
      weaponSkins: selection.weaponSkins,
      characterCosmetics: sanitizeCharacterCosmetics(selection.characterCosmetics),
    };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(clean));
  } catch {
    /* private mode etc. — the session selection still applies */
  }
}

/** Persisted character outfit (validated; empty slots = base look). */
export function loadCharacterCosmetics(): CharacterCosmeticsSelection {
  return loadCosmetics().characterCosmetics;
}

/** Equipped piece of one character slot ("default" when the slot is bare). */
export function loadCharacterCosmetic(slot: CharacterCosmeticSlot): string {
  return loadCosmetics().characterCosmetics[slot] ?? DEFAULT_CHARACTER_COSMETIC;
}

/**
 * Equip a piece on one character slot and persist. "default" (or any id
 * unknown for that slot) clears the slot back to the base appearance.
 */
export function saveCharacterCosmetic(slot: CharacterCosmeticSlot, id: string): void {
  const selection = loadCosmetics();
  if (isCharacterCosmeticId(slot, id)) selection.characterCosmetics[slot] = id;
  else delete selection.characterCosmetics[slot];
  saveCosmetics(selection);
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
