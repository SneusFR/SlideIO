import { HammerConfig as hc } from "../weapons/HammerConfig";
import { SpearConfig as sc } from "../weapons/SpearConfig";
import { WeaponConfig as wc } from "../weapons/WeaponConfig";
import { MoleStrikeConfig as mole } from "../killstreaks/mole/MoleStrikeConfig";
import { ObliterreurConfig as oc } from "../weapons/obliterreur/ObliterreurConfig";

/**
 * Player loadout: the single source of truth for what is equipped.
 * Persisted in localStorage so the choice survives reloads. The GAME reads
 * the selection once at spawn-time (Game.ts) — the menu only writes it.
 */

export type MeleeWeaponId = "HAMMER" | "SPEAR";
export type PrimaryWeaponId = "PLASMA_RIFLE" | "OBLITERREUR";
export type KillstreakId = "NONE" | "MOLE_STRIKE" | "ORBITAL_SCAN" | "NOVA_STRIKE";

/** Exactly three equippable killstreak slots (keys 1 / 2 / 3 in game). */
export type KillstreakLoadout = [KillstreakId, KillstreakId, KillstreakId];

export interface LoadoutSelection {
  melee: MeleeWeaponId;
  primary: PrimaryWeaponId;
  killstreaks: KillstreakLoadout;
}

const STORAGE_KEY = "slideio.loadout.v1";

const DEFAULT_KILLSTREAKS: KillstreakLoadout = ["MOLE_STRIKE", "NONE", "NONE"];

const DEFAULT_LOADOUT: LoadoutSelection = {
  melee: "HAMMER",
  primary: "PLASMA_RIFLE",
  killstreaks: [...DEFAULT_KILLSTREAKS],
};

/** Equippable killstreak ids (locked catalog entries are NOT equippable). */
const VALID_KILLSTREAK_IDS: KillstreakId[] = ["NONE", "MOLE_STRIKE"];

function sanitizeKillstreakId(raw: unknown): KillstreakId {
  return VALID_KILLSTREAK_IDS.includes(raw as KillstreakId) ? (raw as KillstreakId) : "NONE";
}

/**
 * Sanitize the persisted killstreak triple: unknown ids fall back to NONE
 * and a non-NONE id can never appear in two slots at once.
 */
function sanitizeKillstreaks(raw: unknown): KillstreakLoadout {
  const arr = Array.isArray(raw) ? raw : [];
  const out: KillstreakLoadout = ["NONE", "NONE", "NONE"];
  for (let i = 0; i < 3; i++) {
    const id = sanitizeKillstreakId(arr[i]);
    out[i] = id !== "NONE" && out.includes(id) ? "NONE" : id;
  }
  return out;
}

/** Read the persisted loadout (falls back to the default on any problem). */
export function loadLoadout(): LoadoutSelection {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { ...DEFAULT_LOADOUT, killstreaks: [...DEFAULT_KILLSTREAKS] };
    const parsed = JSON.parse(raw) as Partial<LoadoutSelection> & { killstreak?: string };
    // Migration: the old format stored a single `killstreak` id — no old id
    // is playable today, so migrating simply grants the default triple.
    const killstreaks =
      parsed.killstreaks !== undefined
        ? sanitizeKillstreaks(parsed.killstreaks)
        : [...DEFAULT_KILLSTREAKS] as KillstreakLoadout;
    return {
      melee: parsed.melee === "SPEAR" ? "SPEAR" : "HAMMER",
      primary: parsed.primary === "OBLITERREUR" ? "OBLITERREUR" : "PLASMA_RIFLE",
      killstreaks,
    };
  } catch {
    return { ...DEFAULT_LOADOUT, killstreaks: [...DEFAULT_KILLSTREAKS] };
  }
}

export function saveLoadout(loadout: LoadoutSelection): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(loadout));
  } catch {
    /* private mode etc. — the session selection still applies */
  }
}

// ---------------------------------------------------------------------
// Item catalog (display data for the Loadout menu — stats pulled straight
// from the REAL gameplay configs so the menu never lies to the player)
// ---------------------------------------------------------------------

export interface LoadoutAbility {
  /** e.g. "CLIC RAPIDE", "MAINTENIR", "AU SOL", "EN L'AIR" */
  trigger: string;
  name: string;
  description: string;
  stats: { label: string; value: string }[];
}

export interface LoadoutItem {
  id: string;
  name: string;
  tagline: string;
  summary: string;
  abilities: LoadoutAbility[];
  locked?: boolean;
}

const pct = (f: number) => `${Math.round(f * 100)}% PV MAX`;

export const MELEE_ITEMS: LoadoutItem[] = [
  {
    id: "HAMMER",
    name: "MARTEAU VOID",
    tagline: "Marteau à énergie lourde",
    summary:
      "Arme de mêlée polyvalente : balayages alternés au sol, et une charge verticale dévastatrice depuis les airs.",
    abilities: [
      {
        trigger: "AU SOL — TOUCHE A",
        name: "BALAYAGE",
        description:
          "Grand coup horizontal alterné (droite/gauche) qui frappe tous les ennemis dans l'arc devant vous et les repousse.",
        stats: [
          { label: "DÉGÂTS", value: pct(hc.hammerGroundDamageFraction) },
          { label: "PORTÉE", value: `${hc.hammerSwingRange} m` },
          { label: "ARC", value: `${hc.hammerSwingArcDegrees}°` },
          { label: "DURÉE", value: `${hc.hammerSwingDuration}s` },
        ],
      },
      {
        trigger: "EN L'AIR — TOUCHE A",
        name: "GROUND SLAM",
        description:
          "Charge verticale vers le sol : onde de choc de zone à l'impact, dégâts et projection sur tous les ennemis proches.",
        stats: [
          { label: "DÉGÂTS", value: pct(hc.groundSlamDamageFraction) },
          { label: "RAYON", value: `${hc.groundSlamRadius} m` },
          { label: "VITESSE", value: `${hc.groundSlamSpeed} m/s` },
        ],
      },
    ],
  },
  {
    id: "SPEAR",
    name: "LANCE ASTRALE",
    tagline: "Arme d'hast à ruée chargée",
    summary:
      "Longue portée et agressivité pure : un balayage ample pour le corps à corps, une ruée chargée à 2× la vitesse de course pour percer une cible à la pointe.",
    abilities: [
      {
        trigger: "CLIC RAPIDE — TOUCHE A",
        name: "BALAYAGE",
        description:
          "Grand balayage horizontal vers la gauche. La lance traverse réellement l'espace devant vous — portée supérieure à toute arme de mêlée.",
        stats: [
          { label: "DÉGÂTS", value: pct(sc.spearSweepDamageFraction) },
          { label: "PORTÉE", value: `${sc.spearSweepRange} m` },
          { label: "ARC", value: `${sc.spearSweepArcDegrees}°` },
          { label: "DURÉE", value: `${sc.spearSweepDuration}s` },
        ],
      },
      {
        trigger: "MAINTENIR — TOUCHE A",
        name: "RUÉE CHARGÉE",
        description:
          "La lance s'aligne pointe vers l'avant et vous foncez à 2× votre vitesse de course. Le premier combattant touché par la pointe subit 50% de ses PV max et un lourd knockback — fonctionne au sol comme en l'air.",
        stats: [
          { label: "DÉGÂTS", value: pct(sc.spearRushDamageFraction) },
          { label: "VITESSE", value: `×${sc.spearRushSpeedMultiplier} course` },
          { label: "DURÉE MAX", value: `${sc.spearRushMaxDuration}s` },
          { label: "COOLDOWN", value: `${sc.spearRushCooldown}s` },
        ],
      },
    ],
  },
];

export const PRIMARY_ITEMS: LoadoutItem[] = [
  {
    id: "PLASMA_RIFLE",
    name: "FUSIL VOIDPULSE",
    tagline: "Faisceau plasma continu",
    summary:
      "Rayon d'énergie continu à dégâts constants. Gérez la chaleur : une surchauffe verrouille l'arme pendant sa purge.",
    abilities: [
      {
        trigger: "CLIC GAUCHE — MAINTENIR",
        name: "FAISCEAU PLASMA",
        description:
          "Faisceau hitscan continu tant que le clic est maintenu. La chaleur monte en tirant et se dissipe au repos.",
        stats: [
          { label: "DÉGÂTS", value: `${wc.plasmaDamagePerSecond} PV/s` },
          { label: "PORTÉE", value: `${wc.beamRange} m` },
          {
            label: "SURCHAUFFE",
            value: `${Math.round((wc.maxHeat / wc.heatPerSecond) * 10) / 10}s de tir`,
          },
          { label: "PURGE MIN", value: `${wc.overheatMinLockTime}s` },
        ],
      },
    ],
  },
  {
    id: "OBLITERREUR",
    name: "OBLITERREUR",
    tagline: "Faille de vortex ancrée",
    summary:
      "Arme de zone tactique : ancrez deux mini trous noirs sur les surfaces de la carte, puis ouvrez entre eux un immense faisceau de vortex noir incurvé qui dévore tout combattant pris dans son volume — même à travers les murs.",
    abilities: [
      {
        trigger: "CLIC DROIT",
        name: "ANCRAGE",
        description:
          "Place un mini trou noir au centre du viseur, sur les surfaces statiques uniquement. Deux points maximum : le 3e clic redéfinit le point I puis II en boucle. Pendant un vortex actif, un clic droit l'annule instantanément avant de replacer.",
        stats: [
          { label: "POINTS", value: "2 (I / II)" },
          { label: "PORTÉE", value: `${oc.obliterreurPlacementRange} m` },
          { label: "SURFACES", value: "STATIQUES" },
          { label: "COOLDOWN", value: "AUCUN" },
        ],
      },
      {
        trigger: "CLIC GAUCHE",
        name: "VORTEX NOIR",
        description:
          "Ouvre le faisceau de vortex noir incurvé entre les deux ancres. Tout combattant dans le tube subit des dégâts continus — les murs ne le protègent pas. Les ancres survivent à l'extinction du vortex.",
        stats: [
          { label: "DÉGÂTS", value: `${pct(oc.obliterreurDamagePerSecondFraction)}/s` },
          { label: "DURÉE", value: `${oc.obliterreurBeamDuration}s` },
          { label: "RAYON", value: `${oc.obliterreurBeamRadius} m` },
          { label: "COOLDOWN", value: "AUCUN" },
        ],
      },
    ],
  },
];

export const KILLSTREAK_ITEMS: LoadoutItem[] = [
  {
    id: "NONE",
    name: "AUCUN",
    tagline: "Emplacement vide",
    summary: "Aucun killstreak équipé dans cet emplacement. Jouez pur, sans assistance.",
    abilities: [],
  },
  {
    id: "MOLE_STRIKE",
    name: "MOLE STRIKE",
    tagline: "Frappe souterraine dévastatrice",
    summary:
      "Plongez sous la surface et devenez intouchable : invulnérable, invisible pour les ennemis, seule une traînée de terre trahit votre position. Ressortez où vous voulez — l'éruption inflige des dégâts massifs de zone et projette tous les ennemis proches. Usage unique par vie.",
    abilities: [
      {
        trigger: `${mole.moleStrikeRequiredKills} KILLS SANS MOURIR — TOUCHE 1/2/3`,
        name: "PLONGÉE SOUTERRAINE",
        description:
          "Vous creusez sous la surface : invulnérable et non-ciblable, vous vous déplacez librement sous terre (les murs restent infranchissables). Durée maximale avant l'éruption automatique.",
        stats: [
          { label: "KILLS REQUIS", value: `${mole.moleStrikeRequiredKills}` },
          { label: "DURÉE MAX", value: `${mole.moleStrikeDuration}s` },
          { label: "VITESSE", value: `${mole.moleStrikeUndergroundSpeed} m/s` },
          { label: "USAGE", value: "1 / VIE" },
        ],
      },
      {
        trigger: "TOUCHE E — OU FIN DU CHRONO",
        name: "ÉRUPTION",
        description:
          "Vous jaillissez du sol dans une explosion de terre et de débris : dégâts de zone massifs et violente projection radiale sur tous les ennemis dans le rayon.",
        stats: [
          { label: "DÉGÂTS", value: pct(mole.moleStrikeDamageFraction) },
          { label: "RAYON", value: `${mole.moleStrikeRadius} m` },
          { label: "PROJECTION", value: `${mole.moleStrikeKnockback} m/s` },
        ],
      },
    ],
  },
  {
    id: "ORBITAL_SCAN",
    name: "SCAN ORBITAL",
    tagline: "Bientôt disponible",
    summary:
      "Révèle brièvement tous les ennemis à travers les murs. En cours de calibration — sera activé dans une prochaine mise à jour.",
    abilities: [],
    locked: true,
  },
  {
    id: "NOVA_STRIKE",
    name: "FRAPPE NOVA",
    tagline: "Bientôt disponible",
    summary:
      "Frappe d'énergie orbitale sur une zone ciblée. En cours de calibration — sera activée dans une prochaine mise à jour.",
    abilities: [],
    locked: true,
  },
];