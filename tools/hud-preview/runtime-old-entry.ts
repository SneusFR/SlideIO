/**
 * Harness host entry for the PRE-CHANGE HUD (runtime-harness.mjs `--old`):
 * copied into a checkout of the commit before the HUD left the game page and
 * built there, it drives the old widgets exactly as Game / main.ts / the
 * menu used to — built in Game's order on index.html's static markup, the
 * MOLE STRIKE overlay from MoleStrikeVFX, the phase overlay written in place,
 * #hud.menu-active / body.game-paused toggled directly, warmUpPaint after the
 * build, warmUpHud with Game's leaderboard hooks — from the same commands the
 * runtime receives. The baseline the new HUD (iframe and inline) must match
 * pixel for pixel. (The crosshair settings are applied at build time, as the
 * runtime does; the old menu applied them right after the warm-up.)
 */
import * as THREE from "three";
import { startHost } from "./runtime-host";
import { KillstreakState } from "../../src/killstreaks/KillstreakState";
import { MoleStrikeVFX } from "../../src/killstreaks/mole/MoleStrikeVFX";
import { MatchClockHUD } from "../../src/match/MatchClockHUD";
import { CombatHUD } from "../../src/ui/CombatHUD";
import { ComboHUD } from "../../src/ui/ComboHUD";
import { CrosshairHUD } from "../../src/ui/CrosshairHUD";
import { applyCrosshairSettings } from "../../src/ui/CrosshairSettings";
import { DamageNumbersHUD } from "../../src/ui/DamageNumbersHUD";
import { DashHUD } from "../../src/ui/DashHUD";
import { FrisbeeLauncherHUD } from "../../src/ui/FrisbeeLauncherHUD";
import { HitmarkerHUD } from "../../src/ui/HitmarkerHUD";
import { warmUpHud } from "../../src/ui/HudWarmup";
import { InteractHUD } from "../../src/ui/InteractHUD";
import { KillstreakHUD } from "../../src/ui/KillstreakHUD";
import { LeaderboardHUD } from "../../src/ui/LeaderboardHUD";
import { MedalHUD } from "../../src/ui/MedalHUD";
import { PaintballRifleHUD } from "../../src/ui/PaintballRifleHUD";
import { PopcornShotgunHUD } from "../../src/ui/PopcornShotgunHUD";
import { SpearHUD } from "../../src/ui/SpearHUD";
import { WaterFamasHUD } from "../../src/ui/WaterFamasHUD";
import { warmUpPaint } from "../../src/ui/paint/PaintLayer";

// The old widgets type their inputs as game classes: plain values here (duck-typed).
type Cmd = [string, ...any[]];

class Followed {
  readonly health = { alive: false };
  readonly eye = new THREE.Vector3();
  getEyePosition(out: THREE.Vector3): THREE.Vector3 {
    return out.copy(this.eye);
  }
}

function createOldRuntime(): any {
  let w: any = null;
  const ks = { slots: [0, 1, 2].map(() => ({ def: null, state: KillstreakState.LOCKED, kills: 0 })) as any[] };
  const followed = new Map<string, Followed>();
  const follower = (key: string): Followed => {
    let t = followed.get(key);
    if (!t) followed.set(key, (t = new Followed()));
    return t;
  };
  const camera = new THREE.Camera();
  const anchor = new THREE.Vector3();

  const run = (cmd: Cmd): void => {
    const [name, a, b, c, d, e, f] = cmd;
    switch (name) {
      case "doc.class": {
        const el = a === "root" ? document.documentElement : a === "body" ? document.body : document.getElementById("hud");
        el?.classList.toggle(b, c);
        return;
      }
      case "combat.update": return w.combat.update(a, b, c);
      case "combat.knockdown": return w.combat.setKnockdown(a, b);
      case "combat.damage": return w.combat.notifyDamage(a, b);
      case "combat.heal": return w.combat.notifyHeal(a);
      case "combat.kill": return w.combat.notifyKill();
      case "combat.name": return w.combat.setPlayerName(a);
      case "dash.update": return w.dash.update(a, b);
      case "spear.visible": return w.spear.setVisible(a);
      case "spear.update": return w.spear.update(a);
      case "plate.visible": return w[a].setVisible(b);
      case "plate.popcorn": return w.popcorn.update(a);
      case "plate.paintball": return w.paintball.update(a);
      case "plate.famas": return w.famas.update(a);
      case "plate.frisbee": return w.frisbee.update(a);
      case "combo.kill": return w.combo.notifyKill();
      case "combo.update": return w.combo.update(a);
      case "medal.show": return w.medal.show(a, b);
      case "medal.exit": return w.medal.beginExit();
      case "medal.hide": return w.medal.hide();
      case "killstreak.render":
        ks.slots = a;
        return w.killstreak.render();
      case "killstreak.ready": return w.killstreak.notifyReady(a);
      case "leaderboard.refresh": return w.leaderboard.refresh(a);
      case "clock.set": return w.clock.set(a);
      case "interact.prompt": return w.interact?.setPrompt(a);
      case "phase.opacity":
        w.phase.style.opacity = String(a);
        return;
      case "mole.opacity": return w.moleVfx.setOverlayOpacity(a);
      case "crosshair.fire": return w.crosshair.fire(a);
      case "crosshair.aim": return w.crosshair.setAiming(a);
      case "crosshair.flush": return w.crosshair.flush();
      case "crosshair.settings": return applyCrosshairSettings(a);
      case "hitmarker.show": return w.hitmarker.show(a, b ?? undefined, c);
      case "hitmarker.flush": return w.hitmarker.flush();
      case "damage.hit":
        anchor.set(d[0], d[1], d[2]);
        return w.damage.addHit(a, b, c, anchor, e === null ? null : follower(e), f);
      case "damage.orphan": return w.damage.addOrphanHit(a, b, c);
      case "damage.follow":
        for (const t of followed.values()) t.health.alive = false;
        for (const s of a) {
          const t = follower(s.key);
          t.health.alive = s.alive;
          t.eye.set(s.eye[0], s.eye[1], s.eye[2]);
        }
        return;
      case "damage.update":
        camera.matrixWorld.fromArray(b, 0);
        camera.matrixWorldInverse.fromArray(b, 16);
        camera.projectionMatrix.fromArray(b, 32);
        return w.damage.update(a, camera);
      default:
        throw new Error(`unknown HUD command: ${name}`);
    }
  };

  return {
    init(init: any): void {
      // Game's constructor order (MatchClockHUD: a field initializer, first).
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
      const killstreak = new KillstreakHUD(ks as any);
      const moleVfx = new MoleStrikeVFX({} as any, {} as any);
      w = { clock, dash, combat, interact, hitmarker, crosshair, damage, leaderboard, spear, popcorn, paintball, famas, frisbee, medal, combo, killstreak, moleVfx };
      w.phase = document.getElementById("phase-overlay");
      applyCrosshairSettings(init.crosshair);
      warmUpPaint(); // main.ts, right after Game.create
    },
    run,
    apply(cmds: Cmd[]): void {
      for (const cmd of cmds) run(cmd);
    },
    warmUp(gpuIdle: Promise<unknown> | null): Promise<void> {
      // main.ts: warmUpHud(game.hudWarmupHooks(), gpuBusy).
      const lb = w.leaderboard;
      const row = (id: number, name: string, kills: number, local: boolean) => ({
        combatantId: id,
        displayName: name,
        isLocalPlayer: local,
        kills,
        deaths: 0,
        assists: 0,
      });
      return warmUpHud(
        [
          {
            show: () => {
              lb.refresh([row(-2, "BOT", 0, false), row(-1, "PLAYER", 0, true)]);
              lb.refresh([row(-1, "PLAYER", 1, true), row(-2, "BOT", 0, false)]);
            },
            hide: () => lb.refresh([]),
          },
        ],
        gpuIdle,
      );
    },
    takePaintGpuMs: () => null,
  };
}

startHost(async () => createOldRuntime());
