import { KillstreakId } from "../loadout/Loadout";
import { MoleStrikeConfig as mole } from "./mole/MoleStrikeConfig";

/**
 * Static definition of an IMPLEMENTED killstreak (display data + charge
 * requirement). Gameplay values live in the ability's own *Config.ts —
 * this only describes the slot metadata shared by the manager and the HUD.
 */
export interface KillstreakDef {
  id: KillstreakId;
  /** Full display name (HUD rows / unlock banner). */
  name: string;
  /** Compact label for tight HUD rows. */
  shortName: string;
  /** Kills required (without dying) to arm the killstreak. */
  requiredKills: number;
}

/** Kills (without dying) required by the killstreaks that have no ability
 *  config of their own yet. MOLE STRIKE reads its value from MoleStrikeConfig. */
export const ORBITAL_SCAN_REQUIRED_KILLS = 10;
export const NOVA_STRIKE_REQUIRED_KILLS = 25;

/**
 * Slot metadata of every killstreak of the catalog. WHETHER one can be
 * equipped is decided by the loadout (Loadout.ts sanitizes locked catalog
 * entries — ORBITAL SCAN / NOVA STRIKE — out of the selection), so only the
 * playable ones ever reach the KillstreakManager in game.
 */
const KILLSTREAK_DEFS: Partial<Record<KillstreakId, KillstreakDef>> = {
  MOLE_STRIKE: {
    id: "MOLE_STRIKE",
    name: "MOLE STRIKE",
    shortName: "MOLE",
    requiredKills: mole.moleStrikeRequiredKills,
  },
  ORBITAL_SCAN: {
    id: "ORBITAL_SCAN",
    name: "SCAN ORBITAL",
    shortName: "SCAN",
    requiredKills: ORBITAL_SCAN_REQUIRED_KILLS,
  },
  NOVA_STRIKE: {
    id: "NOVA_STRIKE",
    name: "FRAPPE NOVA",
    shortName: "NOVA",
    requiredKills: NOVA_STRIKE_REQUIRED_KILLS,
  },
};

/** Def for an equipped id — null for "NONE" or not-yet-implemented ids. */
export function getKillstreakDef(id: KillstreakId): KillstreakDef | null {
  return KILLSTREAK_DEFS[id] ?? null;
}