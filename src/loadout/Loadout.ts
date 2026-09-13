import { HammerConfig as hc } from "../weapons/HammerConfig";
import { SpearConfig as sc } from "../weapons/SpearConfig";
import { WeaponConfig as wc } from "../weapons/WeaponConfig";
import { MoleStrikeConfig as mole } from "../killstreaks/mole/MoleStrikeConfig";
import { ObliterreurConfig as oc } from "../weapons/obliterreur/ObliterreurConfig";
import { RevolverConfig as rc } from "../weapons/revolver/RevolverConfig";
import { BassBlasterConfig as bb } from "../weapons/bassblaster/BassBlasterConfig";
import { PoisonConfig as pz } from "../weapons/poison/PoisonConfig";
import { HexSniperConfig as hx } from "../weapons/hexsniper/HexSniperConfig";
import { NetworkWeaponConfig } from "../../shared/combat/NetworkWeapons";

/** GoofyBasket gameplay numbers come from the SHARED client/server config. */
const gb = NetworkWeaponConfig.goofyBasket;

/**
 * Player loadout: the single source of truth for what is equipped.
 * Persisted in localStorage so the choice survives reloads. The GAME reads
 * the selection once at spawn-time (Game.ts) — the menu only writes it.
 */

export type MeleeWeaponId = "HAMMER" | "SPEAR";
export type PrimaryWeaponId =
  | "PLASMA_RIFLE"
  | "OBLITERREUR"
  | "REVOLVER"
  | "BASS_BLASTER"
  | "POISON_SPRAYER"
  | "HEX_SNIPER"
  | "GOOFY_BASKET";
export type KillstreakId = "NONE" | "MOLE_STRIKE" | "ORBITAL_SCAN" | "NOVA_STRIKE";

/** Exactly three equippable killstreak slots (keys W / X / C in game). */
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
      primary:
        parsed.primary === "OBLITERREUR" ||
        parsed.primary === "REVOLVER" ||
        parsed.primary === "BASS_BLASTER" ||
        parsed.primary === "POISON_SPRAYER" ||
        parsed.primary === "HEX_SNIPER" ||
        parsed.primary === "GOOFY_BASKET"
          ? parsed.primary
          : "PLASMA_RIFLE",
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

/** 0–100 gauges displayed as chunky bars in the loadout menu. */
export interface LoadoutRatings {
  power: number;
  precision: number;
  difficulty: number;
}

export interface LoadoutItem {
  id: string;
  name: string;
  tagline: string;
  summary: string;
  ratings?: LoadoutRatings;
  abilities: LoadoutAbility[];
  locked?: boolean;
}

const pct = (f: number) => `${Math.round(f * 100)}% PV MAX`;

export const MELEE_ITEMS: LoadoutItem[] = [
  {
    id: "HAMMER",
    name: "BRICK MAUL",
    tagline: "Masse de briques à une main",
    summary:
      "Arme de mêlée polyvalente (touche 2 ou molette pour la sortir, clic gauche pour frapper) : tourbillon à 360° au sol, et une charge verticale dévastatrice depuis les airs.",
    ratings: { power: 85, precision: 55, difficulty: 35 },
    abilities: [
      {
        trigger: "AU SOL — CLIC GAUCHE",
        name: "TOURBILLON",
        description:
          "Trois tours complets sur vous-même : chaque ennemi à portée est frappé une seule fois pour toute l'attaque et violemment repoussé.",
        stats: [
          { label: "DÉGÂTS", value: `${hc.hammerGroundDamage} PV` },
          { label: "PORTÉE", value: `${hc.hammerSwingRange} m` },
          { label: "ZONE", value: `${hc.hammerSwingArcDegrees}°` },
          { label: "DURÉE", value: `${hc.hammerSwingDuration}s` },
        ],
      },
      {
        trigger: "EN L'AIR — CLIC GAUCHE",
        name: "GROUND SLAM",
        description:
          "Charge verticale immédiate vers le sol : onde de choc de zone à l'impact, dégâts et projection sur tous les ennemis proches.",
        stats: [
          { label: "DÉGÂTS", value: `${hc.groundSlamDamage} PV` },
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
    ratings: { power: 72, precision: 62, difficulty: 55 },
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
    ratings: { power: 58, precision: 82, difficulty: 30 },
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
    ratings: { power: 90, precision: 45, difficulty: 82 },
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
  {
    id: "REVOLVER",
    name: "REVOLVER",
    tagline: "Barillet parfait & lancer explosif",
    summary:
      "Précision absolue : chaque balle part exactement au centre du viseur, quel que soit votre mouvement. Corps = kill instantané, tête = 2 balles. Videz le barillet d'un coup au clic droit, puis l'arme vide est lancée comme une grenade — et un nouveau revolver se matérialise dans votre main.",
    ratings: { power: 95, precision: 100, difficulty: 68 },
    abilities: [
      {
        trigger: "CLIC GAUCHE",
        name: "TIR SIMPLE",
        description:
          "Une balle hitscan 100% précise vers le crosshair. Un tir au corps tue instantanément ; la tête demande deux balles (50% chacune) — un headshot reste compté comme HEADSHOT.",
        stats: [
          { label: "CORPS", value: `${rc.revolverBodyDamage} PV` },
          { label: "TÊTE", value: `${rc.revolverHeadDamage} PV` },
          { label: "CADENCE", value: `${rc.revolverPrimaryFireInterval}s` },
          { label: "BARILLET", value: `${rc.revolverCapacity}` },
        ],
      },
      {
        trigger: "CLIC DROIT",
        name: "FAN FIRE",
        description:
          "Vide automatiquement toutes les balles restantes en rafale ultra-rapide. Chaque balle raycast individuellement là où pointe le viseur à cet instant. Barillet vide → l'arme est lancée automatiquement.",
        stats: [
          { label: "CADENCE", value: `${rc.revolverFanFireInterval}s / balle` },
          { label: "DISPERSION", value: "AUCUNE" },
        ],
      },
      {
        trigger: "TOUCHE R",
        name: "LANCER EXPLOSIF",
        description:
          "Jette le revolver actuel (peu importe les munitions) : il vole vers l'avant, tourne sur lui-même et explose au premier obstacle. Un nouveau revolver se matérialise immédiatement dans votre main, barillet plein.",
        stats: [
          { label: "DÉGÂTS AOE", value: pct(rc.revolverExplosionDamageFraction) },
          { label: "RAYON", value: `${rc.revolverExplosionRadius} m` },
          { label: "VITESSE", value: `${rc.revolverThrowSpeed} m/s` },
          { label: "MATÉRIALISATION", value: `${rc.revolverMaterializeDuration}s` },
        ],
      },
    ],
  },
  {
    id: "BASS_BLASTER",
    name: "BASS BLASTER",
    tagline: "SMG musicale à notes chromatiques",
    summary:
      "Mitraillette expérimentale qui tire de véritables notes de musique colorées (Do→Do') et diffuse, tir après tir, des micro-fragments du morceau sélectionné — la musique voyage AVEC les notes. Flèches ↑/↓ en jeu pour choisir le morceau. (Solo/local uniquement pour l'instant.)",
    ratings: { power: 55, precision: 70, difficulty: 42 },
    abilities: [
      {
        trigger: "CLIC GAUCHE — MAINTENIR",
        name: "RAFALE DE NOTES",
        description:
          "Tir automatique rapide : chaque balle est une note lumineuse (couleur cyclique Do→Ré→Mi→Fa→Sol→La→Si→Do') qui joue un micro-fragment du morceau actif, spatialisé sur le projectile.",
        stats: [
          { label: "DÉGÂTS", value: `${bb.bodyDamage} PV (tête ${bb.headDamage})` },
          { label: "CADENCE", value: `${Math.round(1 / bb.fireInterval)} notes/s` },
          { label: "CHARGEUR", value: `${bb.magazineSize}` },
          { label: "VITESSE", value: `${bb.projectileSpeed} m/s` },
        ],
      },
      {
        trigger: "TOUCHE R",
        name: "RECHARGE HARMONIQUE",
        description:
          "Invoque un tourbillon de notes de musique qui convergent et entrent dans l'arme pour recharger le chargeur — pure énergie musicale.",
        stats: [
          { label: "DURÉE", value: `${bb.reloadDuration}s` },
          { label: "AUTO", value: "CHARGEUR VIDE" },
        ],
      },
      {
        trigger: "FLÈCHES ↑ / ↓",
        name: "SÉLECTION DU MORCEAU",
        description:
          "Fait défiler les morceaux disponibles dans le panneau sous le leaderboard. Reprendre le tir reprend le morceau là où il s'était arrêté ; re-sélectionner un morceau abandonné le fait repartir de zéro.",
        stats: [
          { label: "FRAGMENT", value: `${Math.round(bb.fragmentDuration * 1000)} ms / note` },
          { label: "AUDIO", value: "SPATIALISÉ" },
        ],
      },
    ],
  },
  {
    id: "POISON_SPRAYER",
    name: "LANCE-POISON",
    tagline: "Pulvérisateur toxique à courte portée",
    summary:
      "Un lance-flammes… au poison : maintenez le clic pour cracher un jet continu de poison vert lumineux qui fait fondre tout ce qui s'approche. Le réservoir voxel affiche votre charge en temps réel — le liquide bouge, penche et bouillonne avec vos déplacements.",
    ratings: { power: 78, precision: 40, difficulty: 48 },
    abilities: [
      {
        trigger: "CLIC GAUCHE — MAINTENIR",
        name: "JET DE POISON",
        description:
          "Émission continue d'un cône de poison à très courte portée. Dégâts massifs au contact — l'arme de duel rapproché par excellence. Le jet vide progressivement le réservoir.",
        stats: [
          { label: "DÉGÂTS", value: `${pz.damagePerSecond} PV/s` },
          { label: "PORTÉE", value: `${pz.range} m` },
          { label: "AUTONOMIE", value: `${Math.round(pz.capacity / pz.drainPerSecond)}s` },
          { label: "TÊTE", value: "PAS DE BONUS" },
        ],
      },
      {
        trigger: "TOUCHE R",
        name: "REMPLISSAGE",
        description:
          "Remplit le réservoir : le niveau de poison remonte visiblement dans la cuve pendant toute la recharge. Automatique quand le réservoir est vide.",
        stats: [
          { label: "DURÉE", value: `${pz.reloadDuration}s` },
          { label: "AUTO", value: "RÉSERVOIR VIDE" },
        ],
      },
    ],
  },
  {
    id: "HEX_SNIPER",
    name: "HEX SNIPER",
    tagline: "Sniper à tête de monstre",
    summary:
      "Un fusil de précision habité : une créature vivante est engagée dans le canon. Sa langue-grappin frappe quasi instantanément le premier obstacle touché — un joueur accroché prend les dégâts, est ramené vers vous à toute vitesse et la bête le CROQUE instantanément à l'arrivée. Une langue qui revient à vide ne mord pas : vous pouvez retirer aussitôt. (Attaques solo/local pour l'instant.)",
    ratings: { power: 82, precision: 80, difficulty: 58 },
    abilities: [
      {
        trigger: "CLIC GAUCHE",
        name: "LANGUE-GRAPPIN",
        description:
          "Tir de langue quasi instantané dans la direction visée — aucune portée maximale : premier obstacle ou limites de la carte. Un joueur touché prend les dégâts, est ramené physiquement vers vous (jamais à travers les murs) et subit une MORSURE instantanée à l'arrivée. Si la langue ne ramène rien, aucune morsure : le tir suivant part dès qu'elle est revenue.",
        stats: [
          { label: "DÉGÂTS", value: `${hx.tongueDamage} PV` },
          { label: "VITESSE", value: `${hx.projectileSpeed} m/s` },
          { label: "TRACTION", value: `${hx.pullSpeed} m/s` },
          { label: "MORSURE À L'ARRIVÉE", value: `${hx.biteDamage} PV` },
        ],
      },
      {
        trigger: "CLIC DROIT — MAINTENIR",
        name: "VISÉE ×4",
        description:
          "Visée de sniper classique : zoom optique ×4 avec le crosshair, sensibilité adaptée pour un ajustement précis. Relâchez pour revenir à la vue normale.",
        stats: [
          { label: "ZOOM", value: `×${hx.zoomFactor}` },
          { label: "PORTÉE", value: "ILLIMITÉE" },
        ],
      },
    ],
  },
  {
    id: "GOOFY_BASKET",
    name: "GOOFY BASKET",
    tagline: "Ballon de basket géant à charger",
    summary:
      "Un énorme ballon de basket tenu à une main. Dribblez en courant, chargez le lancer en maintenant le tir, relâchez pour une poussée directe vers l'avant : plus la charge est longue, plus le ballon part vite et rebondit sur le décor. Un joueur touché prend des dégâts fixes et le ballon est consommé ; une nouvelle balle vous tombe dans la main juste après. (Réglages initiaux, non équilibrés.)",
    ratings: { power: 55, precision: 45, difficulty: 50 },
    abilities: [
      {
        trigger: "CLIC GAUCHE — TAP / MAINTENIR / RELÂCHER",
        name: "LANCER CHARGÉ",
        description:
          "Un tap lance immédiatement au niveau 1. Maintenir prépare le niveau 2 puis 3 ; relâcher verrouille le niveau et engage le lancer dans la direction visée (aucun angle de cloche ajouté). Le ballon rebondit sur murs et sols selon son niveau, puis s'arrête ; le premier joueur touché est le seul.",
        stats: [
          { label: "DÉGÂTS", value: `${gb.damage} PV` },
          { label: "NIVEAU 2 / 3", value: `${gb.levelThresholdsSeconds[1]} s / ${gb.levelThresholdsSeconds[2]} s` },
          { label: "VITESSE", value: gb.throws.map((t) => t.speed).join(" / ") + " m/s" },
          { label: "REBONDS DÉCOR", value: gb.throws.map((t) => t.maxWorldBounces).join(" / ") },
        ],
      },
      {
        trigger: "COURIR — TOUCHE F",
        name: "DRIBBLE & INSPECTION",
        description:
          "En déplacement au sol, le ballon dribble à côté de vous ; sauter, glisser ou dasher le ramène en main. F joue une inspection avec trois dribbles (visuel uniquement).",
        stats: [
          { label: "DURÉE DE VIE", value: `${gb.maxLifetimeSeconds} s` },
          { label: "DIAMÈTRE", value: `${Math.round(gb.projectileRadius * 200)} cm` },
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
    ratings: { power: 88, precision: 50, difficulty: 45 },
    abilities: [
      {
        trigger: `${mole.moleStrikeRequiredKills} KILLS SANS MOURIR — TOUCHE W/X/C`,
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