import { FrisbeeLauncherConfig as F } from "../../../shared/combat/FrisbeeLauncherRules";
import { sweepFrisbeePlayer, type FrisbeeCast, type FrisbeeCastHit } from "../../../shared/combat/FrisbeeSim";
import { sweepSphereAabb } from "../../../shared/combat/BasketProjectileSim";
import type { ColliderBox } from "../../../shared/map/MapColliders";
import { HitTarget, pointAt } from "./HitDetection";

/**
 * FRISBEE LAUNCHER — server authority (ammo = deck + cage, cadence, cage swap,
 * automatic re-cock) + the disc collision query. Pure logic, no Colyseus / no
 * host: WeaponManager feeds it the clock, creates the disc (SharedFrisbeeSim)
 * and applies the touches through its normal dealDamage / sendImpulse path.
 *
 * The state machine mirrors the client controller (FrisbeeLauncherController):
 *   fire        : deck -> empty; discTaken 0.95 s (cage - 1), discSeated 1.29 s (deck loaded);
 *                 next shot from readyToFire 1.50 s.
 *   fireLast    : cage empty at the shot -> stays empty (no re-cock).
 *   reload      : (deck loaded) cageSwap 0.71 s (cage = 5), cageIn 1.10 s, ready 1.30 s.
 *   reloadEmpty : (deck empty) the same + re-cock (discTaken 1.85 s, discSeated 2.19 s), ready 2.40 s.
 * A cancel (weapon switch / death) before cageIn keeps the old cage; after it the
 * new cage stays and a disc already taken for the re-cock goes back into it. An
 * interrupted re-cock after a shot is COMPLETED (the disc ends on the deck).
 */
export type FrisbeeAction = "fire" | "fireLast" | "reload" | "reloadEmpty";

export class FrisbeeLauncherState {
  deck = true;
  cage: number = F.cageCapacity;
  /** A disc taken from the cage and not seated on the deck yet. */
  inHand = false;
  action: FrisbeeAction | null = null;
  /** Server ms of the running action start. */
  actionStartedAt = 0;
  private applied = new Set<string>();
  private cageBefore = 0;

  /** Discs anywhere on the weapon (deck + hand + cage). */
  get ammo(): number {
    return (this.deck ? 1 : 0) + (this.inHand ? 1 : 0) + this.cage;
  }

  reset(): void {
    this.deck = true;
    this.cage = F.cageCapacity;
    this.inHand = false;
    this.action = null;
    this.actionStartedAt = 0;
    this.applied.clear();
    this.cageBefore = 0;
  }

  private take(): void {
    if (this.cage > 0) {
      this.cage--;
      this.inHand = true;
    }
  }

  private seat(): void {
    this.inHand = false;
    this.deck = true;
  }

  private swapCage(): void {
    this.cageBefore = this.cage;
    this.cage = F.cageCapacity;
  }

  private once(key: string, elapsed: number, at: number, fn: () => void): void {
    if (elapsed >= at && !this.applied.has(key)) {
      this.applied.add(key);
      fn();
    }
  }

  /** Advance the running action to `now`: the authored events apply their ammo effect. */
  settle(now: number): void {
    if (!this.action) return;
    const elapsed = (now - this.actionStartedAt) / 1000;
    const T = F.timeline;
    if (this.action === "fire") {
      this.once("discTaken", elapsed, T.fire.discTaken, () => this.take());
      this.once("discSeated", elapsed, T.fire.discSeated, () => this.seat());
      if (elapsed >= T.fire.duration) this.endAction();
    } else if (this.action === "fireLast") {
      if (elapsed >= T.fireLast.duration) this.endAction();
    } else if (this.action === "reload") {
      this.once("cageSwap", elapsed, T.reload.cageSwap, () => this.swapCage());
      this.once("cageIn", elapsed, T.reload.cageIn, () => undefined);
      if (elapsed >= T.reload.duration) this.endAction();
    } else {
      this.once("cageSwap", elapsed, T.reloadEmpty.cageSwap, () => this.swapCage());
      this.once("cageIn", elapsed, T.reloadEmpty.cageIn, () => undefined);
      this.once("discTaken", elapsed, T.reloadEmpty.discTaken, () => this.take());
      this.once("discSeated", elapsed, T.reloadEmpty.discSeated, () => this.seat());
      if (elapsed >= T.reloadEmpty.duration) this.endAction();
    }
  }

  private endAction(): void {
    this.action = null;
    this.applied.clear();
  }

  /** A new action starts with a clean event log. */
  resetApplied(): void {
    this.applied.clear();
  }

  /** Finish the running action NOW without a cancel (every pending event applies). */
  complete(): void {
    const a = this.action;
    if (!a) return;
    if (a === "fire") {
      if (!this.applied.has("discTaken")) this.take();
      this.seat();
    } else if (a === "reload" || a === "reloadEmpty") {
      if (!this.applied.has("cageSwap")) this.cage = F.cageCapacity;
      if (a === "reloadEmpty") {
        if (!this.applied.has("discTaken")) this.take();
        this.seat();
      }
    }
    this.endAction();
  }

  /**
   * Interrupt the running action (weapon switch / death). Returns true when a
   * cage swap was cancelled (the caller confirms FRISBEE_RELOAD_CANCEL).
   */
  cancel(now: number): boolean {
    this.settle(now);
    const a = this.action;
    if (!a) return false;
    if (a === "fire") {
      this.complete(); // the re-cock ends at once: the disc is on the deck
      return false;
    }
    if (a === "fireLast") {
      this.endAction();
      return false;
    }
    if (!this.applied.has("cageIn")) {
      if (this.applied.has("cageSwap")) this.cage = this.cageBefore; // the old cage is given back
    } else if (a === "reloadEmpty" && this.applied.has("discTaken") && !this.applied.has("discSeated")) {
      this.cage = Math.min(F.cageCapacity, this.cage + 1); // the disc in the hand goes back into the cage
      this.inHand = false;
    }
    this.endAction();
    return true;
  }
}

export interface FrisbeeFireResult {
  accepted: boolean;
  /** Discs in the cage AT the shot (confirm `cg`: the remote picks fire vs fireLast). */
  cageAtShot: number;
  /** Discs left on the weapon AFTER the shot (confirm `am`). */
  ammoAfter: number;
}

const REFUSED: FrisbeeFireResult = { accepted: false, cageAtShot: 0, ammoAfter: 0 };

/** Validate one FRISBEE_FIRE: deck loaded, and past readyToFire of the running action. */
export function resolveFrisbeeFire(st: FrisbeeLauncherState, now: number): FrisbeeFireResult {
  st.settle(now);
  const tolMs = F.netToleranceSeconds * 1000;
  if (st.action) {
    const elapsed = now - st.actionStartedAt;
    const T = F.timeline;
    const ready =
      st.action === "fire"
        ? T.fire.readyToFire
        : st.action === "reload"
          ? T.reload.readyToFire
          : st.action === "reloadEmpty"
            ? T.reloadEmpty.readyToFire
            : Infinity;
    if (elapsed < ready * 1000 - tolMs) return REFUSED;
    st.complete(); // firing again cuts the end of the clip (local parity: finishReload / finishFire)
  }
  if (!st.deck) return REFUSED;
  st.deck = false;
  const cageAtShot = st.cage;
  st.action = cageAtShot > 0 ? "fire" : "fireLast";
  st.actionStartedAt = now;
  return { accepted: true, cageAtShot, ammoAfter: st.ammo };
}

export interface FrisbeeReloadResult {
  started: boolean;
  cageBefore: number;
  deckBefore: boolean;
}

/** FRISBEE_RELOAD: refused with a full cage AND a loaded deck, or while a swap / a re-cock runs. */
export function startFrisbeeReload(st: FrisbeeLauncherState, now: number): FrisbeeReloadResult {
  st.settle(now);
  const no: FrisbeeReloadResult = { started: false, cageBefore: st.cage, deckBefore: st.deck };
  if (st.cage >= F.cageCapacity && st.deck) return no;
  if (st.action === "reload" || st.action === "reloadEmpty" || st.action === "fire") return no;
  if (st.action === "fireLast") {
    const elapsed = now - st.actionStartedAt;
    if (elapsed < F.timeline.fireLast.readyToReload * 1000 - F.netToleranceSeconds * 1000) return no;
  }
  const res: FrisbeeReloadResult = { started: true, cageBefore: st.cage, deckBefore: st.deck };
  st.action = st.deck ? "reload" : "reloadEmpty";
  st.actionStartedAt = now;
  st.resetApplied();
  return res;
}

/** FRISBEE_RELOAD_CANCEL: returns true when a swap was running (before cageIn the ammo is unchanged). */
export function cancelFrisbeeReload(st: FrisbeeLauncherState, now: number): boolean {
  st.settle(now);
  if (st.action !== "reload" && st.action !== "reloadEmpty") return false;
  return st.cancel(now);
}

/**
 * Collision query of a disc (sphere of `radius`): nearest of the map boxes
 * (scenery -> bounce) and the rewound player volumes (touch, head flag). The
 * shooter (`ignore`) is never a target.
 */
export function createFrisbeeCast(targets: HitTarget[], boxes: ColliderBox[]): FrisbeeCast {
  return (from, dir, maxDist, radius, ignore) => {
    let best: FrisbeeCastHit | null = null;
    for (const b of boxes) {
      const h = sweepSphereAabb(from, dir, radius, b[0], b[1], b[2], b[3] / 2, b[4] / 2, b[5] / 2, maxDist);
      if (h && h.distance <= maxDist && (best === null || h.distance < best.distance)) {
        best = { distance: h.distance, point: pointAt(from, dir, h.distance), normal: h.normal };
      }
    }
    for (const t of targets) {
      if (ignore !== null && t.id === ignore) continue;
      const c = sweepFrisbeePlayer(from, dir, radius, { x: t.x, y: t.y, z: t.z }, maxDist);
      if (!c) continue;
      if (best !== null && c.t >= best.distance) continue;
      best = { distance: c.t, point: pointAt(from, dir, c.t), normal: c.normal, target: t.id, headshot: c.head };
    }
    return best;
  };
}