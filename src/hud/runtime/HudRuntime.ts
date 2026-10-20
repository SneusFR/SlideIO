/**
 * HUD runtime — builds the in-match HUD and drives it from plain commands
 * (src/hud/protocol.ts). The SAME code runs in the HUD's own document
 * (hud.html in an iframe; frameEntry.ts feeds it the game's per-frame
 * batches) and, as the fallback, in the game page itself (inline mode: each
 * command applied at the call, exactly the old direct widget calls).
 *
 * Widgets, markup, CSS and their order are the ones Game used to build: DOM
 * append order is stacking order, and every widget keeps its own logic
 * (change detection, FramePulse restarts, pools). Commands only call the
 * widget methods the game used to call, with the same values.
 */
import * as THREE from "three";
import markup from "../hudMarkup.html?raw";
import { KillstreakState } from "../../killstreaks/KillstreakState";
import { MatchClockHUD } from "../../match/MatchClockHUD";
import { CombatHUD } from "../../ui/CombatHUD";
import { ComboHUD } from "../../ui/ComboHUD";
import { CrosshairHUD } from "../../ui/CrosshairHUD";
import { applyCrosshairSettings } from "../../ui/CrosshairSettings";
import { DamageNumbersHUD } from "../../ui/DamageNumbersHUD";
import { DashHUD } from "../../ui/DashHUD";
import { FrisbeeLauncherHUD } from "../../ui/FrisbeeLauncherHUD";
import { HitmarkerHUD } from "../../ui/HitmarkerHUD";
import { warmUpHud, type HudWarmupHook } from "../../ui/HudWarmup";
import { InteractHUD } from "../../ui/InteractHUD";
import { KillstreakHUD } from "../../ui/KillstreakHUD";
import { LeaderboardHUD } from "../../ui/LeaderboardHUD";
import { MedalHUD } from "../../ui/MedalHUD";
import { PaintballRifleHUD } from "../../ui/PaintballRifleHUD";
import { PopcornShotgunHUD } from "../../ui/PopcornShotgunHUD";
import { SpearHUD } from "../../ui/SpearHUD";
import { WaterFamasHUD } from "../../ui/WaterFamasHUD";
import { takePaintGpuMs, warmUpPaint } from "../../ui/paint/PaintLayer";
import type {
  CameraSnapshot,
  CreateHudRuntime,
  DamageKey,
  DocTarget,
  FollowSnapshot,
  FollowTarget,
  HudCommand,
  HudInit,
  HudRuntime,
  KillstreakSlotView,
  LeaderboardRow,
} from "../protocol";
import { MoleOverlay } from "./MoleOverlay";

export const createHudRuntime: CreateHudRuntime = () => new Runtime();

/** Every widget of the match HUD, built once by init(). */
interface Widgets {
  readonly clock: MatchClockHUD;
  readonly dash: DashHUD;
  readonly combat: CombatHUD;
  /** Yard only (the terminals' prompt). */
  readonly interact: InteractHUD | null;
  readonly hitmarker: HitmarkerHUD;
  readonly crosshair: CrosshairHUD;
  readonly damage: DamageNumbersHUD;
  readonly leaderboard: LeaderboardHUD;
  readonly spear: SpearHUD;
  readonly popcorn: PopcornShotgunHUD;
  readonly paintball: PaintballRifleHUD;
  readonly famas: WaterFamasHUD;
  readonly frisbee: FrisbeeLauncherHUD;
  readonly medal: MedalHUD;
  readonly combo: ComboHUD;
  readonly killstreak: KillstreakHUD;
  readonly mole: MoleOverlay;
  readonly phase: HTMLElement | null;
  readonly hud: HTMLElement | null;
}

/** A fresh KillstreakManager's slots: what KillstreakHUD's constructor renders. */
const NO_KILLSTREAKS: readonly KillstreakSlotView[] = [0, 1, 2].map(() =>
  Object.freeze({ def: null, state: KillstreakState.LOCKED, kills: 0 }),
);

/**
 * A combatant a damage number follows, as the game last described it
 * (`damage.follow`): the number reads it in DamageNumbersHUD.update, like it
 * read the live Combatant (alive flag, eye position) at the same point of the
 * game's frame.
 */
class FollowedTarget implements FollowTarget {
  readonly health = { alive: false };
  readonly eye = new THREE.Vector3();

  getEyePosition(out: THREE.Vector3): THREE.Vector3 {
    return out.copy(this.eye);
  }
}

class Runtime implements HudRuntime {
  private w: Widgets | null = null;
  /** KillstreakHUD's "manager": the slots of the last `killstreak.render`. */
  private readonly killstreakView: { slots: readonly KillstreakSlotView[] } = { slots: NO_KILLSTREAKS };
  /** One FollowTarget per followed key (cached: entries keep a reference). */
  private readonly followed = new Map<DamageKey, FollowedTarget>();
  /** Damage-number projection camera, rebuilt from each `damage.update` snapshot. */
  private readonly camera = new THREE.Camera();
  private readonly anchor = new THREE.Vector3();

  init(init: HudInit): void {
    if (this.w) return;
    injectMarkup();
    // Same order as Game's constructor (MatchClockHUD was a field
    // initializer: first): the widgets that append to the HUD's containers
    // or to <body> do so in that order, which is their stacking order.
    const clock = new MatchClockHUD();
    const dash = new DashHUD();
    const combat = new CombatHUD();
    const interact = init.interact ? new InteractHUD() : null;
    const hitmarker = new HitmarkerHUD();
    const crosshair = new CrosshairHUD();
    const damage = new DamageNumbersHUD();
    const leaderboard = new LeaderboardHUD();
    const spear = new SpearHUD();
    const popcorn = new PopcornShotgunHUD(init.popcornShots);
    const paintball = new PaintballRifleHUD(init.paintballCapacity);
    const famas = new WaterFamasHUD(init.famasCapacity);
    const frisbee = new FrisbeeLauncherHUD(init.frisbeeCageCapacity);
    const medal = new MedalHUD();
    const combo = new ComboHUD();
    const killstreak = new KillstreakHUD(this.killstreakView);
    // Built by MoleStrike (MoleStrikeVFX) right after the killstreak HUD.
    const mole = new MoleOverlay();
    this.w = {
      clock,
      dash,
      combat,
      interact,
      hitmarker,
      crosshair,
      damage,
      leaderboard,
      spear,
      popcorn,
      paintball,
      famas,
      frisbee,
      medal,
      combo,
      killstreak,
      mole,
      phase: document.getElementById("phase-overlay"),
      hud: document.getElementById("hud"),
    };
    applyCrosshairSettings(init.crosshair);
    // The plates' paint context + its raymarch program, compiled now (it
    // used to wait for the first plate shown: main.ts did this at boot).
    warmUpPaint();
  }

  apply(cmds: readonly HudCommand[]): void {
    // One failing command must not cost the rest of the frame's HUD: every
    // command runs, the first error is rethrown at the end.
    let failed = 0;
    let first: unknown = null;
    for (const cmd of cmds) {
      try {
        this.run(cmd);
      } catch (err) {
        if (failed++ === 0) first = err;
      }
    }
    if (failed === 1) throw first;
    if (failed > 1) throw new Error(`${failed} HUD commands failed, first: ${errorText(first)}`);
  }

  run(cmd: HudCommand): void {
    if (cmd[0] === "doc.class") {
      this.docClass(cmd[1], cmd[2], cmd[3]);
      return;
    }
    const w = this.w;
    if (!w) throw new Error(`HUD command before init: ${cmd[0]}`);
    switch (cmd[0]) {
      case "combat.update":
        w.combat.update(cmd[1], cmd[2], cmd[3]);
        return;
      case "combat.knockdown":
        w.combat.setKnockdown(cmd[1], cmd[2]);
        return;
      case "combat.damage":
        w.combat.notifyDamage(cmd[1], cmd[2]);
        return;
      case "combat.heal":
        w.combat.notifyHeal(cmd[1]);
        return;
      case "combat.kill":
        w.combat.notifyKill();
        return;
      case "combat.name":
        w.combat.setPlayerName(cmd[1]);
        return;
      case "dash.update":
        w.dash.update(cmd[1], cmd[2]);
        return;
      case "spear.visible":
        w.spear.setVisible(cmd[1]);
        return;
      case "spear.update":
        w.spear.update(cmd[1]);
        return;
      case "plate.visible":
        w[cmd[1]].setVisible(cmd[2]);
        return;
      case "plate.popcorn":
        w.popcorn.update(cmd[1]);
        return;
      case "plate.paintball":
        w.paintball.update(cmd[1]);
        return;
      case "plate.famas":
        w.famas.update(cmd[1]);
        return;
      case "plate.frisbee":
        w.frisbee.update(cmd[1]);
        return;
      case "combo.kill":
        w.combo.notifyKill();
        return;
      case "combo.update":
        w.combo.update(cmd[1]);
        return;
      case "medal.show":
        w.medal.show(cmd[1], cmd[2]);
        return;
      case "medal.exit":
        w.medal.beginExit();
        return;
      case "medal.hide":
        w.medal.hide();
        return;
      case "killstreak.render":
        this.killstreakView.slots = cmd[1];
        w.killstreak.render();
        return;
      case "killstreak.ready":
        // Sent before the render of the same kill (KillstreakManager calls
        // onReady before onChanged): it reads the slots of the last render,
        // whose defs are the ones the live manager had (only setEquipped
        // changes a def, and it renders).
        w.killstreak.notifyReady(cmd[1]);
        return;
      case "leaderboard.refresh":
        w.leaderboard.refresh(cmd[1]);
        return;
      case "clock.set":
        w.clock.set(cmd[1]);
        return;
      case "interact.prompt":
        w.interact?.setPrompt(cmd[1]);
        return;
      case "phase.opacity":
        // What Game wrote on #phase-overlay (handlePhaseEffects).
        if (w.phase) w.phase.style.opacity = String(cmd[1]);
        return;
      case "mole.opacity":
        w.mole.setOverlayOpacity(cmd[1]);
        return;
      case "crosshair.fire":
        w.crosshair.fire(cmd[1]);
        return;
      case "crosshair.aim":
        w.crosshair.setAiming(cmd[1]);
        return;
      case "crosshair.flush":
        w.crosshair.flush();
        return;
      case "crosshair.settings":
        applyCrosshairSettings(cmd[1]);
        return;
      case "hitmarker.show":
        w.hitmarker.show(cmd[1], cmd[2] ?? undefined, cmd[3]);
        return;
      case "hitmarker.flush":
        w.hitmarker.flush();
        return;
      case "damage.hit": {
        const a = cmd[4];
        this.anchor.set(a[0], a[1], a[2]);
        w.damage.addHit(cmd[1], cmd[2], cmd[3], this.anchor, cmd[5] === null ? null : this.follower(cmd[5]), cmd[6]);
        return;
      }
      case "damage.orphan":
        w.damage.addOrphanHit(cmd[1], cmd[2], cmd[3]);
        return;
      case "damage.follow":
        this.follow(cmd[1]);
        return;
      case "damage.update":
        this.loadCamera(cmd[2]);
        w.damage.update(cmd[1], this.camera);
        return;
      default: {
        const unknown: never = cmd;
        throw new Error(`unknown HUD command: ${String((unknown as readonly unknown[])[0])}`);
      }
    }
  }

  async warmUp(gpuIdle: Promise<unknown> | null): Promise<void> {
    const w = this.w;
    if (!w) throw new Error("HUD warm-up before init");
    // The HUD document downloads its fonts itself (an opaque-origin iframe
    // shares no cache with the page): drawn with the real faces only.
    await document.fonts?.ready;
    await warmUpHud(leaderboardWarmupHooks(w.leaderboard), gpuIdle);
  }

  takePaintGpuMs(): number | null {
    return takePaintGpuMs();
  }

  private docClass(target: DocTarget, className: string, on: boolean): void {
    const el =
      target === "root" ? document.documentElement : target === "body" ? document.body : (this.w?.hud ?? null);
    if (!el) throw new Error(`HUD doc.class: no ${target} element`);
    el.classList.toggle(className, on);
  }

  private follower(key: DamageKey): FollowedTarget {
    let t = this.followed.get(key);
    if (!t) {
      t = new FollowedTarget();
      this.followed.set(key, t);
    }
    return t;
  }

  /** The followed targets of this frame; a key absent from it reads "not alive". */
  private follow(targets: readonly FollowSnapshot[]): void {
    for (const t of this.followed.values()) t.health.alive = false;
    for (const s of targets) {
      const t = this.follower(s.key);
      t.health.alive = s.alive;
      t.eye.set(s.eye[0], s.eye[1], s.eye[2]);
    }
  }

  /** Everything Vector3.project / setFromMatrixPosition read, bit for bit. */
  private loadCamera(snapshot: CameraSnapshot): void {
    this.camera.matrixWorld.fromArray(snapshot, 0);
    this.camera.matrixWorldInverse.fromArray(snapshot, 16);
    this.camera.projectionMatrix.fromArray(snapshot, 32);
  }
}

/**
 * Puts the HUD markup where it was. The game page (inline mode): right
 * before the top-level debug panel — the place #hud had in index.html — and
 * the panel goes back to its old place inside #hud (after #aim-ticker), so
 * both stack exactly as before (e.g. under the death screen). The HUD
 * document (hud.html): an empty body.
 */
function injectMarkup(): void {
  const debug = document.getElementById("debug");
  if (debug && debug.parentElement === document.body) {
    debug.insertAdjacentHTML("beforebegin", markup);
    document.getElementById("aim-ticker")?.after(debug);
  } else {
    document.body.insertAdjacentHTML("afterbegin", markup);
  }
}

/**
 * The leaderboard's warm-up (was Game.hudWarmupHooks): ONE real update — two
 * rows, the local player takes the lead (row flight, score pop, "+1", crown
 * flight, landing dots) — so its code is compiled and its effects drawn
 * before the first kill, then emptied again: the first real snapshot
 * rebuilds it exactly as before.
 */
function leaderboardWarmupHooks(lb: LeaderboardHUD): HudWarmupHook[] {
  const row = (id: number, name: string, kills: number, local: boolean): LeaderboardRow => ({
    combatantId: id,
    displayName: name,
    isLocalPlayer: local,
    kills,
    deaths: 0,
    assists: 0,
  });
  return [
    {
      show: () => {
        lb.refresh([row(-2, "BOT", 0, false), row(-1, "PLAYER", 0, true)]);
        lb.refresh([row(-1, "PLAYER", 1, true), row(-2, "BOT", 0, false)]);
      },
      hide: () => lb.refresh([]),
    },
  ];
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
