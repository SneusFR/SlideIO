/**
 * Scripted match for the HUD frame bench (hud-frame-bench.mjs): the
 * commands the game sends to the HUD (src/hud/protocol.ts), one batch per
 * game frame, cut in PHASES — the HUD at rest, then one kind of event per
 * phase (continuous fire with hits, a headshot kill, damage taken, a
 * reload…), each followed by the frames it takes to settle. Every frame
 * carries the game's per-frame HUD block (Game's order: crosshair / numbers
 * flushes, dash, spear, the four plates, combat, knockdown, combo, clock) with
 * the values the game would send — what the HUD receives at rest is exactly
 * what it receives in a real match where nothing happens.
 * Pure data, deterministic: every tree under test replays the same frames.
 * Built for Node by the bench (esbuild) — `buildBench(width, height, options)`.
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

export interface BenchPhase {
  name: string;
  /** Batches played BEFORE the measured window (waiting for a state to settle). */
  lead: HudCommand[][];
  /** The measured batches, one per game frame. */
  frames: HudCommand[][];
}

export interface Bench {
  init: Omit<HudInit, "viewport">;
  /** Batches before the measured phases (match start: HUD shown, rows, name…). */
  start: HudCommand[][];
  phases: BenchPhase[];
  frameMs: number;
}

export interface BenchOptions {
  /**
   * `events` (default): rest, then one kind of event per phase. `states`: the
   * HUD's lasting states one after the other (moods, death, knockdown, dash
   * refill, clock hurry, ability chip, every plate at rest / low / reloading,
   * the combo rope…), each held for a while.
   */
  set?: "events" | "states";
  /** Equipped primary (its plate is the visible one) — `events` set. */
  primary?: PlateId;
  /** Melee = spear (its ability chip shows). */
  spear?: boolean;
  /** Frames of each phase (the rest phases last `rest`). */
  rest?: number;
  /** The phases, in order (default: every one). */
  phases?: string[];
}

const DT = 1 / 60;
const LOCAL = 1;
const ALL_PHASES = ["rest", "fire", "kill", "afterKill", "hurt", "reload", "late"];
const ALL_STATES = [
  "idle", "dashRefill", "worried", "panic", "dead", "idleAgain", "knockdown", "getUp", "spearReady", "hurry", "comboRope",
  "paintballRest", "paintballLow", "paintballReload", "popcornRest", "famasRest", "famasLow", "famasReload", "frisbeeRest",
];

export function buildBench(width: number, height: number, opt: BenchOptions = {}): Bench {
  const states = opt.set === "states";
  /** The visible plate (null: a primary without a plate — the default loadout's Goofy Basket). */
  let primary: PlateId | null = states ? null : (opt.primary ?? "paintball");
  let spearOn = opt.spear ?? false;
  const REST = opt.rest ?? 240;

  // ---- World: camera + two bots (eye positions) ----
  const camera = new THREE.PerspectiveCamera(75, width / height, 0.1, 1000);
  camera.position.set(0, 1.6, 3);
  camera.lookAt(0, 1.4, -7);
  camera.updateMatrixWorld(true);
  camera.matrixWorldInverse.copy(camera.matrixWorld).invert();
  const snapshot = [...camera.matrixWorld.elements, ...camera.matrixWorldInverse.elements, ...camera.projectionMatrix.elements];
  let frameNo = 0;
  const eye = (key: string): THREE.Vector3 => {
    const t = frameNo * DT;
    if (key === "#c3") return new THREE.Vector3(-2.5 + 0.8 * Math.sin(t), 1.5, -7);
    return new THREE.Vector3(3.2, 1.5, -11 + 0.5 * Math.sin(t));
  };
  const alive = new Map<string, boolean>([
    ["#c3", true],
    ["#c4", true],
  ]);
  const followed = new Map<string, number>();
  let lastHit = -1e9;
  const NUMBER_WINDOW = Math.ceil((1.35 + 0.5) / DT);

  // ---- Player / weapons / HUD state ----
  let hp = 100;
  let combo = { active: false, count: 0, left: 0 };
  let paintball = PaintballRifleConfig.capacity;
  let paintballReload = 0;
  let popcorn = PopcornShotgunConfig.shots;
  let popcornSerial = 0;
  let popcornReload = 0;
  let famas = WaterFamasConfig.capacity;
  let famasReload = 0;
  const frisbee = { deck: true, cage: FrisbeeLauncherConfig.cageCapacity, hand: false, reload: false, serial: 0, recock: 0 };
  let clock = 287.4;

  // Killstreaks: the default loadout (Mole Strike only, 3 kills).
  const slots = [getKillstreakDef("MOLE_STRIKE")!, null, null].map((def) => ({ def, state: KillstreakState.LOCKED, kills: 0 }));
  const slotViews = (): KillstreakSlotView[] =>
    slots.map((s) => ({ def: s.def ? { id: s.def.id, requiredKills: s.def.requiredKills } : null, state: s.state, kills: s.kills }));
  const stats: LeaderboardRow[] = [
    { combatantId: LOCAL, displayName: "Sneus", isLocalPlayer: true, kills: 2, deaths: 1, assists: 0 },
    { combatantId: 3, displayName: "Bot 1", isLocalPlayer: false, kills: 3, deaths: 2, assists: 0 },
    { combatantId: 4, displayName: "Bot 2", isLocalPlayer: false, kills: 1, deaths: 2, assists: 0 },
  ];
  const sorted = (): LeaderboardRow[] =>
    [...stats].sort((a, b) => b.kills - a.kills || a.deaths - b.deaths || a.combatantId - b.combatantId).map((r) => ({ ...r }));
  let leaderboardDirty = false;
  let medalExitAt = -1;
  let medalHideAt = -1;
  let chain = 0;
  let dashCd = 0;
  let dashing = 0;
  let playerAlive = true;
  let deathTimer = 0;
  let down = false;
  let canGetUp = false;

  const hit = (cmds: HudCommand[], key: string, dmg: number, zone: HitZone, kill: boolean, dur: number | null): void => {
    const e = eye(key);
    cmds.push(["hitmarker.show", zone, kill ? null : dur, kill]);
    cmds.push(["damage.hit", key, dmg, zone, [e.x, e.y + 0.45, e.z], key, kill]);
    followed.set(key, frameNo);
    lastHit = frameNo;
    if (!kill) return;
    alive.set(key, false);
    cmds.push(["combat.kill"]);
    cmds.push(["combo.kill"]);
    combo = { active: true, count: combo.count + 1, left: 5 };
    cmds.push(["medal.show", zone === HitZone.HEAD ? MedalType.HEADSHOT : MedalType.KILL, chain++]);
    medalExitAt = frameNo + Math.round(0.95 / DT);
    medalHideAt = medalExitAt + Math.round(0.25 / DT);
    let changed = false;
    slots.forEach((s, i) => {
      if (!s.def || s.state !== KillstreakState.LOCKED) return;
      s.kills++;
      changed = true;
      if (s.kills >= s.def.requiredKills) {
        s.state = KillstreakState.READY;
        cmds.push(["killstreak.ready", i]);
      }
    });
    if (changed) cmds.push(["killstreak.render", slotViews()]);
    stats.find((s) => s.combatantId === LOCAL)!.kills++;
    stats.find((s) => `#c${s.combatantId}` === key)!.deaths++;
    leaderboardDirty = true;
  };
  /** A shot of the equipped weapon (ammo, crosshair kick). */
  const shoot = (cmds: HudCommand[]): void => {
    if (primary === "paintball") paintball = Math.max(0, paintball - 1);
    else if (primary === "popcorn") {
      popcorn = Math.max(0, popcorn - 1);
      popcornSerial++;
    } else if (primary === "famas") famas = Math.max(0, famas - 1);
    else Object.assign(frisbee, { deck: false, hand: true, cage: Math.max(0, frisbee.cage - 1), serial: frisbee.serial + 1, recock: 10 });
    cmds.push(["crosshair.fire", primary === "popcorn" ? "heavy" : primary === "frisbee" ? "medium" : "light"]);
  };

  /** One game frame: the events, then the per-frame HUD block (Game's order). */
  const frame = (events?: (cmds: HudCommand[]) => void): HudCommand[] => {
    const cmds: HudCommand[] = [];
    if (leaderboardDirty) {
      leaderboardDirty = false;
      cmds.push(["leaderboard.refresh", sorted()]);
    }
    events?.(cmds);
    if (combo.active) {
      combo.left -= DT;
      if (combo.left <= 0) combo = { active: false, count: 0, left: 0 };
    }
    if (frameNo === medalExitAt) cmds.push(["medal.exit"]);
    if (frameNo === medalHideAt) cmds.push(["medal.hide"]);
    cmds.push(["crosshair.aim", false]);
    if (frameNo - lastHit <= NUMBER_WINDOW) {
      const targets = [...followed]
        .filter(([, last]) => frameNo - last <= NUMBER_WINDOW)
        .map(([key]) => {
          const e = eye(key);
          return { key, alive: alive.get(key) ?? false, eye: [e.x, e.y, e.z] as [number, number, number] };
        });
      cmds.push(["damage.follow", targets]);
      cmds.push(["damage.update", DT, snapshot]);
    }
    cmds.push(["crosshair.flush"]);
    cmds.push(["hitmarker.flush"]);
    if (dashCd > 0) dashCd = Math.max(0, dashCd - DT);
    if (dashing > 0) dashing--;
    cmds.push(["dash.update", DT, { dashCooldownRemaining: dashCd, isDashing: dashing > 0 }]);
    cmds.push(["spear.visible", spearOn]);
    cmds.push(["spear.update", { rushCooldownRemaining: 0, isRushing: false }]);
    if (popcornReload > 0 && --popcornReload === 0) popcorn = PopcornShotgunConfig.shots;
    if (paintballReload > 0 && --paintballReload === 0) paintball = PaintballRifleConfig.capacity;
    if (famasReload > 0 && --famasReload === 0) famas = WaterFamasConfig.capacity;
    if (frisbee.recock > 0 && --frisbee.recock === 0) Object.assign(frisbee, { deck: true, hand: false });
    cmds.push(["plate.visible", "popcorn", primary === "popcorn"]);
    cmds.push(["plate.popcorn", { ammo: popcorn, isReloading: popcornReload > 0, shotSerial: popcornSerial }]);
    cmds.push(["plate.visible", "paintball", primary === "paintball"]);
    cmds.push(["plate.paintball", { ammo: paintball, isReloading: paintballReload > 0 }]);
    cmds.push(["plate.visible", "famas", primary === "famas"]);
    cmds.push(["plate.famas", { ammo: famas, isReloading: famasReload > 0 }]);
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
    frameNo++;
    return cmds;
  };
  const run = (n: number, at: Map<number, (cmds: HudCommand[]) => void> = new Map()): HudCommand[][] => {
    const list: HudCommand[][] = [];
    for (let i = 0; i < n; i++) list.push(frame(at.get(i)));
    return list;
  };

  // ---- Match start (as Game: HUD shown, name, killstreaks, leaderboard) ----
  const start = [
    frame((c) => {
      c.push(["doc.class", "hud", "menu-active", false]);
      c.push(["combat.name", "Sneus"]);
      c.push(["killstreak.render", slotViews()]);
      c.push(["leaderboard.refresh", sorted()]);
    }),
    // 11 s: the controls hint leaves 9 s after the HUD shows (hud.css).
    ...run(659),
  ];

  const builders: Record<string, () => HudCommand[][]> = {
    rest: () => run(REST),
    // 1.5 s of fire at 600 rpm on a strafing bot (every ball hits), then 1 s.
    fire: () => {
      const at = new Map<number, (cmds: HudCommand[]) => void>();
      for (let f = 0; f < 90; f += 6) {
        at.set(f, (c) => {
          shoot(c);
          hit(c, "#c3", 18, HitZone.BODY, false, 0.09);
        });
      }
      return run(150, at);
    },
    // A headshot kill (medal, sticker, combo, leaderboard, killstreak, number).
    kill: () =>
      run(
        90,
        new Map([
          [
            0,
            (c: HudCommand[]) => {
              shoot(c);
              hit(c, "#c3", 40, HitZone.HEAD, true, null);
            },
          ],
        ]),
      ),
    // The kill's tail: medal exit, combo rope burning down, number fading.
    afterKill: () => run(150),
    // Three bites from two directions, then the vignettes / ghost bar settle.
    hurt: () =>
      run(
        150,
        new Map([0, 15, 30].map((f, i): [number, (c: HudCommand[]) => void] => [
          f,
          (c) => {
            hp -= 12;
            c.push(["combat.damage", 12, i === 1 ? -2.4 : 1.1]);
          },
        ])),
      ),
    // The magazine's reload (RECHARGE ribbon, spinning ring, pips back), then 1 s.
    reload: () => {
      const at = new Map<number, (c: HudCommand[]) => void>([
        [
          0,
          () => {
            if (primary === "paintball") paintballReload = 72;
            else if (primary === "popcorn") popcornReload = 72;
            else if (primary === "famas") famasReload = 72;
            else frisbee.recock = 72;
          },
        ],
      ]);
      return run(140, at);
    },
    // Combo over, everything settled: rest again (HP 64, ammo full).
    late: () => run(REST),
  };
  /** Played before a phase's measured window. */
  const leads: Record<string, () => HudCommand[][]> = {
    // Wait out the combo (5 s after the kill) and its drop.
    late: () => run(Math.max(0, Math.ceil(combo.left / DT)) + 60),
  };
  // ---- States: a setup (lead, not measured: the transition and its one-shot
  // animations), then the state held (measured). ----
  const HOLD = 180;
  const set = (fn: () => void, settle = 45) => (): HudCommand[][] => {
    fn();
    return run(settle);
  };
  const stateLeads: Record<string, () => HudCommand[][]> = {
    idle: set(() => (primary = null), 60),
    dashRefill: set(() => {
      dashCd = 2.6;
      dashing = 12;
    }, 20),
    worried: set(() => (hp = 55)),
    panic: set(() => (hp = 22)),
    dead: set(() => {
      hp = 0;
      playerAlive = false;
      deathTimer = 3.5;
    }, 50),
    idleAgain: set(() => {
      hp = 100;
      playerAlive = true;
    }, 60),
    // As in the game (PlayerMovement): KNOCKED DOWN for the forced-down window,
    // then "PRESS SPACE TO GET UP" (its endless bob) until the player stands.
    knockdown: set(() => {
      down = true;
    }, 40),
    getUp: set(() => {
      canGetUp = true;
    }, 40),
    spearReady: set(() => {
      down = canGetUp = false;
      spearOn = true;
    }),
    hurry: set(() => {
      spearOn = false;
      clock = 25.5;
    }),
    // A kill, then (lead) its medal / sticker gone: the combo tag and its rope remain.
    comboRope: () => [
      frame((c) => {
        primary = null;
        hit(c, "#c4", 60, HitZone.BODY, true, null);
      }),
      ...run(110),
    ],
    paintballRest: set(() => (primary = "paintball"), 60),
    paintballLow: set(() => (paintball = 6)),
    paintballReload: set(() => (paintballReload = 9999)),
    popcornRest: set(() => {
      paintballReload = 1;
      primary = "popcorn";
    }, 60),
    famasRest: set(() => (primary = "famas"), 60),
    famasLow: set(() => (famas = 2)),
    famasReload: set(() => (famasReload = 9999)),
    frisbeeRest: set(() => {
      famasReload = 1;
      primary = "frisbee";
    }, 60),
  };
  const phases: BenchPhase[] = [];
  for (const name of opt.phases ?? (states ? ALL_STATES : ALL_PHASES)) {
    if (states) {
      const lead = stateLeads[name];
      if (!lead) throw new Error(`unknown state ${name}`);
      phases.push({ name, lead: lead(), frames: run(name === "comboRope" ? 120 : HOLD) });
      continue;
    }
    const b = builders[name];
    if (!b) throw new Error(`unknown phase ${name}`);
    const lead = leads[name]?.() ?? [];
    phases.push({ name, lead, frames: b() });
  }

  return {
    init: {
      popcornShots: PopcornShotgunConfig.shots,
      paintballCapacity: PaintballRifleConfig.capacity,
      famasCapacity: WaterFamasConfig.capacity,
      frisbeeCageCapacity: FrisbeeLauncherConfig.cageCapacity,
      interact: false,
      crosshair: { ...DEFAULT_CROSSHAIR },
    },
    start,
    phases,
    frameMs: 1000 / 60,
  };
}
