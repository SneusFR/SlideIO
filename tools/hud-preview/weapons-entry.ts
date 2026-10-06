import { advance, freeze } from "./virtual-time";
import { PaintballRifleHUD } from "../../src/ui/PaintballRifleHUD";
import { PopcornShotgunHUD } from "../../src/ui/PopcornShotgunHUD";
import { WaterFamasHUD } from "../../src/ui/WaterFamasHUD";
import { FrisbeeLauncherHUD } from "../../src/ui/FrisbeeLauncherHUD";
import { RevolverHUD } from "../../src/ui/RevolverHUD";
import { BassBlasterHUD } from "../../src/ui/BassBlasterHUD";
import { PoisonHUD } from "../../src/ui/PoisonHUD";
import { WeaponHUD } from "../../src/ui/WeaponHUD";
import { PaintballRifleConfig } from "../../shared/combat/PaintballRifleRules";
import { PopcornShotgunConfig } from "../../shared/combat/PopcornShotgunRules";
import { WaterFamasConfig } from "../../shared/combat/WaterFamasRules";
import { FrisbeeLauncherConfig } from "../../shared/combat/FrisbeeLauncherRules";

/**
 * Weapon-HUD preview entry: the REAL HUD classes (hudKit, PaintLayer, the
 * Three.js paint renderer…) driven by fake weapon objects, exactly like
 * Game.ts drives them every frame. Exposed as window.hud for the CDP driver.
 */
type Fake = Record<string, number | boolean>;
const state: Record<string, Fake> = {
  paintball: { ammo: PaintballRifleConfig.capacity, isReloading: false },
  popcorn: { ammo: PopcornShotgunConfig.shots, isReloading: false },
  water: { ammo: WaterFamasConfig.capacity, isReloading: false },
  frisbee: { deckLoaded: true, cageCount: FrisbeeLauncherConfig.cageCapacity, discInHand: false, isReloading: false, shotSerial: 0 },
  revolver: { currentAmmo: 6, isMaterializing: false },
  bass: { currentAmmo: 30, maxAmmo: 30, isReloading: false, reloadProgress: 0 },
  poison: { fillFraction: 1, isReloading: false },
  heat: { ratio: 0.2, overheated: false, cooldownRemaining: 0 },
};

const huds = {
  paintball: new PaintballRifleHUD(PaintballRifleConfig.capacity),
  popcorn: new PopcornShotgunHUD(PopcornShotgunConfig.shots),
  water: new WaterFamasHUD(WaterFamasConfig.capacity),
  frisbee: new FrisbeeLauncherHUD(FrisbeeLauncherConfig.cageCapacity),
  revolver: new RevolverHUD(),
  bass: new BassBlasterHUD(),
  poison: new PoisonHUD(),
  heat: new WeaponHUD(),
};
type Id = keyof typeof huds;

let current: Id = "paintball";

function push(dt = 1 / 60): void {
  const s = state[current];
  const h = huds[current] as unknown as { update: (...a: unknown[]) => void };
  if (current === "heat") h.update(dt, { ratio: s.ratio, overheated: s.overheated, cooldownRemaining: s.cooldownRemaining }, false);
  else h.update(s);
}

function show(id: Id): void {
  for (const k of Object.keys(huds) as Id[]) (huds[k] as unknown as { setVisible: (v: boolean) => void }).setVisible(k === id);
  current = id;
  push();
  freeze();
}

(window as unknown as { hud: unknown }).hud = {
  show,
  ids: Object.keys(huds),
  set(patch: Fake): void {
    Object.assign(state[current], patch);
    push();
    freeze();
  },
  /** Advance by `ms` in 1/60 s slices, feeding the HUD every slice like the game loop. */
  step(ms: number): void {
    let left = ms;
    while (left > 1e-6) {
      const d = Math.min(left, 1000 / 60);
      push(d / 1000);
      advance(d);
      left -= d;
    }
  },
  /** Plate box (CSS px) for screenshot clips. */
  box(): { x: number; y: number; w: number; h: number } {
    const r = (document.getElementById("weapon-slot") as HTMLElement).getBoundingClientRect();
    return { x: r.x, y: r.y, w: r.width, h: r.height };
  },
  state,
  /** Frisbee 3D mechanism slow motion (1 = real time). */
  slow(f: number): void {
    huds.frisbee.mechanism.timeScale = f;
  },
};
show("paintball");
