/**
 * Scripted HUD "match" for the runtime harness (runtime-harness.mjs): the
 * commands the game would send (src/hud/protocol.ts), frame by frame at
 * 60 Hz, with the per-frame HUD block in Game's order and the events of a
 * short fight — paintball hits on a moving bot (damage numbers that follow
 * it), a headshot kill (medal, sticker, combo, leaderboard, killstreak),
 * damage taken (vignettes, direction, dash), the four plates (paint, 3D
 * frisbee, reload), a kill streak up to a READY capsule, heal + phase + mole
 * overlays + interact prompt, knockdown, death screen, respawn, crosshair
 * settings, pause. Pure data, deterministic (no Math.random), so every mode
 * (iframe, inline, pre-change widgets) replays exactly the same thing.
 * Built for Node by the harness (esbuild) — `buildScenario(width, height)`.
 */
import * as THREE from "three";
import { HitZone } from "../../src/combat/HitZone";
import { getKillstreakDef } from "../../src/killstreaks/KillstreakDefs";
import { KillstreakState } from "../../src/killstreaks/KillstreakState";
import { MedalType } from "../../src/medals/MedalType";
import { DEFAULT_CROSSHAIR } from "../../src/ui/CrosshairSettings";
import { PopcornShotgunConfig } from "../../shared/combat/PopcornShotgunRules";
import { PaintballRifleConfig } from "../../shared/combat/PaintballRifleRules";
import { WaterFamasConfig } from "../../shared/combat/WaterFamasRules";
import { FrisbeeLauncherConfig } from "../../shared/combat/FrisbeeLauncherRules";
import type { HudCommand, HudInit, KillstreakSlotView, LeaderboardRow, PlateId } from "../../src/hud/protocol";

export interface ScenarioFrame {
  /** The frame's batch (one game frame). */
  cmds: HudCommand[];
  /** Take a screenshot once this frame is applied and its time has passed. */
  checkpoint?: string;
}

export interface Scenario {
  init: Omit<HudInit, "viewport">;
  /** Commands of the boot (before the warm-up): none in the game, kept for symmetry. */
  frames: ScenarioFrame[];
  frameMs: number;
}

const DT = 1 / 60;
const LOCAL = 1;

export function buildScenario(width: number, height: number): Scenario {
  const frames: ScenarioFrame[] = [];
  const at = new Map<number, ((cmds: HudCommand[]) => void)[]>();
  const on = (f: number, fn: (cmds: HudCommand[]) => void): void => {
    const list = at.get(f) ?? [];
    list.push(fn);
    at.set(f, list);
  };
  const checkpoints = new Map<number, string>();

  // ---- World: camera + three bots (eye positions) ----
  const camera = new THREE.PerspectiveCamera(75, width / height, 0.1, 1000);
  const spun = new THREE.PerspectiveCamera(75, width / height, 0.1, 1000);
  const eye = (key: string, f: number): THREE.Vector3 => {
    const t = f * DT;
    if (key === "#c3") return new THREE.Vector3(-2.5 + 1.6 * t, 1.5, -7);
    if (key === "#c4") return new THREE.Vector3(3.2, 1.5, -11 + 0.5 * Math.sin(t));
    return new THREE.Vector3(-4 + 0.3 * t, 1.5, -14);
  };
  const snapshot = (cam: THREE.PerspectiveCamera): number[] => [
    ...cam.matrixWorld.elements,
    ...cam.matrixWorldInverse.elements,
    ...cam.projectionMatrix.elements,
  ];
  const aimCamera = (f: number): void => {
    const yaw = 0.12 * Math.sin(f * DT * 0.9);
    camera.position.set(0.4 * Math.sin(f * DT * 0.5), 1.6, 3);
    camera.lookAt(camera.position.x + Math.sin(yaw) * 10, 1.4, camera.position.z - Math.cos(yaw) * 10);
    camera.updateMatrixWorld(true);
    camera.matrixWorldInverse.copy(camera.matrixWorld).invert();
    // The Brick Maul whirlwind's spun render camera (Game's 2nd projection).
    spun.position.copy(camera.position);
    spun.quaternion.copy(camera.quaternion).premultiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), 0.35));
    spun.updateMatrixWorld(true);
    spun.matrixWorldInverse.copy(spun.matrixWorld).invert();
  };
  const alive = new Map<string, boolean>([
    ["#c3", true],
    ["#c4", true],
    ["#c5", true],
  ]);
  /** Last hit frame per followed key (the game's facade follows them for the numbers' lifetime). */
  const followed = new Map<string, number>();
  let lastHit = -1e9;
  const NUMBER_WINDOW = Math.ceil((1.35 + 0.5) / DT);

  // ---- Player / weapons / HUD state ----
  let hp = 100;
  let playerAlive = true;
  let deathTimer = 0;
  let dashCd = 0;
  let dashing = 0;
  let rushing = 0;
  let rushCd = 0;
  let down = false;
  let canGetUp = false;
  let combo = { active: false, count: 0, left: 0 };
  let primary: PlateId = "paintball";
  let paintball = PaintballRifleConfig.capacity;
  let paintballReload = 0;
  let popcorn = PopcornShotgunConfig.shots;
  let popcornSerial = 0;
  let popcornReload = 0;
  let famas = WaterFamasConfig.capacity;
  const frisbee = { deck: true, cage: FrisbeeLauncherConfig.cageCapacity, hand: false, reload: false, serial: 0, recock: 0 };
  let aiming = false;
  let clock = 300;
  let phase = 0;
  let mole = 0;
  let lastPhase = 0;
  let lastMole = 0;
  let prompt: string | null = null;

  // Killstreaks (as KillstreakManager: three equipped slots, per-life kills).
  const ids = ["MOLE_STRIKE", "ORBITAL_SCAN", "NOVA_STRIKE"] as const;
  const slots = ids.map((id) => ({ def: getKillstreakDef(id)!, state: KillstreakState.LOCKED, kills: 0 }));
  const slotViews = (): KillstreakSlotView[] =>
    slots.map((s) => ({ def: { id: s.def.id, requiredKills: s.def.requiredKills }, state: s.state, kills: s.kills }));

  // Leaderboard (FFA, 5 players).
  const stats: LeaderboardRow[] = [
    { combatantId: LOCAL, displayName: "Sneus", isLocalPlayer: true, kills: 3, deaths: 1, assists: 0 },
    { combatantId: 3, displayName: "Bot 1", isLocalPlayer: false, kills: 4, deaths: 2, assists: 1 },
    { combatantId: 4, displayName: "Bot 2", isLocalPlayer: false, kills: 5, deaths: 3, assists: 0 },
    { combatantId: 5, displayName: "Bot 3", isLocalPlayer: false, kills: 2, deaths: 4, assists: 2 },
    { combatantId: 6, displayName: "Bot 4", isLocalPlayer: false, kills: 1, deaths: 2, assists: 0 },
  ];
  const sorted = (): LeaderboardRow[] =>
    [...stats].sort((a, b) => b.kills - a.kills || a.deaths - b.deaths || a.combatantId - b.combatantId).map((r) => ({ ...r }));
  let leaderboardDirty = false;

  // Medals (MedalManager: show → exit after the display time → hide).
  let medalExitAt = -1;
  let medalHideAt = -1;
  let chain = 0;

  const statOf = (key: string): LeaderboardRow => stats.find((s) => `#c${s.combatantId}` === key)!;

  const hit = (cmds: HudCommand[], f: number, key: string, dmg: number, zone: HitZone, kill: boolean, dur: number | null): void => {
    const e = eye(key, f);
    cmds.push(["hitmarker.show", zone, kill ? null : dur, kill]);
    // HitFeedbackManager: the hit combatant is both the merge key and the followed target.
    cmds.push(["damage.hit", key, dmg, zone, [e.x, e.y + 0.45, e.z], key, kill]);
    followed.set(key, f);
    lastHit = f;
    if (!kill) return;
    alive.set(key, false);
    cmds.push(["combat.kill"]);
    cmds.push(["combo.kill"]);
    combo = { active: true, count: combo.count + 1, left: 5 };
    const medal =
      combo.count >= 3 ? MedalType.TRIPLE_KILL : combo.count === 2 ? MedalType.DOUBLE_KILL : zone === HitZone.HEAD ? MedalType.HEADSHOT : MedalType.KILL;
    cmds.push(["medal.show", medal, chain++]);
    medalExitAt = f + Math.round(0.95 / DT);
    medalHideAt = medalExitAt + Math.round(0.25 / DT);
    let changed = false;
    slots.forEach((s, i) => {
      if (s.state !== KillstreakState.LOCKED) return;
      s.kills++;
      changed = true;
      if (s.kills >= s.def.requiredKills) {
        s.state = KillstreakState.READY;
        cmds.push(["killstreak.ready", i]);
      }
    });
    if (changed) cmds.push(["killstreak.render", slotViews()]);
    statOf(`#c${LOCAL}`).kills++;
    statOf(key).deaths++;
    leaderboardDirty = true;
  };

  // ---- Script ----
  on(0, (c) => {
    c.push(["doc.class", "hud", "menu-active", false]);
    c.push(["combat.name", "Sneus"]);
    c.push(["killstreak.render", slotViews()]);
    c.push(["leaderboard.refresh", sorted()]);
  });
  // Paintball volley on the strafing bot, then the headshot kill.
  for (let f = 12; f <= 56; f += 6) {
    on(f, (c) => {
      paintball--;
      c.push(["crosshair.fire", "light"]);
      hit(c, f, "#c3", 18, HitZone.BODY, false, 0.09);
    });
  }
  on(30, (c) => {
    aiming = true;
    c.push(["damage.hit", "net-7Fq", 25, HitZone.BODY, [2.2, 1.95, -9], null, false]);
  });
  on(34, (c) => c.push(["damage.orphan", "net-7Fq", 12, false]));
  on(50, () => (aiming = false));
  on(62, (c) => {
    paintball--;
    c.push(["crosshair.fire", "light"]);
    hit(c, 62, "#c3", 40, HitZone.HEAD, true, null);
  });
  checkpoints.set(70, "kill-130ms");
  checkpoints.set(100, "kill-630ms");
  // Damage taken (directional bites), a dash, a spear rush.
  for (let f = 120; f <= 170; f += 10) {
    on(f, (c) => {
      hp -= 9;
      c.push(["combat.damage", 9, f < 150 ? 1.1 : -2.4]);
    });
  }
  on(128, () => {
    dashCd = 2;
    dashing = 12;
  });
  on(140, () => (rushing = 24));
  checkpoints.set(160, "fight");
  // Frisbee: two discs, the re-cock.
  on(175, () => (primary = "frisbee"));
  for (const f of [185, 200]) {
    on(f, (c) => {
      c.push(["crosshair.fire", "medium"]);
      Object.assign(frisbee, { deck: false, hand: true, cage: frisbee.cage - 1, serial: frisbee.serial + 1, recock: 10 });
    });
  }
  checkpoints.set(215, "frisbee");
  // Popcorn: a shot, then the reload.
  on(220, () => (primary = "popcorn"));
  on(230, (c) => {
    popcorn--;
    popcornSerial++;
    c.push(["crosshair.fire", "heavy"]);
    hit(c, 230, "#c4", 30, HitZone.BODY, false, null);
  });
  on(240, () => (popcornReload = 60));
  checkpoints.set(250, "popcorn-reload");
  // Paintball reload stamp (RECHARGE), then the FAMAS and a streak of kills.
  on(290, () => {
    primary = "paintball";
    paintballReload = 30;
  });
  checkpoints.set(300, "paintball-reload");
  on(305, () => (primary = "famas"));
  for (const [f, key] of [
    [330, "#c4"],
    [345, "#c5"],
    [360, "#c4"],
    [375, "#c5"],
  ] as const) {
    on(f - 6, (c) => {
      famas--;
      c.push(["crosshair.fire", "light"]);
      hit(c, f - 6, key, 22, HitZone.BODY, false, null);
    });
    on(f, (c) => {
      famas--;
      c.push(["crosshair.fire", "light"]);
      hit(c, f, key, 60, f === 360 ? HitZone.HEAD : HitZone.BODY, true, null);
    });
    on(f + 40, () => alive.set(key, true));
  }
  checkpoints.set(392, "streak");
  // Heal, phase dash glow, mole strike vignette, a terminal prompt.
  on(400, (c) => {
    hp = Math.min(100, hp + 35);
    c.push(["combat.heal", 35]);
    phase = 1;
    prompt = "TERMINAL 3 — OUVRIR";
  });
  on(410, () => (mole = 1));
  checkpoints.set(418, "heal-phase-mole");
  on(450, () => (mole = 0));
  on(460, () => (prompt = null));
  // Knockdown, then death and respawn.
  on(470, () => (down = true));
  on(485, () => (canGetUp = true));
  checkpoints.set(492, "knockdown");
  on(500, () => {
    down = false;
    canGetUp = false;
  });
  on(510, (c) => {
    hp = 0;
    playerAlive = false;
    deathTimer = 2.5;
    c.push(["combat.damage", 40, 0.4]);
    slots.forEach((s) => Object.assign(s, { state: KillstreakState.LOCKED, kills: 0 }));
    c.push(["killstreak.render", slotViews()]);
  });
  checkpoints.set(545, "death");
  on(560, () => {
    hp = 100;
    playerAlive = true;
  });
  on(570, (c) =>
    c.push(["crosshair.settings", { ...DEFAULT_CROSSHAIR, shape: "CROSS", scale: 1.4, color: "#35e0f2", highContrast: true }]),
  );
  on(574, (c) => c.push(["crosshair.fire", "medium"]));
  checkpoints.set(580, "crosshair-cross");
  on(590, (c) => c.push(["doc.class", "body", "game-paused", true]));
  checkpoints.set(593, "paused");
  on(600, (c) => c.push(["doc.class", "body", "game-paused", false]));
  on(605, () => (clock = 25));
  checkpoints.set(620, "hurry-clock");

  const LAST = 624;
  for (let f = 0; f <= LAST; f++) {
    const cmds: HudCommand[] = [];
    // Solo leaderboard: refreshed at the start of the frame after a stats change.
    if (leaderboardDirty) {
      leaderboardDirty = false;
      cmds.push(["leaderboard.refresh", sorted()]);
    }
    for (const fn of at.get(f) ?? []) fn(cmds);
    aimCamera(f);
    // ---- Game's running block: combo / medals tick, aim, numbers, flushes ----
    if (combo.active) {
      combo.left -= DT;
      if (combo.left <= 0) combo = { active: false, count: 0, left: 0 };
    }
    if (f === medalExitAt) cmds.push(["medal.exit"]);
    if (f === medalHideAt) cmds.push(["medal.hide"]);
    cmds.push(["crosshair.aim", aiming && playerAlive]);
    const numbersMayLive = f - lastHit <= NUMBER_WINDOW;
    if (numbersMayLive) {
      const targets = [...followed]
        .filter(([, last]) => f - last <= NUMBER_WINDOW)
        .map(([key]) => {
          const e = eye(key, f);
          return { key, alive: alive.get(key) ?? false, eye: [e.x, e.y, e.z] as [number, number, number] };
        });
      cmds.push(["damage.follow", targets]);
      cmds.push(["damage.update", DT, snapshot(camera)]);
    }
    cmds.push(["crosshair.flush"]);
    cmds.push(["hitmarker.flush"]);
    // ---- The HUD block (every rendered frame, paused included) ----
    if (dashCd > 0) dashCd = Math.max(0, dashCd - DT);
    if (dashing > 0) dashing--;
    cmds.push(["dash.update", DT, { dashCooldownRemaining: dashCd, isDashing: dashing > 0 }]);
    if (rushing > 0 && --rushing === 0) rushCd = 5;
    else if (rushCd > 0) rushCd = Math.max(0, rushCd - DT);
    cmds.push(["spear.visible", true]);
    cmds.push(["spear.update", { rushCooldownRemaining: rushCd, isRushing: rushing > 0 }]);
    if (popcornReload > 0 && --popcornReload === 0) popcorn = PopcornShotgunConfig.shots;
    if (paintballReload > 0 && --paintballReload === 0) paintball = PaintballRifleConfig.capacity;
    if (frisbee.recock > 0 && --frisbee.recock === 0) Object.assign(frisbee, { deck: true, hand: false });
    cmds.push(["plate.visible", "popcorn", primary === "popcorn"]);
    cmds.push(["plate.popcorn", { ammo: popcorn, isReloading: popcornReload > 0, shotSerial: popcornSerial }]);
    cmds.push(["plate.visible", "paintball", primary === "paintball"]);
    cmds.push(["plate.paintball", { ammo: paintball, isReloading: paintballReload > 0 }]);
    cmds.push(["plate.visible", "famas", primary === "famas"]);
    cmds.push(["plate.famas", { ammo: famas, isReloading: false }]);
    cmds.push(["plate.visible", "frisbee", primary === "frisbee"]);
    cmds.push([
      "plate.frisbee",
      { deckLoaded: frisbee.deck, cageCount: frisbee.cage, discInHand: frisbee.hand, isReloading: frisbee.reload, shotSerial: frisbee.serial },
    ]);
    if (!playerAlive) deathTimer = Math.max(0, deathTimer - DT);
    cmds.push(["combat.update", DT, { current: hp, max: 100, ratio: hp / 100, alive: playerAlive }, deathTimer]);
    cmds.push(["combat.knockdown", playerAlive && down, canGetUp]);
    cmds.push(["combo.update", { active: combo.active, comboCount: combo.count, ratio: combo.left / 5, timeRemaining: combo.left }]);
    clock = Math.max(0, clock - DT);
    cmds.push(["clock.set", clock]);
    // Phase glow (Game writes it when the rounded value changes), mole vignette, prompt.
    if (phase > 0) phase = Math.max(0, phase - 1 / 40);
    const p = Math.round(phase * 100) / 100;
    if (p !== lastPhase) cmds.push(["phase.opacity", (lastPhase = p)]);
    const m = Math.round((mole > 0 ? Math.min(1, lastMole + 0.1) : Math.max(0, lastMole - 0.1)) * 100) / 100;
    if (m !== lastMole) cmds.push(["mole.opacity", (lastMole = m)]);
    if (f >= 400 && f <= 461) cmds.push(["interact.prompt", prompt]);
    // The whirlwind's second projection (dt 0, spun camera), now and then.
    if (numbersMayLive && f >= 60 && f < 90) cmds.push(["damage.update", 0, snapshot(spun)]);
    frames.push({ cmds, checkpoint: checkpoints.get(f) });
  }

  return {
    init: {
      popcornShots: PopcornShotgunConfig.shots,
      paintballCapacity: PaintballRifleConfig.capacity,
      famasCapacity: WaterFamasConfig.capacity,
      frisbeeCageCapacity: FrisbeeLauncherConfig.cageCapacity,
      interact: true,
      crosshair: { ...DEFAULT_CROSSHAIR },
    },
    frames,
    frameMs: 1000 / 60,
  };
}
