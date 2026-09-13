import type { WeaponViewProfile } from "../profiles/WeaponProfile";
import { NetworkWeaponConfig } from "../../../shared/combat/NetworkWeapons";
// Vite-resolved asset URLs (bundler-safe in dev AND production builds —
// the profile JSON file names are relative to the assets folder).
import weaponUrl from "../../assets/goofybasket/GoofyBasket.glb?url";
import lod1Url from "../../assets/goofybasket/GoofyBasket_LOD1.glb?url";
import fpPosesUrl from "../../assets/goofybasket/Potato_FP_GoofyBasket.glb?url";
import tpPosesUrl from "../../assets/goofybasket/Potato_TP_GoofyBasket.glb?url";
import ballMotionUrl from "../../assets/goofybasket/GoofyBasket_BallMotion.json?url";
// Authored integration data (r4): mounts, ball sizes, clips, mask, charge,
// throws, projectile, catch, dribble.
import profileJson from "../../assets/goofybasket/WeaponProfile_GoofyBasket.json";

/**
 * Clip KINDS of the authored libraries (18 per view). Every FP action key
 * below maps 1:1 to a kind; the same keys drive the TP layer + the network
 * phase replication.
 */
export type GoofyClipKind = (typeof profileJson.clips.FP)[number]["kind"];

/** Phase keys played through the ViewmodelSystem / TP override APIs. */
export type GoofyActionKey = Exclude<GoofyClipKind, "Hold" | "Run" | "Equip" | "Unequip" | "Inspect">;

type ClipEntry = { kind: string; clip: string; duration: number; loop: boolean; samples: number };

function entry(view: "FP" | "TP", kind: GoofyClipKind): ClipEntry {
  const list: readonly ClipEntry[] = profileJson.clips[view];
  const e = list.find((c) => c.kind === kind);
  if (!e) throw new Error(`GoofyBasket profile: ${view} clip "${kind}" missing`);
  return e;
}

/** Full clip name (with prefix) for a view + kind. */
export function goofyClipName(view: "FP" | "TP", kind: GoofyClipKind): string {
  return entry(view, kind).clip;
}

/** Authored duration (s) of a kind — identical in both views. */
export function goofyClipDuration(kind: GoofyClipKind): number {
  return entry("FP", kind).duration;
}

/**
 * Resolve a profile suffix such as `throws[n].clip = "Throw_L1"` or
 * `charge.maxLoop = "Charge_Hold_L3"` to its kind (validated).
 */
export function goofyKindFromSuffix(suffix: string): GoofyClipKind {
  const list: readonly ClipEntry[] = profileJson.clips.FP;
  const e = list.find((c) => c.kind === suffix);
  if (!e) throw new Error(`GoofyBasket profile: unknown clip suffix "${suffix}"`);
  return e.kind as GoofyClipKind;
}

const ACTION_KINDS: readonly GoofyActionKey[] = [
  "Charge_L1",
  "Charge_L2",
  "Charge_L3",
  "Charge_Hold_L1",
  "Charge_Hold_L2",
  "Charge_Hold_L3",
  "Throw_L1",
  "Throw_L2",
  "Throw_L3",
  "Catch",
  "Dribble_Start",
  "Dribble",
  "Dribble_Catch",
];

/** Action table with the EXPLICIT authored `loop` flag (never inferred from the key). */
function actionTable(view: "FP" | "TP"): Record<GoofyActionKey, { clip: string; loop: boolean }> {
  const out = {} as Record<GoofyActionKey, { clip: string; loop: boolean }>;
  for (const kind of ACTION_KINDS) {
    const e = entry(view, kind);
    out[kind] = { clip: e.clip, loop: e.loop };
  }
  return out;
}

/** Ball size contract (authored profile `ball`). */
export const GOOFY_BALL = {
  sourceRadiusMeters: profileJson.ball.sourceRadiusMeters, // 0.125
  authoredRadius: profileJson.ball.authoredRadius, // 0.110
  /** Scale of the FREE ball under the FP camera / the normalized TP glTF scene. */
  freePresentationScale: profileJson.ball.freePresentationScale, // 0.88
  characterWorldScale: profileJson.ball.characterWorldScale, // 2.6931…
  /** Canonical WORLD collision radius (client, server, TP projectiles). */
  projectileWorldRadius: profileJson.ball.projectileWorldRadius, // 0.2962…
  /** Scale of a stand-alone projectile placed directly in the world scene. */
  projectileRootScale: profileJson.ball.projectileRootScale, // 2.3700…
} as const;

/** Authored gameplay timings (single source with the shared network config). */
export const GOOFY_TIMING = {
  equip: goofyClipDuration("Equip"), // 0.45
  unequip: goofyClipDuration("Unequip"), // 0.30
  inspect: goofyClipDuration("Inspect"), // 2.74
  dribbleStart: goofyClipDuration("Dribble_Start"), // 0.32
  dribbleLoop: goofyClipDuration("Dribble"), // 0.72
  dribbleCatch: goofyClipDuration("Dribble_Catch"), // 0.26
  catch: profileJson.catch.duration, // 0.58
  catchHandContactAt: profileJson.catch.handContactAt, // 0.34
  gather: profileJson.dribble.gatherDuration, // 0.18
  charge: [goofyClipDuration("Charge_L1"), goofyClipDuration("Charge_L2"), goofyClipDuration("Charge_L3")] as const,
  levelThresholds: profileJson.charge.levelThresholdsSeconds as readonly number[],
  throws: profileJson.throws.map((t) => ({
    level: t.level as 1 | 2 | 3,
    kind: goofyKindFromSuffix(t.clip),
    duration: goofyClipDuration(goofyKindFromSuffix(t.clip)),
    releaseAt: t.releaseAt,
    speed: t.speedMetersPerSecond,
  })),
} as const;

/**
 * Coherence contract between the authored profile and the SHARED
 * client/server config: the sizes and timings the gameplay relies on must
 * be the same numbers everywhere (a stale copy is a bug, not a tuning).
 */
function assertProfileCoherence(): void {
  const cfg = NetworkWeaponConfig.goofyBasket;
  const b = profileJson.ball;
  const near = (a: number, c: number, eps: number, what: string) => {
    if (Math.abs(a - c) > eps) throw new Error(`GoofyBasket profile/config mismatch: ${what} (${a} vs ${c})`);
  };
  near(b.authoredRadius / b.sourceRadiusMeters, b.freePresentationScale, 1e-9, "freePresentationScale");
  near(b.authoredRadius * b.characterWorldScale, b.projectileWorldRadius, 1e-9, "projectileWorldRadius");
  near(b.projectileWorldRadius / b.sourceRadiusMeters, b.projectileRootScale, 1e-9, "projectileRootScale");
  near(cfg.projectileRadius, b.projectileWorldRadius, 1e-9, "shared projectileRadius");
  for (let i = 0; i < 3; i++) {
    near(cfg.levelThresholdsSeconds[i], profileJson.charge.levelThresholdsSeconds[i], 1e-9, `threshold ${i}`);
    near(cfg.throws[i].releaseAt, profileJson.throws[i].releaseAt, 1e-9, `releaseAt L${i + 1}`);
    near(cfg.throws[i].speed, profileJson.throws[i].speedMetersPerSecond, 1e-9, `speed L${i + 1}`);
    near(cfg.throws[i].restitution, profileJson.throws[i].restitution, 1e-9, `restitution L${i + 1}`);
    near(cfg.throws[i].maxWorldBounces, profileJson.throws[i].maximumWorldBounces, 0, `bounces L${i + 1}`);
    near(cfg.throws[i].clipDuration, GOOFY_TIMING.throws[i].duration, 1e-9, `throw clip duration L${i + 1}`);
    near(cfg.damage, profileJson.throws[i].damage, 0, `damage L${i + 1}`);
  }
  near(cfg.maxLifetimeSeconds, profileJson.projectile.maximumLifetimeSeconds, 1e-9, "lifetime");
  near(cfg.catchDuration, profileJson.catch.duration, 1e-9, "catch duration");
  near(cfg.catchHandContactAt, profileJson.catch.handContactAt, 1e-9, "catch contact");
  near(cfg.gatherDuration, profileJson.dribble.gatherDuration, 1e-9, "gather");
  if (!profileJson.mounts.fp.includesBallScale || !profileJson.mounts.tp.includesBallScale) {
    throw new Error("GoofyBasket profile: mounts must include the ball scale");
  }
}
assertProfileCoherence();

/** URL of the ball-motion curve library (fetched once, see GoofyBasketModel). */
export const GOOFY_BALL_MOTION_URL: string = ballMotionUrl;
/** Optional distant-projectile LOD. */
export const GOOFY_LOD1_URL: string = lod1Url;

/**
 * GoofyBasket presentation profile — mount matrices (column-major, applied
 * ONCE, ball scale included), clip names with explicit loop flags and the
 * right-arm TP mask straight from WeaponProfile_GoofyBasket.json.
 */
export const GoofyBasketProfile: WeaponViewProfile = {
  id: profileJson.id, // "goofybasket"
  weaponUrl,
  fpPosesUrl,
  tpPosesUrl,
  fpMount: profileJson.mounts.fp.matrixColumnMajor,
  tpMount: profileJson.mounts.tp.matrixColumnMajor,
  fpClips: {
    hold: goofyClipName("FP", "Hold"),
    run: goofyClipName("FP", "Run"),
    equip: goofyClipName("FP", "Equip"),
    unequip: goofyClipName("FP", "Unequip"),
    inspect: goofyClipName("FP", "Inspect"),
    // No ADS: aim / raise / lower intentionally absent.
  },
  fpActions: actionTable("FP"),
  tpClips: {
    hold: goofyClipName("TP", "Hold"),
    run: goofyClipName("TP", "Run"),
    equip: goofyClipName("TP", "Equip"),
    unequip: goofyClipName("TP", "Unequip"),
    inspect: goofyClipName("TP", "Inspect"),
    actions: actionTable("TP"),
  },
  // The authored `rightArmMask` IS the TP hold layer of this one-hand grip.
  upperBodyMask: profileJson.rightArmMask,
  inspectDuration: profileJson.dribble.inspectionDuration,
};

