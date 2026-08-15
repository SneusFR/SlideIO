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

/** Every PLAYABLE killstreak. Locked catalog items simply aren't here. */
const KILLSTREAK_DEFS: Partial<Record<KillstreakId, KillstreakDef>> = {
  MOLE_STRIKE: {
    id: "MOLE_STRIKE",
    name: "MOLE STRIKE",
    shortName: "MOLE",
    requiredKills: mole.moleStrikeRequiredKills,
  },
};

/** Def for an equipped id — null for "NONE" or not-yet-implemented ids. */
export function getKillstreakDef(id: KillstreakId): KillstreakDef | null {
  return KILLSTREAK_DEFS[id] ?? null;
}