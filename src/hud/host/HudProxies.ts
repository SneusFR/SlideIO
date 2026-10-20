/**
 * Game-side HUD facades — the `HudApi` the game calls instead of the widgets
 * (see ../protocol.ts).
 *
 * Every method reads its live arguments NOW, into a new plain object of the
 * matching view, and emits one command: the host applies it at once (inline
 * mode, exactly the old direct call) or queues it for this frame's batch
 * (frame mode, posted at the end of the game frame). Nothing live crosses:
 * the game's objects carry function-valued properties (`onDamaged`,
 * `onComboEnd`…) that a structured clone refuses, and prototype getters
 * (`Health.ratio`, `ComboManager.ratio`, weapon `ammo`) would be lost — and a
 * frame-mode command is cloned at the END of the frame, after the game has
 * moved on: a copy taken later would show the wrong state.
 *
 * Also here, since the widgets now run in another document: the labels of
 * the debug HUD's "Hitch" line (ui/frameEvents.ts — a ring of THIS page,
 * read by DebugHUD), noted at the call with the widgets' former rules.
 */
import { Vector3 } from "three";
import type * as THREE from "three";
import type { Combatant } from "../../combat/Combatant";
import type { HitZone } from "../../combat/HitZone";
import { HitFeedbackConfig as hfc } from "../../combat/HitFeedbackConfig";
import { noteFrameEvent } from "../../ui/frameEvents";
import type { CrosshairKick } from "../../ui/CrosshairHUD";
import type {
  AmmoView,
  CameraSnapshot,
  DamageKey,
  FollowSnapshot,
  FrisbeeView,
  HudApi,
  HudCommand,
  KillstreakSlotView,
  KillstreakView,
  PlateId,
  PopcornView,
} from "../protocol";

/** Where the facades send their commands (HudHost: apply now, or batch). */
export type HudEmit = (cmd: HudCommand) => void;

export interface HudProxyOptions {
  /**
   * Mirror of `#hud.menu-active` on THIS page's `<html>` (class
   * `hud-menu-active`): the debug panel (#debug), which stays in the game
   * page, was hidden by `#hud.menu-active` (contract with the HUD CSS).
   */
  mirrorMenuActive?: (on: boolean) => void;
}

/** Merge key of a damage number: `"#c<id>"` for a Combatant, a network sessionId as is. */
export function damageKey(key: Combatant | string): DamageKey {
  return typeof key === "string" ? key : `#c${key.id}`;
}

/**
 * Longest a damage number can live after its last hit (s): its lifetime
 * (a kill number lingers longer) + a margin for the rounding of the sum of
 * the frame deltas (the HUD ages its numbers by the same deltas).
 */
function damageWindow(): number {
  return Math.max(hfc.damageNumberLifetime, hfc.damageNumberKillLifetime) + 0.5;
}

/**
 * The 48 floats of a damage-number projection: matrixWorld,
 * matrixWorldInverse, projectionMatrix (column-major). A NEW array per call —
 * the two projections of a frame (the second one with the Brick Maul
 * whirlwind camera) must each keep their own camera until the batch is sent.
 */
export function cameraSnapshot(camera: THREE.Camera): CameraSnapshot {
  const out: number[] = new Array(48);
  const a = camera.matrixWorld.elements;
  const b = camera.matrixWorldInverse.elements;
  const c = camera.projectionMatrix.elements;
  for (let i = 0; i < 16; i++) {
    out[i] = a[i];
    out[16 + i] = b[i];
    out[32 + i] = c[i];
  }
  return out;
}

/** The facades. One set per host (module state stays in the closure). */
export function createHudProxies(emit: HudEmit, options: HudProxyOptions = {}): HudApi {
  const mirrorMenuActive = options.mirrorMenuActive ?? (() => {});

  // ---- CombatHUD: "mort" / "réapparition" once a previous state exists ----
  let lastAlive: boolean | null = null;

  const combat: HudApi["combat"] = {
    update(dt, health, deathTimer) {
      const alive = health.alive;
      if (lastAlive !== null && alive !== lastAlive) noteFrameEvent(alive ? "réapparition" : "mort");
      lastAlive = alive;
      emit(["combat.update", dt, { current: health.current, max: health.max, ratio: health.ratio, alive }, deathTimer]);
    },
    setKnockdown(down, canGetUp) {
      emit(["combat.knockdown", down, canGetUp]);
    },
    notifyDamage(amount, angle = null) {
      if (amount > 0) noteFrameEvent("dégâts");
      emit(["combat.damage", amount, angle]);
    },
    notifyHeal(amount) {
      noteFrameEvent("soin");
      emit(["combat.heal", amount]);
    },
    notifyKill() {
      noteFrameEvent("kill");
      emit(["combat.kill"]);
    },
    setPlayerName(name) {
      emit(["combat.name", name]);
    },
  };

  /**
   * One weapon plate. "recharge" was noted by the plate itself when its
   * state turned to "reload" from a non-reload state it had already shown
   * (hudKit.ts WeaponPlate.setState) — i.e. on an update made while the
   * plate is not hidden, whose `isReloading` is true when the previous such
   * update's was false (a hidden plate ignores its updates).
   */
  function plate<V extends { readonly isReloading: boolean }>(
    id: PlateId,
    command: (view: V) => HudCommand,
  ): { setVisible(visible: boolean): void; update(view: V): void } {
    let visible: boolean | null = null;
    let lastReloading: boolean | null = null;
    return {
      setVisible(v) {
        visible = v;
        emit(["plate.visible", id, v]);
      },
      update(view) {
        if (visible !== false) {
          if (lastReloading === false && view.isReloading) noteFrameEvent("recharge");
          lastReloading = view.isReloading;
        }
        emit(command(view));
      },
    };
  }

  const popcorn = plate<PopcornView>("popcorn", (w) => [
    "plate.popcorn",
    { ammo: w.ammo, isReloading: w.isReloading, shotSerial: w.shotSerial },
  ]);
  const paintball = plate<AmmoView>("paintball", (w) => ["plate.paintball", { ammo: w.ammo, isReloading: w.isReloading }]);
  const famas = plate<AmmoView>("famas", (w) => ["plate.famas", { ammo: w.ammo, isReloading: w.isReloading }]);
  const frisbee = plate<FrisbeeView>("frisbee", (w) => [
    "plate.frisbee",
    {
      deckLoaded: w.deckLoaded,
      cageCount: w.cageCount,
      discInHand: w.discInHand,
      isReloading: w.isReloading,
      shotSerial: w.shotSerial,
    },
  ]);

  // ---- KillstreakHUD: the manager's slots, copied at each render ----
  let killstreakView: KillstreakView | null = null;
  const slotsNow = (): KillstreakSlotView[] =>
    (killstreakView?.slots ?? []).map((s) => ({
      def: s.def ? { id: s.def.id, requiredKills: s.def.requiredKills } : null,
      state: s.state,
      kills: s.kills,
    }));

  // ---- DamageNumbersHUD: who the numbers may follow, and for how long ----
  /** Sum of the `update` deltas: the clock the HUD ages its numbers with. */
  let clock = 0;
  /** `clock` at the last hit of any key (-Infinity: no number yet). */
  let lastHitAt = -Infinity;
  /** Followed targets (solo bots) by follow key, with the clock of the last hit that keeps them alive. */
  const followed = new Map<DamageKey, { combatant: Combatant; lastHit: number }>();
  /** Merge key → follow key of the number created for it (a merged hit keeps that number following). */
  const followOf = new Map<DamageKey, DamageKey>();
  const eye = new Vector3();

  /** A hit on merge key `key` restarts its number's life — and its target's. */
  const touch = (key: DamageKey): void => {
    lastHitAt = clock;
    const f = followed.get(followOf.get(key) ?? key);
    if (f) f.lastHit = clock;
  };

  const damageNumbers: HudApi["damageNumbers"] = {
    addHit(key, damage, zone, anchor, target = null, isKill = false) {
      const k = damageKey(key);
      let follow: DamageKey | null = null;
      if (target) {
        follow = damageKey(target);
        followed.set(follow, { combatant: target, lastHit: clock });
        followOf.set(k, follow);
      }
      touch(k);
      emit(["damage.hit", k, damage, zone, [anchor.x, anchor.y, anchor.z], follow, isKill]);
    },
    addOrphanHit(key, damage, isKill = false) {
      const k = damageKey(key);
      touch(k);
      emit(["damage.orphan", k, damage, isKill]);
    },
    update(dt, camera) {
      clock += dt;
      const life = damageWindow();
      // No number can be alive any more: nothing to project (the usual case
      // between fights — no per-frame traffic for the damage numbers).
      if (clock - lastHitAt > life) {
        if (followed.size > 0) followed.clear();
        if (followOf.size > 0) followOf.clear();
        return;
      }
      const targets: FollowSnapshot[] = [];
      for (const [key, f] of followed) {
        if (clock - f.lastHit > life) {
          followed.delete(key);
          continue;
        }
        // The widget read the eye position only while the target lives (a
        // dead bot is parked far away): same rule, never a read on a corpse.
        if (f.combatant.health.alive) {
          f.combatant.getEyePosition(eye);
          targets.push({ key, alive: true, eye: [eye.x, eye.y, eye.z] });
        } else {
          targets.push({ key, alive: false, eye: [0, 0, 0] });
        }
      }
      // (A long fight hits many keys in turn: forget the expired ones.)
      if (followOf.size > followed.size) {
        for (const [key, follow] of followOf) if (!followed.has(follow)) followOf.delete(key);
      }
      emit(["damage.follow", targets]);
      emit(["damage.update", dt, cameraSnapshot(camera)]);
    },
  };

  // ---- Full-screen overlays: Game writes them every frame, sent on change ----
  let phaseOpacity = Number.NaN;
  let moleOpacity = Number.NaN;

  return {
    combat,
    dash: {
      update(dt, m) {
        emit(["dash.update", dt, { dashCooldownRemaining: m.dashCooldownRemaining, isDashing: m.isDashing }]);
      },
    },
    spear: {
      setVisible(visible) {
        emit(["spear.visible", visible]);
      },
      update(s) {
        emit(["spear.update", { rushCooldownRemaining: s.rushCooldownRemaining, isRushing: s.isRushing }]);
      },
    },
    popcorn,
    paintball,
    famas,
    frisbee,
    combo: {
      notifyKill() {
        emit(["combo.kill"]);
      },
      update(c) {
        emit(["combo.update", { active: c.active, comboCount: c.comboCount, ratio: c.ratio, timeRemaining: c.timeRemaining }]);
      },
    },
    medal: {
      show(medal, chainIndex) {
        emit(["medal.show", medal, chainIndex]);
      },
      beginExit() {
        emit(["medal.exit"]);
      },
      hide() {
        emit(["medal.hide"]);
      },
    },
    killstreak: {
      bind(view) {
        killstreakView = view;
        // The widget rendered its manager once when it was built.
        emit(["killstreak.render", slotsNow()]);
      },
      render() {
        emit(["killstreak.render", slotsNow()]);
      },
      notifyReady(slotIndex) {
        emit(["killstreak.ready", slotIndex]);
      },
    },
    leaderboard: {
      refresh(rows) {
        // The solo rows are the stats manager's live records (mutated by
        // the next kill): copied now.
        emit(["leaderboard.refresh", rows.map((row) => ({ ...row }))]);
      },
    },
    clock: {
      set(secondsLeft) {
        emit(["clock.set", secondsLeft]);
      },
    },
    interact: {
      setPrompt(label) {
        emit(["interact.prompt", label]);
      },
    },
    crosshair: {
      fire(kick: CrosshairKick = "medium") {
        noteFrameEvent("tir");
        emit(["crosshair.fire", kick]);
      },
      setAiming(on) {
        emit(["crosshair.aim", on]);
      },
      flush() {
        emit(["crosshair.flush"]);
      },
    },
    hitmarker: {
      show(zone: HitZone, durationSec?: number, kill = false) {
        emit(["hitmarker.show", zone, durationSec ?? null, kill]);
      },
      flush() {
        emit(["hitmarker.flush"]);
      },
    },
    damageNumbers,
    setPhaseOpacity(opacity) {
      if (opacity === phaseOpacity) return;
      phaseOpacity = opacity;
      emit(["phase.opacity", opacity]);
    },
    setMoleOpacity(opacity) {
      if (opacity === moleOpacity) return;
      moleOpacity = opacity;
      emit(["mole.opacity", opacity]);
    },
    setDocClass(target, className, on) {
      if (target === "hud" && className === "menu-active") mirrorMenuActive(on);
      emit(["doc.class", target, className, on]);
    },
    applyCrosshairSettings(settings) {
      emit(["crosshair.settings", { ...settings }]);
    },
  };
}
